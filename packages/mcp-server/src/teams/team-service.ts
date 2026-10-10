/**
 * @input  依赖：TeamStore（团队/Worker 行）、TeamGit（检查点/worktree/合并）、委派端口（Lead 委派启动与 Worker 子委派、
 *         终态订阅、Lead HEAD 回写）、Agent 端口（执行者身份与默认审核者）、Lead MCP 配置与「团队模式」提示词
 * @output 导出：TeamService（startTeam / dispatchWorker / listWorkers / waitWorker / interruptWorker / mergeWorker /
 *         archiveWorker / focusWorker / endTeam / getTeam / initialize）、TaskTeamView / TaskWorkerView / TeamServiceDeps
 * @pos    Worker 团队用例层：REST 路由与（经回环 HTTP 的）团队 MCP 工具的唯一写入口；不直接驱动 Agent 运行时，
 *         Lead 与 Worker 的执行都交给 WorkItemDelegationManager
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 并发：同一团队的派发/合并/中断/归档/结束经 promise 链串行，避免检查点、worktree 分叉与合并互相穿插；
 *         Lead 执行段结束后的交付提交也经 withLeadWorkspace 钩子排进同一条链（否则合并刚移动 HEAD、
 *         尚未回写仓储时，交付提交会按旧 HEAD reset 掉合并提交）。
 * 生命周期：Lead 委派进入终态（approved/failed/cancelled）即自动结束团队并中断仍在运行的 Worker；
 * 服务重启时 initialize 对账 Lead 已不活跃的团队。
 * 已知竞争：检查点/合并与 Lead 自身写文件并发时，Lead 正在写的文件可能被收进检查点（文档已列为已知风险）。
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { CouncilConflictError, CouncilNotFoundError, CouncilValidationError } from "../errors.js";
import type {
  DelegationTeamHooks,
  StartTeamWorkerInput,
  StartWorkItemDelegationInput,
} from "../orchestration/work-item-delegation-manager.js";
import type {
  DelegationExecutionPermission,
  WorkItemDelegation,
} from "../orchestration/work-item-delegation-store.js";
import { buildLeadMcpServers, type CouncilMcpEntry } from "./lead-mcp-config.js";
import { teamLeadInstructions } from "./team-lead-brief.js";
import type { TeamGit } from "./team-git.js";
import {
  deriveWorkerStatus,
  type TaskTeamRecord,
  type TaskWorkerRecord,
  type TaskWorkerStatus,
  type TeamStore,
} from "./team-store.js";

const ACTIVE_DELEGATION = new Set(["queued", "executing", "reviewing", "changes_requested"]);
const SETTLED_WORKER = new Set<TaskWorkerStatus>(["done", "error", "archived"]);
export const MAX_WAIT_MS = 600_000;
const WAIT_POLL_MS = 500;
const SYSTEM_AGENT_REQUIRED = "团队模式需要系统 Claude/Codex Agent 作为执行者";

/** 嵌在团队/Worker 视图里的委派摘要；Web 与 Lead 工具据此展示进度与失败原因。 */
export interface DelegationSummary {
  status: WorkItemDelegation["status"];
  execution?: WorkItemDelegation["execution"];
  failureCode?: string;
  headCommit?: string;
  branchName?: string;
}

export interface TaskWorkerView extends TaskWorkerRecord {
  branchName?: string;
  delegation?: DelegationSummary;
}

export interface TaskTeamView extends TaskTeamRecord {
  workers: TaskWorkerView[];
  delegation?: DelegationSummary;
}

export interface StartTeamInput {
  workItemId: string;
  expectedVersion: number;
  executorAgentId: string;
  supervisorAgentId?: string;
  requestedPermission: DelegationExecutionPermission;
  acceptanceCriteria?: string;
  completionPolicy?: "review" | "human";
  createInitialBaseline?: boolean;
  maxParallel?: number;
}

export interface DispatchWorkerInput {
  label: string;
  role?: string;
  brief: string;
  scopePaths?: readonly string[];
  requestedPermission?: DelegationExecutionPermission;
}

export interface TeamServiceDeps {
  store: TeamStore;
  git: TeamGit;
  delegations: {
    start(input: StartWorkItemDelegationInput): Promise<WorkItemDelegation>;
    get(id: string): WorkItemDelegation | undefined;
    cancel(id: string): WorkItemDelegation;
    onSettled(listener: (delegation: WorkItemDelegation) => void | Promise<void>): () => void;
    startTeamWorker(input: StartTeamWorkerInput): WorkItemDelegation;
    setTeamLeadHead(id: string, headCommit: string): void;
    teamLeadWorkspace(id: string): { root: string; baseCommit: string; headCommit: string } | undefined;
    projectPathOf(workItemId: string): string;
    setTeamHooks(hooks: DelegationTeamHooks): void;
  };
  agents: {
    /** 执行者 Actor 与 Provider 协议；Agent 不存在或已删除时返回 undefined。 */
    executorIdentity(agentId: string): { actorId: string; protocol: string } | undefined;
    /** 省略审核者时的默认值（启用的 Claude CLI Agent，优先 @claude，且不同于执行者）。 */
    defaultSupervisor(executorAgentId: string): string;
  };
  config: {
    /** COUNCIL_WORKER_MAX_PARALLEL：团队未显式指定时的并行上限，也是显式指定的最大值。 */
    maxParallel: number;
    worktreeRoot: string;
    leadMcp: { entry?: CouncilMcpEntry; baseEnv: Readonly<Record<string, string>>; httpHost: string; httpPort: number };
  };
}

function summary(delegation: WorkItemDelegation | undefined): DelegationSummary | undefined {
  if (!delegation) return undefined;
  return {
    status: delegation.status,
    ...(delegation.execution ? { execution: delegation.execution } : {}),
    ...(delegation.failureCode ? { failureCode: delegation.failureCode } : {}),
    ...(delegation.headCommit ? { headCommit: delegation.headCommit } : {}),
    ...(delegation.branchName ? { branchName: delegation.branchName } : {}),
  };
}

const now = (): string => new Date().toISOString();

export class TeamService {
  readonly #locks = new Map<string, Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: TeamServiceDeps) {
    deps.delegations.setTeamHooks({
      leadRuntime: (id) => this.#leadRuntime(id),
      // 非团队 Lead 直接执行；团队 Lead 的交付提交排进团队锁，与检查点/合并互斥。
      withLeadWorkspace: (id, task) => {
        const team = this.deps.store.activeForLead(id);
        return team ? this.#serial(team.id, task) : task();
      },
    });
  }

  // ---- 生命周期 ----

  initialize(): void {
    this.#unsubscribe ??= this.deps.delegations.onSettled((delegation) => this.#onSettled(delegation));
    for (const team of this.deps.store.listActiveTeams()) {
      const lead = this.deps.delegations.get(team.leadDelegationId);
      if (!lead || !ACTIVE_DELEGATION.has(lead.status)) this.#endNow(team);
      else this.#persistWorkerStatuses(team.id);
    }
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.deps.store.close();
  }

  // ---- 读 ----

  getTeam(workItemId: string): TaskTeamView {
    const team = this.deps.store.latestForWorkItem(workItemId);
    if (!team) throw new CouncilNotFoundError("这条任务还没有 Worker 团队。");
    return this.#teamView(team);
  }

  listWorkers(workItemId: string): TaskWorkerView[] {
    return this.getTeam(workItemId).workers;
  }

  async waitWorker(workItemId: string, workerId: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskWorkerView> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), MAX_WAIT_MS);
    for (;;) {
      const view = this.#workerView(this.#workerOf(workItemId, workerId).worker);
      if (SETTLED_WORKER.has(view.status) || Date.now() >= deadline || signal?.aborted) return view;
      await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, Math.max(deadline - Date.now(), 1))));
    }
  }

  // ---- 写 ----

  async startTeam(input: StartTeamInput): Promise<{ team: TaskTeamView; leadDelegation: WorkItemDelegation }> {
    const { entry } = this.deps.config.leadMcp;
    if (!entry) {
      throw new CouncilConflictError("当前运行方式找不到 Council MCP 入口（桌面单文件包暂不支持团队模式），请用 npm 启动的服务组队。");
    }
    const identity = this.deps.agents.executorIdentity(input.executorAgentId);
    if (!identity) throw new CouncilNotFoundError("执行 Agent 不存在。");
    const alias = this.deps.store.aliasOfActor(identity.actorId);
    if (!alias || (identity.protocol !== "claude-cli" && identity.protocol !== "codex-cli")) {
      throw new CouncilConflictError(`${SYSTEM_AGENT_REQUIRED}。`);
    }
    if (this.deps.store.activeForWorkItem(input.workItemId)) {
      throw new CouncilConflictError("这条任务已有进行中的 Worker 团队。");
    }
    const ceiling = this.deps.config.maxParallel;
    const maxParallel = input.maxParallel ?? ceiling;
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > ceiling) {
      throw new CouncilValidationError(`maxParallel 必须是 1 到 ${String(ceiling)} 之间的整数。`);
    }
    const leadDelegation = await this.deps.delegations.start({
      workItemId: input.workItemId,
      expectedVersion: input.expectedVersion,
      executorAgentId: input.executorAgentId,
      supervisorAgentId: input.supervisorAgentId ?? this.#defaultSupervisor(input.executorAgentId),
      requestedPermission: input.requestedPermission,
      kind: "code",
      inputAssetIds: [],
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(input.completionPolicy ? { completionPolicy: input.completionPolicy } : {}),
      ...(input.createInitialBaseline ? { createInitialBaseline: true } : {}),
    });
    // Lead 执行要等 worktree 建好（子进程 I/O）才会读取 leadRuntime，团队行在此之前同步写入。
    let team: TaskTeamRecord;
    try {
      team = this.deps.store.createTeam({
        id: `team-${randomUUID()}`, workItemId: input.workItemId, leadDelegationId: leadDelegation.id, maxParallel, now: now(),
      });
    } catch (error) {
      this.deps.delegations.cancel(leadDelegation.id);
      throw error;
    }
    return { team: this.#teamView(team), leadDelegation };
  }

  async dispatchWorker(workItemId: string, input: DispatchWorkerInput): Promise<TaskWorkerView> {
    const label = input.label.trim();
    if (!label) throw new CouncilValidationError("Worker label 不能为空。");
    const team = this.#activeTeam(workItemId);
    return await this.#serial(team.id, async () => {
      const lead = this.deps.delegations.get(team.leadDelegationId)!;
      const running = this.deps.store.listWorkers(team.id)
        .filter((worker) => {
          const status = deriveWorkerStatus(worker.status, this.deps.delegations.get(worker.delegationId));
          return status === "idle" || status === "running";
        }).length;
      if (running >= team.maxParallel) {
        throw new CouncilConflictError(`同时运行的 Worker 已达上限 ${String(team.maxParallel)}，请先等待、中断或合并已有 Worker。`);
      }
      const head = await this.#checkpointLead(team);
      const workspace = this.deps.delegations.teamLeadWorkspace(team.leadDelegationId)!;
      const suffix = randomUUID();
      const branchName = `codex/council-worker-${suffix.replace(/-/gu, "").slice(0, 12)}`;
      const worktreePath = path.join(this.deps.config.worktreeRoot, `worker-${suffix}`);
      const relative = await this.deps.git.relativeProjectPath(await realpath(this.deps.delegations.projectPathOf(workItemId)));
      await this.deps.git.addWorktree(workspace.root, branchName, worktreePath, head);
      try {
        const delegation = this.deps.delegations.startTeamWorker({
          leadDelegationId: lead.id,
          label,
          brief: input.brief,
          scopePaths: input.scopePaths ?? [],
          requestedPermission: input.requestedPermission ?? lead.permissionProfile,
          workspace: {
            root: worktreePath,
            cwd: relative ? path.join(worktreePath, relative) : worktreePath,
            baseCommit: head,
            branchName,
          },
        });
        const worker = this.deps.store.createWorker({
          id: `worker-${suffix}`, teamId: team.id, delegationId: delegation.id, label,
          ...(input.role?.trim() ? { role: input.role.trim() } : {}),
          scopePaths: input.scopePaths ?? [], now: now(),
        });
        return this.#workerView(worker);
      } catch (error) {
        await this.deps.git.removeWorktree(workspace.root, branchName, worktreePath);
        throw error;
      }
    });
  }

  async interruptWorker(workItemId: string, workerId: string): Promise<TaskWorkerView> {
    const { team, worker } = this.#workerOf(workItemId, workerId);
    return await this.#serial(team.id, () => {
      const delegation = this.deps.delegations.get(worker.delegationId);
      if (delegation && ACTIVE_DELEGATION.has(delegation.status)) this.deps.delegations.cancel(worker.delegationId);
      const status = worker.status === "archived" ? "archived" : "error";
      return Promise.resolve(this.#workerView(this.deps.store.updateWorker(worker.id, { status, now: now() })));
    });
  }

  async mergeWorker(workItemId: string, workerId: string): Promise<TaskWorkerView> {
    const { team, worker } = this.#workerOf(workItemId, workerId);
    if (team.status !== "active") throw new CouncilConflictError("团队已结束，不能再合并 Worker。");
    return await this.#serial(team.id, async () => {
      const current = this.deps.store.getWorker(worker.id)!;
      const delegation = this.deps.delegations.get(current.delegationId);
      if (current.mergedCommit) throw new CouncilConflictError("这个 Worker 已经合并过。");
      if (deriveWorkerStatus(current.status, delegation) !== "done" || !delegation?.branchName) {
        throw new CouncilConflictError("只能合并已完成（done）的 Worker。");
      }
      const workspace = this.#leadWorkspace(team);
      await this.#checkpointLead(team);
      const merged = await this.deps.git.merge(workspace.root, delegation.branchName, current.label);
      this.deps.delegations.setTeamLeadHead(team.leadDelegationId, merged);
      return this.#workerView(this.deps.store.updateWorker(worker.id, { status: "done", mergedCommit: merged, now: now() }));
    });
  }

  async archiveWorker(workItemId: string, workerId: string): Promise<TaskWorkerView> {
    const { team, worker } = this.#workerOf(workItemId, workerId);
    return await this.#serial(team.id, () => {
      const delegation = this.deps.delegations.get(worker.delegationId);
      if (delegation && ACTIVE_DELEGATION.has(delegation.status)) this.deps.delegations.cancel(worker.delegationId);
      return Promise.resolve(this.#workerView(this.deps.store.updateWorker(worker.id, { status: "archived", now: now() })));
    });
  }

  focusWorker(workItemId: string, workerId: string, focused: boolean): void {
    const { team, worker } = this.#workerOf(workItemId, workerId);
    this.deps.store.setFocus(team.id, worker.id, focused, now());
  }

  async endTeam(workItemId: string): Promise<TaskTeamView> {
    const team = this.#activeTeam(workItemId);
    return await this.#serial(team.id, () => Promise.resolve(this.#teamView(this.#endNow(team))));
  }

  // ---- 内部 ----

  #defaultSupervisor(executorAgentId: string): string {
    try {
      return this.deps.agents.defaultSupervisor(executorAgentId);
    } catch {
      throw new CouncilValidationError("找不到默认审核 Agent（需要一个启用的 Claude CLI Agent），请显式指定 supervisorAgentId。");
    }
  }

  #leadRuntime(delegationId: string): ReturnType<DelegationTeamHooks["leadRuntime"]> {
    const team = this.deps.store.activeForLead(delegationId);
    const lead = team ? this.deps.delegations.get(delegationId) : undefined;
    const { entry, baseEnv, httpHost, httpPort } = this.deps.config.leadMcp;
    if (!team || !lead || !entry) return undefined;
    const identity = this.deps.agents.executorIdentity(lead.executorAgentId);
    const alias = identity ? this.deps.store.aliasOfActor(identity.actorId) : undefined;
    if (!alias) throw new CouncilConflictError(`${SYSTEM_AGENT_REQUIRED}。`);
    return {
      mcpServers: buildLeadMcpServers({ entry, baseEnv, callerAlias: alias, leadDelegationId: delegationId, httpHost, httpPort }),
      instructions: teamLeadInstructions(team.maxParallel),
    };
  }

  #onSettled(delegation: WorkItemDelegation): void {
    const led = this.deps.store.activeForLead(delegation.id);
    if (led) {
      this.#endNow(led);
      return;
    }
    const worker = this.deps.store.workerByDelegation(delegation.id);
    if (worker) {
      this.deps.store.updateWorker(worker.id, { status: deriveWorkerStatus(worker.status, delegation), now: now() });
    }
  }

  /** 结束团队并中断仍在运行的 Worker；可重入（已结束的团队只刷新 Worker 状态）。 */
  #endNow(team: TaskTeamRecord): TaskTeamRecord {
    const ended = this.deps.store.endTeam(team.id, now()) ?? team;
    for (const worker of this.deps.store.listWorkers(team.id)) {
      const delegation = this.deps.delegations.get(worker.delegationId);
      if (delegation && ACTIVE_DELEGATION.has(delegation.status)) this.deps.delegations.cancel(worker.delegationId);
    }
    this.#persistWorkerStatuses(team.id);
    return ended;
  }

  #persistWorkerStatuses(teamId: string): void {
    for (const worker of this.deps.store.listWorkers(teamId)) {
      const status = deriveWorkerStatus(worker.status, this.deps.delegations.get(worker.delegationId));
      this.deps.store.updateWorker(worker.id, { status, now: now() });
    }
  }

  #activeTeam(workItemId: string): TaskTeamRecord {
    const team = this.deps.store.activeForWorkItem(workItemId);
    if (!team) throw new CouncilConflictError("这条任务没有进行中的 Worker 团队。");
    return team;
  }

  #workerOf(workItemId: string, workerId: string): { team: TaskTeamRecord; worker: TaskWorkerRecord } {
    const team = this.deps.store.latestForWorkItem(workItemId);
    const worker = this.deps.store.getWorker(workerId);
    if (!team || !worker || worker.teamId !== team.id) throw new CouncilNotFoundError("Worker 不存在。");
    return { team, worker };
  }

  #leadWorkspace(team: TaskTeamRecord): { root: string; headCommit: string } {
    const workspace = this.deps.delegations.teamLeadWorkspace(team.leadDelegationId);
    if (!workspace) throw new CouncilConflictError("Lead 工作区尚未就绪或已结束，请稍后再试。");
    return workspace;
  }

  /** 把 Lead 未提交的改动收成检查点提交并回写 Lead HEAD；Worker 从这里分叉、合并以这里为起点。 */
  async #checkpointLead(team: TaskTeamRecord): Promise<string> {
    const workspace = this.#leadWorkspace(team);
    let head: string;
    try {
      head = await this.deps.git.checkpoint(workspace.root, workspace.headCommit, team.workItemId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误";
      throw new CouncilConflictError(`Lead 工作区检查点提交失败：${reason}`);
    }
    if (head !== workspace.headCommit) this.deps.delegations.setTeamLeadHead(team.leadDelegationId, head);
    return head;
  }

  async #serial<T>(teamId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(teamId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.#locks.set(teamId, tail);
    void tail.then(() => {
      if (this.#locks.get(teamId) === tail) this.#locks.delete(teamId);
    });
    return await run;
  }

  #workerView(worker: TaskWorkerRecord): TaskWorkerView {
    const delegation = this.deps.delegations.get(worker.delegationId);
    return {
      ...worker,
      status: deriveWorkerStatus(worker.status, delegation),
      ...(delegation?.branchName ? { branchName: delegation.branchName } : {}),
      ...(delegation ? { delegation: summary(delegation)! } : {}),
    };
  }

  #teamView(team: TaskTeamRecord): TaskTeamView {
    const lead = summary(this.deps.delegations.get(team.leadDelegationId));
    return {
      ...team,
      workers: this.deps.store.listWorkers(team.id).map((worker) => this.#workerView(worker)),
      ...(lead ? { delegation: lead } : {}),
    };
  }
}
