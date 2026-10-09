/** @input 独立服务配置与进程活动；@output 数据库单实例锁、心跳及子进程归属；@pos 桌面断开不结束任务，异常退出不抢占尚存进程。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

interface WorkerRecord { version: 1; pid: number; children: number[]; heartbeatAt: string; stopped: boolean }
const ownership = new AsyncLocalStorage<ServiceWorker>();

function alive(pid: number): boolean {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** 只在 HTTP Worker 的异步上下文中追踪；CLI/MCP 和隔离验证不共享全局可变注册表。 */
export function ownWorkerChild(pid: number | undefined): () => void {
  const worker = ownership.getStore();
  if (!worker || pid === undefined) return () => {};
  worker.childStarted(pid);
  return () => worker.childSettled(pid);
}

export class ServiceWorker {
  readonly #lock: DatabaseSync;
  readonly #recordPath: string;
  readonly #children = new Set<number>();
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  #lastRequestAt = Date.now();
  #requests = 0;
  #mutations = 0;
  readonly startedAt = new Date().toISOString();
  heartbeatAt = this.startedAt;

  constructor(databasePath: string, heartbeatMs: number, readonly idleTimeoutMs: number) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const canonical = existsSync(databasePath) ? realpathSync(databasePath)
      : path.join(realpathSync(path.dirname(databasePath)), path.basename(databasePath));
    const lockPath = `${canonical}.worker-lock.sqlite`;
    this.#recordPath = `${canonical}.worker.json`;
    // 独立锁库持有写事务，不锁业务数据库；内核在进程退出时释放，不按超时抢活锁。
    this.#lock = new DatabaseSync(lockPath);
    chmodSync(lockPath, 0o600);
    try {
      this.#lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    } catch {
      this.#lock.close();
      throw new Error("服务已有后台执行实例占用当前数据库，请连接原服务，不能重复启动。");
    }
    try {
      if (existsSync(this.#recordPath)) {
        const old = JSON.parse(readFileSync(this.#recordPath, "utf8")) as WorkerRecord;
        if (old.version !== 1 || !Array.isArray(old.children)
          || old.children.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
          throw new Error("服务进程归属记录无效，请检查本地运行状态。");
        }
        if (old.children.some(alive)) {
          throw new Error("服务上次执行的子进程仍未退出，已拒绝重复执行；请先检查并结束原执行进程。");
        }
      }
      this.#save(false);
    } catch (error) {
      this.#lock.close();
      throw error;
    }
    this.#timer = setInterval(() => {
      try { this.#save(false); }
      catch { /* 归属记录无法落盘时停止接新工作，进程退出交由调用方处理。 */ process.kill(process.pid, "SIGTERM"); }
    }, heartbeatMs);
    this.#timer.unref();
  }

  run<T>(fn: () => T): T { return ownership.run(this, fn); }
  requestStarted(mutation = false): () => void {
    this.#requests += 1;
    if (mutation) this.#mutations += 1;
    this.#lastRequestAt = Date.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#requests -= 1;
      if (mutation) this.#mutations -= 1;
      this.#lastRequestAt = Date.now();
    };
  }
  canStop(activeTasks: number): boolean {
    // 停止请求自身占一次；SSE 不妨碍正常关闭，正在恢复/派发的 HTTP 写请求必须结束。
    return activeTasks === 0 && this.#mutations <= 1 && this.#children.size === 0;
  }
  shouldStop(activeTasks: number): boolean {
    if (activeTasks > 0 || this.#requests > 0 || this.#children.size > 0) {
      this.#lastRequestAt = Date.now();
      return false;
    }
    return Date.now() - this.#lastRequestAt >= this.idleTimeoutMs;
  }
  childStarted(pid: number): void {
    this.#children.add(pid);
    this.#save(false);
  }
  childSettled(pid: number): void {
    // 命令退出但后台孙进程仍存活时保留归属，禁止另一个 Worker 抢占。
    if (!alive(pid)) this.#children.delete(pid);
    this.#save(false);
  }
  #save(stopped: boolean): void {
    if (this.#closed) return;
    for (const pid of this.#children) if (!alive(pid)) this.#children.delete(pid);
    this.heartbeatAt = new Date().toISOString();
    const value: WorkerRecord = { version: 1, pid: process.pid, children: [...this.#children], heartbeatAt: this.heartbeatAt, stopped };
    const temporary = `${this.#recordPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, this.#recordPath);
  }
  close(): void {
    if (this.#closed) return;
    clearInterval(this.#timer);
    try { this.#save(true); } finally { this.#closed = true; this.#lock.close(); }
  }
}
