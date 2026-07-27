/**
 * @input  依赖：子进程命令、stdin、环境、定时、输出上限、stdout 观察器与溢出策略
 * @output 导出：有界运行、增量 stdout 观察、首尾截断、长驻进程树终止与 CLI 选项规范化工具
 * @pos    Claude、Codex 与 Kimi 运行时共用的进程生命周期安全基础层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type StopReason = "aborted" | "output" | "timeout";

type ProcessOutcome =
  | { kind: "closed"; result: ProcessResult }
  | { kind: "stopped"; reason: StopReason };

/** 停止与启动失败文案由调用方提供，公共层不出现具体 CLI 名称。 */
export interface BoundedProcessMessages {
  aborted: string;
  timeout: string;
  outputLimit: string;
  commandNotFound: string;
  spawnFailed: string;
}

export interface BoundedProcessOptions {
  command: string;
  args: string[];
  input: string;
  cwd?: string;
  /** 调用方提供完整环境时不再继承 process.env；用于 Git 等需隔离配置的子进程。 */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  killGraceMs: number;
  maxOutputChars: number;
  /**
   * stop：stdout 超限即终止子进程；truncate：持续排空 stdout，只保留首尾窗口。
   * CLI 的 JSONL 事件流可远大于最终正文时使用 truncate，最终正文仍须在上层单独限长。
   */
  stdoutOverflow?: "stop" | "truncate";
  /** truncate 模式下允许排空的总字符上限；防止无穷事件流只靠超时收敛。 */
  maxTotalOutputChars?: number;
  /** 只观察公开传输分片；观察器异常不得中断或改变 CLI 最终结果。 */
  onStdoutChunk?: (chunk: string) => void;
  messages: BoundedProcessMessages;
}

export const IS_POSIX = process.platform !== "win32";
export const MAX_NODE_TIMER_MS = 2_147_483_647;
export const MAX_RUNTIME_OPTION_CHARS = 200;
const PROCESS_POLL_INTERVAL_MS = 10;

function appendTruncatedOutput(current: string, chunk: string, maximum: number): string {
  const combined = current + chunk;
  if (combined.length <= maximum) {
    return combined;
  }
  const separator = "\n";
  const available = Math.max(0, maximum - separator.length);
  const headLength = Math.floor(available / 2);
  const tailLength = available - headLength;
  const tail = tailLength === 0 ? "" : combined.slice(-tailLength);
  return combined.slice(0, headLength) + separator + tail;
}

export function makeAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function stopError(reason: StopReason, messages: BoundedProcessMessages): Error {
  if (reason === "aborted") {
    return makeAbortError(messages.aborted);
  }
  if (reason === "timeout") {
    return new Error(messages.timeout);
  }
  return new Error(messages.outputLimit);
}

/** 校验运行时定时器配置；无效直接抛调用方文案，防止 setTimeout 溢出静默失效。 */
export function assertRuntimeTimers(
  timeoutMs: number,
  killGraceMs: number,
  errorMessage: string,
): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_NODE_TIMER_MS ||
    !Number.isSafeInteger(killGraceMs) ||
    killGraceMs <= 0 ||
    killGraceMs > MAX_NODE_TIMER_MS
  ) {
    throw new Error(errorMessage);
  }
}

/**
 * 规范化传给 CLI 的单值选项（session/model 等）：
 * 拒绝空值、超长、以 "-" 开头的 option-like 值和越界字符，防止参数注入。
 */
export function normalizeCliOption(
  value: string | undefined,
  pattern: RegExp,
  invalidError: () => Error,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_RUNTIME_OPTION_CHARS ||
    normalized.startsWith("-") ||
    !pattern.test(normalized)
  ) {
    throw invalidError();
  }
  return normalized;
}

function trySignalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (IS_POSIX && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 组可能已退出或当前平台拒绝组信号；继续尝试直接子进程且不覆盖原停止原因。
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch {
      // 终止竞态和权限错误不得把取消、超时或输出超限替换为底层系统错误。
    }
  }
}

function isProcessTreeAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (!IS_POSIX || child.pid === undefined) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function destroyStdio(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(PROCESS_POLL_INTERVAL_MS, remaining));
    });
  }
  return true;
}

async function settleWithin(
  completion: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function terminateAndWait(
  child: ChildProcessWithoutNullStreams,
  completion: Promise<unknown>,
  graceMs: number,
): Promise<void> {
  trySignalProcessTree(child, "SIGTERM");
  let [completionSettled, processTreeGone] = await Promise.all([
    settleWithin(completion, graceMs),
    waitUntil(() => !isProcessTreeAlive(child), graceMs),
  ]);

  if (!completionSettled || !processTreeGone) {
    trySignalProcessTree(child, "SIGKILL");
    [completionSettled, processTreeGone] = await Promise.all([
      settleWithin(completion, graceMs),
      waitUntil(() => !isProcessTreeAlive(child), graceMs),
    ]);
  }

  if (!completionSettled) {
    destroyStdio(child);
    completionSettled = await settleWithin(completion, graceMs);
  }

  if (isProcessTreeAlive(child)) {
    trySignalProcessTree(child, "SIGKILL");
    processTreeGone = await waitUntil(() => !isProcessTreeAlive(child), graceMs);
  }

  if (!completionSettled) {
    destroyStdio(child);
  }

  // 无论底层探测最终结果如何，到达这里都必须保留调用方最初的停止原因。
  void processTreeGone;
}

/**
 * 终止由调用方长期持有的进程树并等待退出。调用方必须传入只在 close/error 后
 * settle 的 completion，避免发送信号后立即释放仍存活的 Agent Runtime。
 */
export async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  completion: Promise<unknown>,
  graceMs: number,
): Promise<void> {
  await terminateAndWait(child, completion, graceMs);
}

/**
 * 有界运行一个 CLI 子进程：prompt 走 stdin，stdout 按策略停止或截断、stderr 滚动截断，
 * 支持超时、AbortSignal 与 POSIX 进程组 SIGTERM→SIGKILL 逐级终止。
 */
export async function runBoundedProcess(options: BoundedProcessOptions): Promise<ProcessResult> {
  const { messages } = options;
  if (options.signal?.aborted) {
    throw makeAbortError(messages.aborted);
  }

  const child = spawn(options.command, options.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    detached: IS_POSIX,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stdoutCharsReceived = 0;
  let stderr = "";
  let stop: ((reason: StopReason) => void) | undefined;
  const stopped = new Promise<ProcessOutcome>((resolve) => {
    stop = (reason) => resolve({ kind: "stopped", reason });
  });
  const completion = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(messages.commandNotFound));
        return;
      }
      reject(new Error(messages.spawnFailed));
    });
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
  const closed = completion.then<ProcessOutcome>((result) => ({ kind: "closed", result }));
  const timeout = setTimeout(() => stop?.("timeout"), options.timeoutMs);
  const abortListener = (): void => stop?.("aborted");
  options.signal?.addEventListener("abort", abortListener, { once: true });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    try {
      options.onStdoutChunk?.(chunk);
    } catch {
      // 实时预览属于非关键旁路；解析或消费者异常不能杀死正在执行的 Agent。
    }
    if (options.stdoutOverflow === "truncate") {
      stdoutCharsReceived += chunk.length;
      if (
        options.maxTotalOutputChars !== undefined
        && stdoutCharsReceived > options.maxTotalOutputChars
      ) {
        stop?.("output");
        return;
      }
      stdout = appendTruncatedOutput(stdout, chunk, options.maxOutputChars);
      return;
    }
    if (stdout.length > options.maxOutputChars) {
      return;
    }
    const remaining = options.maxOutputChars - stdout.length;
    stdout += chunk.slice(0, remaining + 1);
    if (chunk.length > remaining) {
      stop?.("output");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > options.maxOutputChars) {
      stderr = stderr.slice(-options.maxOutputChars);
    }
  });
  child.stdin.on("error", () => {
    // 进程提前结束或被取消时，关闭中的 stdin 可能报告 EPIPE；由 close/error 决定结果。
  });
  child.stdin.end(options.input);

  try {
    const outcome = await Promise.race([closed, stopped]);
    if (outcome.kind === "closed") {
      return outcome.result;
    }
    await terminateAndWait(child, completion, options.killGraceMs);
    throw stopError(outcome.reason, messages);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortListener);
  }
}
