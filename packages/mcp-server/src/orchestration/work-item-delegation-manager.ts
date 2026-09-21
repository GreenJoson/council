/**
 * @input  依赖：Model Router 权限/职责、Claude/Codex headless runtime、CouncilDatabase、Git 与委派账本
 * @output 导出：带完成条件的委派、逐文件审核、追加提交、修正草稿与交接恢复、显式权限及优雅关闭
 * @pos    supervisor→executor→review 的隔离 worktree 执行闭环；普通讨论永远不进入本层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 阶段执行、审核材料、Git 交付与交接分属专用模块；跨工作区不复用模型会话
 */

import { collectReviewEvidence, parseDelegationReview, DelegationReviewError, type DelegationReview } from "./delegation-review.js";
import { commitDelegationChanges } from "./delegation-git-delivery.js";
import { createDelegationHandoff, handoffContext } from "./delegation-handoff.js";
import { EXECUTION_CHECKPOINT_INSTRUCTION, executionHandoff, DelegationExecutionCheckpointError } from "./delegation-execution-result.js";
import { delegationFailureCode, validateRecoveryCheckpoint } from "./delegation-recovery.js";
import { FORBIDDEN_STAGED_PATH, SECRET_DIFF_PATTERN, snapshotUncommittedWork } from "./delegation-workspace-snapshot.js";
import { RuntimeAuditStore, redactAuditText } from "./runtime-audit-store.js";
import { runDelegationRuntimeStage, type DelegationRuntimeInput } from "./delegation-runtime-stage.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  canExecute,
  canReview,
  intersectPermissionProfiles,
  isExecutionPermission,
  type AgentPermissionProfile,
} from "../agent-execution-policy.js";
import { ClaudeRuntime } from "../claude-runtime.js";
import { CodexRuntime } from "../codex-runtime.js";
import { MAX_WORK_ITEM_STATUS_NOTE_CHARS } from "../constants.js";
import { CouncilDatabase } from "../database.js";
import {
  CouncilConflictError,
  CouncilNotFoundError,
  CouncilValidationError,
} from "../errors.js";
import { ModelRouterService } from "../model-router-service.js";
import type { AgentDefinition, ProviderProfile } from "../model-router-store.js";
import { normalizeProjectPath } from "../project-path.js";
import {
  runBoundedProcess,
  ProcessOutputLimitError,
  type BoundedProcessMessages,
  type ProcessResult,
} from "../process-utils.js";
import type { CouncilConfig, CouncilHttpConfig, WorkItem } from "../types.js";
import {
  WorkItemDelegationStore,
  type DelegationExecutionPermission,
  type WorkItemDelegation,
} from "./work-item-delegation-store.js";

const GIT_MESSAGES: BoundedProcessMessages = {
  aborted: "Git 操作已取消。",
  timeout: "Git 操作超时。",
  outputLimit: "Git 输出超过安全上限。",
  commandNotFound: "找不到 Git 可执行程序。",
  spawnFailed: "无法启动 Git。",
};

const ACTIVE_STATUSES = new Set(["queued", "executing", "reviewing", "changes_requested"]);

interface RuntimeResult {
  content: string;
  sessionId?: string;
}

export interface StartWorkItemDelegationInput {
  topicId: string;
  workItemId: string;
  expectedVersion: number;
  supervisorAgentId: string;
  executorAgentId: string;
  requestedPermission: DelegationExecutionPermission;
  /** 只有无 HEAD 的全新仓库允许；显式确认后建立经过敏感扫描的初始提交。 */
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  createInitialBaseline?: boolean;
}

export interface StartWorkItemDelegationBatchInput {
  topicId: string;
  workItems: readonly { workItemId: string; expectedVersion: number }[];
  supervisorAgentId: string;
  executorAgentId: string;
  requestedPermission: DelegationExecutionPermission;
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  createInitialBaseline?: boolean;
}

interface PreparedWorkspace {
  root: string;
  cwd: string;
  baseCommit: string;
  branchName: string;
  restoredWork?: boolean;
}

interface DelegationAssignment {
  supervisor: AgentDefinition;
  executor: AgentDefinition;
  permission: DelegationExecutionPermission;
}

interface DelegationManagerConfig {
  databasePath: string;
  sqliteBusyTimeoutMs: number;
  defaultMessageLimit: number;
  maxAttempts: number;
  retryDelayMs: number;
  worktreeRoot: string;
  gitCommand: string;
  gitTimeoutMs: number;
  gitKillGraceMs: number;
  gitMaxOutputChars: number;
  maxContextChars: number;
  executionMaxTurns?: number;
}

function compact(value: string, maximum: number): string {
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function publicFailure(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "任务执行已取消。";
  }
  const message = error instanceof Error ? redactAuditText(error.message) : "任务执行失败。";
  const controlled = [
    "任务", "Agent", "Provider", "Git", "worktree", "项目", "执行", "审核",
    "权限", "改动", "提交", "服务", "实施项", "只有", "当前", "找不到",
    "安全", "批量", "Claude", "Codex", "恢复", "原工作区",
  ];
  return controlled.some((prefix) => message.startsWith(prefix))
    ? compact(message, 500)
    : "任务执行失败，请检查本地日志。";
}

export class WorkItemDelegationManager {
  readonly #audit: RuntimeAuditStore;
  readonly #store: WorkItemDelegationStore;
  readonly #database: CouncilDatabase;
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks = new Map<string, Promise<void>>();
  /** 只允许回写本次派发/认领所得版本，不覆盖执行期间的人工作答。 */
  readonly #workItemVersions = new Map<string, number>();

  constructor(
    private readonly config: DelegationManagerConfig,
    private readonly modelRouter: ModelRouterService,
    private readonly claudeRuntime: ClaudeRuntime,
    private readonly codexRuntime: CodexRuntime,
  ) {
    this.#audit = new RuntimeAuditStore(config.databasePath, config.sqliteBusyTimeoutMs);
    this.#store = new WorkItemDelegationStore(
      config.databasePath,
      config.sqliteBusyTimeoutMs,
    );
    this.#database = new CouncilDatabase(config.databasePath, config.sqliteBusyTimeoutMs);
  }

  static fromConfig(
    httpConfig: CouncilHttpConfig,
    councilConfig: CouncilConfig,
    modelRouter: ModelRouterService,
    claudeRuntime: ClaudeRuntime,
    codexRuntime: CodexRuntime,
  ): WorkItemDelegationManager {
    return new WorkItemDelegationManager({
      databasePath: councilConfig.databasePath,
      sqliteBusyTimeoutMs: councilConfig.sqliteBusyTimeoutMs,
      defaultMessageLimit: councilConfig.defaultMessageLimit,
      maxAttempts: httpConfig.orchestrationDefaultMaxAttempts,
      retryDelayMs: councilConfig.delegationRetryDelayMs,
      worktreeRoot: councilConfig.delegationWorktreeRoot,
      gitCommand: councilConfig.gitCommand,
      gitTimeoutMs: councilConfig.gitDiffTimeoutMs,
      gitKillGraceMs: councilConfig.gitDiffKillGraceMs,
      gitMaxOutputChars: councilConfig.delegationGitMaxOutputChars,
      maxContextChars: councilConfig.maxContextChars,
      executionMaxTurns: councilConfig.claudeExecutionMaxTurns,
    }, modelRouter, claudeRuntime, codexRuntime);
  }

  initialize(): void {
    for (const id of this.#store.markInterrupted(new Date().toISOString())) {
      this.#recordAudit(id, "delegation.interrupted", { summary: "服务重启中断执行；未提交文件需检查后再恢复。" });
    }
  }

  list(topicId: string): WorkItemDelegation[] {
    this.#database.getTopic(topicId);
    return this.#store.list(topicId);
  }

  start(input: StartWorkItemDelegationInput): WorkItemDelegation {
    const detail = this.#database.getTopicDetail(
      input.topicId,
      this.config.defaultMessageLimit,
    );
    const item = detail.workItems.find((candidate) => candidate.id === input.workItemId);
    if (!item) {
      throw new CouncilNotFoundError("实施项不存在。");
    }
    if (item.version !== input.expectedVersion) {
      throw new CouncilConflictError("实施项已被更新，请刷新后重试。");
    }
    if (detail.topic.status === "closed" || item.status === "completed"
      || detail.workItems.some((candidate) => candidate.parentId === item.id)) {
      throw new CouncilConflictError("只能委派未关闭议题中的未完成叶子任务。");
    }
    if (!detail.topic.projectPath) {
      throw new CouncilValidationError("项目尚未绑定本地路径，不能执行代码任务。");
    }
    const { supervisor, executor, permission } = this.#resolveAssignment(input);
    const now = new Date().toISOString();
    let delegation: WorkItemDelegation;
    try {
      delegation = this.#store.create({
        id: `delegation-${randomUUID()}`,
        topicId: input.topicId,
        workItemId: input.workItemId,
        supervisorAgentId: supervisor.id,
        executorAgentId: executor.id,
        permissionProfile: permission,
        completionPolicy: input.completionPolicy ?? "human",
        acceptanceCriteria: this.#acceptanceCriteria(input.acceptanceCriteria, item),
        maxAttempts: this.config.maxAttempts,
        now,
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/iu.test(error.message)) {
        throw new CouncilConflictError("这条实施项已有进行中的 Agent 委派。");
      }
      throw error;
    }
    this.#recordAudit(delegation.id, "delegation.created", { criteria: delegation.acceptanceCriteria, completionPolicy: delegation.completionPolicy });
    const controller = new AbortController();
    this.#controllers.set(delegation.id, controller);
    this.#workItemVersions.set(delegation.id, input.expectedVersion);
    const task = this.#runSingle(
      delegation.id,
      input.createInitialBaseline === true,
      controller.signal,
    )
      .catch(() => undefined)
      .finally(() => {
        this.#controllers.delete(delegation.id);
        this.#tasks.delete(delegation.id);
        this.#workItemVersions.delete(delegation.id);
      });
    this.#tasks.set(delegation.id, task);
    return delegation;
  }

  startBatch(input: StartWorkItemDelegationBatchInput): WorkItemDelegation[] {
    if (input.workItems.length === 0) {
      throw new CouncilValidationError("一键委派至少需要一条实施项。");
    }
    const detail = this.#database.getTopicDetail(
      input.topicId,
      this.config.defaultMessageLimit,
    );
    if (!detail.topic.projectPath) {
      throw new CouncilValidationError("项目尚未绑定本地路径，不能执行代码任务。");
    }
    if (detail.topic.status === "closed") throw new CouncilConflictError("已关闭议题不能委派任务。");
    const requested = new Map(input.workItems.map((item) => [item.workItemId, item]));
    if (requested.size !== input.workItems.length) {
      throw new CouncilValidationError("一键委派不能包含重复实施项。");
    }
    const parentIds = new Set(
      detail.workItems.flatMap((item) => item.parentId ? [item.parentId] : []),
    );
    const selected = input.workItems.map((candidate) => {
      const item = detail.workItems.find((entry) => entry.id === candidate.workItemId);
      if (!item) {
        throw new CouncilNotFoundError("一键委派包含不存在的实施项。");
      }
      if (item.version !== candidate.expectedVersion) {
        throw new CouncilConflictError("实施项已被更新，请刷新后重试。");
      }
      if (parentIds.has(item.id)) {
        throw new CouncilValidationError("一键委派只能执行叶子实施项。");
      }
      if (item.status === "completed") {
        throw new CouncilValidationError("一键委派不能包含已完成实施项。");
      }
      return item;
    });
    const { supervisor, executor, permission } = this.#resolveAssignment(input);
    const now = new Date().toISOString();
    const branchName = `codex/council-batch-${randomUUID()}`;
    let delegations: WorkItemDelegation[];
    try {
      delegations = this.#store.createMany(selected.map((item) => ({
        id: `delegation-${randomUUID()}`,
        topicId: input.topicId,
        workItemId: item.id,
        supervisorAgentId: supervisor.id,
        executorAgentId: executor.id,
        permissionProfile: permission,
        completionPolicy: input.completionPolicy ?? "human",
        acceptanceCriteria: this.#acceptanceCriteria(input.acceptanceCriteria, item),
        maxAttempts: this.config.maxAttempts,
        branchName,
        now,
      })));
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/iu.test(error.message)) {
        throw new CouncilConflictError("一键委派中至少有一条实施项正在执行。");
      }
      throw error;
    }
    const controller = new AbortController();
    for (const delegation of delegations) {
      this.#controllers.set(delegation.id, controller);
      this.#workItemVersions.set(delegation.id, requested.get(delegation.workItemId)!.expectedVersion);
    }
    for (const entry of delegations) this.#recordAudit(entry.id, "delegation.created", { criteria: entry.acceptanceCriteria, completionPolicy: entry.completionPolicy });
    const task = this.#runBatch(
      delegations.map((delegation) => delegation.id),
      input.createInitialBaseline === true,
      controller.signal,
    )
      .catch(() => undefined)
      .finally(() => {
        for (const delegation of delegations) {
          this.#controllers.delete(delegation.id);
          this.#workItemVersions.delete(delegation.id);
        }
        this.#tasks.delete(branchName);
      });
    this.#tasks.set(branchName, task);
    return delegations;
  }

  async resume(id: string, expectedVersion: number, requestedPermission?: WorkItemDelegation["permissionProfile"]): Promise<WorkItemDelegation> {
    const previous = this.#store.getPrivate(id);
    if (!previous) throw new CouncilNotFoundError("任务委派不存在。");
    if (!["failed", "cancelled"].includes(previous.status) || this.#controllers.has(id)) {
      throw new CouncilConflictError("原委派尚未停止，不能恢复。");
    }
    const task = this.#taskContext(previous.topicId, previous.workItemId);
    if (task.item.version !== expectedVersion || task.item.status === "completed") {
      throw new CouncilConflictError("实施项已更新或完成，请刷新后检查。");
    }
    // 旧请求默认沿用原权限；只有显式选择才改变新运行，不改历史授权。
    const desiredPermission = requestedPermission ?? previous.permissionProfile;
    const assignment = this.#resolveAssignment({ ...previous, requestedPermission: desiredPermission });
    if (assignment.permission !== desiredPermission) throw new CouncilConflictError("所选接续权限超过 Agent 当前上限，请检查设置。");
    const signal = new AbortController().signal;
    const checkpoint = await validateRecoveryCheckpoint({ previous, projectPath: task.projectPath,
      worktreeRoot: this.config.worktreeRoot,
      git: async (cwd, args) => (await this.#git(cwd, args, signal)).stdout,
    });
    const snapshot = checkpoint.mode === "workspace" ? await snapshotUncommittedWork({
      root: checkpoint.oldRoot, headCommit: checkpoint.headCommit,
      maxFileChars: this.config.gitMaxOutputChars,
      git: async (cwd, args, env) => (await this.#git(cwd, args, signal, env)).stdout,
    }) : undefined;
    if (this.#taskContext(previous.topicId, previous.workItemId).item.version !== expectedVersion) {
      throw new CouncilConflictError("实施项在恢复检查期间已变化，请刷新后重试。");
    }
    const latest = this.#store.list(previous.topicId).find((entry) => entry.workItemId === previous.workItemId);
    if (latest?.id !== id) throw new CouncilConflictError("已有更新的委派，请从最新记录继续。");
    // 工作区检查会让出执行权，创建运行前重新核对当前权限上限。
    if (this.#resolveAssignment({ ...previous, requestedPermission: desiredPermission }).permission !== desiredPermission) {
      throw new CouncilConflictError("所选接续权限超过 Agent 当前上限，请检查设置。");
    }
    let created: WorkItemDelegation;
    try {
      created = this.#store.create({
        id: `delegation-${randomUUID()}`, topicId: previous.topicId, workItemId: previous.workItemId,
        supervisorAgentId: previous.supervisorAgentId, executorAgentId: previous.executorAgentId,
        permissionProfile: assignment.permission, completionPolicy: previous.completionPolicy,
        acceptanceCriteria: previous.acceptanceCriteria, maxAttempts: this.config.maxAttempts,
        resumedFromId: id, now: new Date().toISOString(),
      });
    } catch { throw new CouncilConflictError("这条实施项已有进行中的 Agent 委派。"); }
    this.#store.update(created.id, { checkpoint: { version: 1,
      ...(previous.checkpoint?.brief ? { brief: previous.checkpoint.brief } : {}),
      handoff: createDelegationHandoff(previous),
    }, ...(previous.summary ? { summary: previous.summary } : {}),
      ...(previous.review ? { review: previous.review } : {}), now: new Date().toISOString() });
    const controller = new AbortController();
    this.#controllers.set(created.id, controller);
    this.#workItemVersions.set(created.id, expectedVersion);
    const run = (async () => {
      const branchName = `codex/council-${created.id.slice(-12)}`;
      const root = path.join(this.config.worktreeRoot, created.id);
      await this.#git(checkpoint.originalRoot, ["worktree", "add", "-b", branchName, root, checkpoint.headCommit], controller.signal);
      this.#store.update(created.id, { baseCommit: checkpoint.baseCommit, ...(previous.headCommit ? { headCommit: checkpoint.headCommit } : {}), branchName, worktreePath: root, now: new Date().toISOString() });
      if (snapshot) {
        // 只写新隔离工作区；保留上一份提交，修正草稿完成验证后才追加交付提交。
        await this.#git(root, ["read-tree", "--reset", "-u", snapshot.tree], controller.signal);
      }
      this.#recordAudit(created.id, "delegation.resumed", { previousId: id, headCommit: checkpoint.headCommit,
        recoveryMode: checkpoint.mode, restoredFiles: snapshot?.fileCount ?? 0, criteria: created.acceptanceCriteria,
        previousPermission: previous.permissionProfile, permission: created.permissionProfile });
      await this.#executeInWorkspace(created.id, {
        root, cwd: path.join(root, checkpoint.relativeProjectPath), baseCommit: checkpoint.baseCommit, branchName,
        ...(snapshot ? { restoredWork: true } : {}),
      }, controller.signal, previous.headCommit ? { headCommit: checkpoint.headCommit, summary: previous.summary ?? "请直接检查保留的提交。" } : undefined);
    })().catch((error: unknown) => this.#recordFailure(created.id, error, true)).finally(() => {
      this.#controllers.delete(created.id); this.#tasks.delete(created.id);
      this.#workItemVersions.delete(created.id);
    });
    this.#tasks.set(created.id, run);
    return created;
  }

  cancel(id: string): WorkItemDelegation {
    const current = this.#store.get(id);
    if (!current) {
      throw new CouncilNotFoundError("任务委派不存在。");
    }
    if (!ACTIVE_STATUSES.has(current.status)) {
      return current;
    }
    this.#controllers.get(id)?.abort();
    this.#recordAudit(id, "delegation.cancelled", { summary: "用户取消了委派。" });
    return this.#store.update(id, {
      status: "cancelled",
      failureCode: "cancelled",
      error: "用户取消了任务委派。",
      now: new Date().toISOString(),
    });
  }

  async shutdown(): Promise<void> {
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    await Promise.allSettled(this.#tasks.values());
  }

  close(): void {
    this.#audit.close();
    this.#database.close();
    this.#store.close();
  }

  #recordAudit(id: string, kind: string, data: Record<string, string | number>): void {
    const delegation = this.#store.get(id);
    if (!delegation) return;
    this.#audit.append({ topicId: delegation.topicId, sourceKind: "delegation", sourceId: id, attempt: delegation.attempt, kind, data });
  }

  #acceptanceCriteria(value: string | undefined, item: WorkItem): string {
    const criteria = (value ?? item.details ?? item.title).trim() || item.title;
    if (criteria.length > 4_000) throw new CouncilValidationError("验收标准不能超过 4000 字。");
    return criteria;
  }

  #requireAgent(id: string, action: string): AgentDefinition {
    const agent = this.modelRouter.getAgent(id);
    if (!agent || agent.deletedAt || !agent.enabled) {
      throw new CouncilValidationError(`${action} Agent 不存在、已停用或已删除。`);
    }
    return agent;
  }

  #requireNativeProvider(agent: AgentDefinition): ProviderProfile {
    const provider = this.modelRouter.getProvider(agent.providerId);
    if (!provider || provider.status !== "active") {
      throw new CouncilValidationError("Agent 对应 Provider 不可用。");
    }
    if (provider.protocol !== "claude-cli" && provider.protocol !== "codex-cli") {
      throw new CouncilValidationError("当前只有 Claude CLI 与 Codex CLI 支持代码委派。");
    }
    return provider;
  }

  #resolveAssignment(input: Pick<
    StartWorkItemDelegationInput,
    "supervisorAgentId" | "executorAgentId" | "requestedPermission"
  >): DelegationAssignment {
    const supervisor = this.#requireAgent(input.supervisorAgentId, "审核");
    const executor = this.#requireAgent(input.executorAgentId, "执行");
    if (supervisor.id === executor.id) {
      throw new CouncilValidationError("执行 Agent 与审核 Agent 必须不同。");
    }
    if (!canReview(supervisor.executionRole)) {
      throw new CouncilValidationError("审核 Agent 没有审核者职责。");
    }
    if (!canExecute(executor.executionRole)) {
      throw new CouncilValidationError("执行 Agent 没有执行者职责。");
    }
    const permission = intersectPermissionProfiles(
      executor.permissionProfile,
      input.requestedPermission,
    );
    if (!isExecutionPermission(permission)) {
      throw new CouncilValidationError("执行 Agent 的权限上限是仅讨论，请先在 Model Router 中授权。");
    }
    this.#requireNativeProvider(supervisor);
    this.#requireNativeProvider(executor);
    return { supervisor, executor, permission };
  }

  async #runtimeGenerate(input: DelegationRuntimeInput): Promise<RuntimeResult> {
    return runDelegationRuntimeStage(input, { claude: this.claudeRuntime, codex: this.codexRuntime,
      store: this.#store, provider: this.#requireNativeProvider(input.agent), maxAttempts: this.config.maxAttempts,
      retryDelayMs: this.config.retryDelayMs, record: (id, kind, data) => this.#recordAudit(id, kind, data),
      failureMessage: publicFailure });
  }

  async #git(
    cwd: string,
    args: string[],
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ): Promise<ProcessResult> {
    const result = await this.#runGit(cwd, args, signal, env);
    if (result.exitCode !== 0) {
      throw new Error("Git 操作失败，请检查项目状态和本地日志。");
    }
    return result;
  }

  async #runGit(
    cwd: string,
    args: string[],
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ): Promise<ProcessResult> {
    return await runBoundedProcess({
      command: this.config.gitCommand,
      args: ["-c", "core.pager=cat", "-c", "diff.external=", ...args],
      input: "",
      cwd,
      ...(env ? { env } : {}),
      signal,
      timeoutMs: this.config.gitTimeoutMs,
      killGraceMs: this.config.gitKillGraceMs,
      maxOutputChars: this.config.gitMaxOutputChars,
      messages: GIT_MESSAGES,
    });
  }

  async #createInitialBaseline(root: string, signal: AbortSignal): Promise<string> {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "council-baseline-"));
    const indexPath = path.join(temporaryDirectory, "index");
    const indexEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: indexPath,
    };
    try {
      await this.#git(root, ["read-tree", "--empty"], signal, indexEnv);
      await this.#git(root, ["add", "--all"], signal, indexEnv);
      const names = (await this.#git(
        root,
        ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "--"],
        signal,
        indexEnv,
      )).stdout.split("\n").filter(Boolean);
      if (names.length === 0) {
        throw new Error("项目没有可建立安全基线的文件。");
      }
      if (names.some((name) => FORBIDDEN_STAGED_PATH.test(name))) {
        throw new Error("安全基线包含凭据或私密配置文件，已停止执行。");
      }
      const stagedDiff = (await this.#git(
        root,
        ["diff", "--cached", "--no-ext-diff", "--unified=0", "--"],
        signal,
        indexEnv,
      )).stdout;
      if (SECRET_DIFF_PATTERN.test(stagedDiff)) {
        throw new Error("安全基线疑似包含凭据，已停止执行。");
      }
      const tree = (await this.#git(root, ["write-tree"], signal, indexEnv)).stdout.trim();
      const headRefResult = await this.#runGit(root, ["symbolic-ref", "-q", "HEAD"], signal);
      const headRef = headRefResult.stdout.trim();
      if (headRefResult.exitCode !== 0 || !headRef.startsWith("refs/heads/")) {
        throw new Error("项目初始分支无效，不能建立安全基线。");
      }
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Council Agent",
        GIT_AUTHOR_EMAIL: "council@localhost",
        GIT_COMMITTER_NAME: "Council Agent",
        GIT_COMMITTER_EMAIL: "council@localhost",
      };
      const commit = (await this.#git(
        root,
        ["commit-tree", tree, "-m", "chore: establish Council baseline"],
        signal,
        commitEnv,
      )).stdout.trim();
      // 初始基线只能认领仍不存在的分支，不能覆盖用户并发创建的第一个提交。
      await this.#git(root, ["update-ref", headRef, commit, "0".repeat(commit.length)], signal);
      // 只同步索引，不改工作文件；这样安全基线失败前后都不会吞掉用户内容。
      await this.#git(root, ["reset", "--mixed", "--quiet", commit], signal);
      return commit;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async #prepareWorktree(
    delegation: WorkItemDelegation,
    projectPath: string,
    createInitialBaseline: boolean,
    signal: AbortSignal,
  ): Promise<PreparedWorkspace> {
    const normalized = await realpath(normalizeProjectPath(projectPath) as string);
    const root = await realpath(
      (await this.#git(normalized, ["rev-parse", "--show-toplevel"], signal)).stdout.trim(),
    );
    if (!path.isAbsolute(root)) {
      throw new Error("Git 项目根目录无效。");
    }
    const relative = path.relative(root, normalized);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("项目路径不在 Git 仓库内。");
    }
    const headResult = await this.#runGit(root, ["rev-parse", "--verify", "HEAD"], signal);
    let baseCommit: string;
    if (headResult.exitCode !== 0) {
      if (!createInitialBaseline) {
        throw new Error("项目尚未建立初始提交；请使用“建立安全基线并委派”。");
      }
      baseCommit = await this.#createInitialBaseline(root, signal);
    } else {
      const status = (await this.#git(root, ["status", "--porcelain=v1"], signal)).stdout.trim();
      if (status) {
        throw new Error("项目工作区存在未提交改动；请先提交或清理后再委派。");
      }
      baseCommit = headResult.stdout.trim();
    }
    const suffix = delegation.id.replace(/^delegation-/u, "").slice(0, 12);
    const branchName = delegation.branchName ?? `codex/council-${suffix}`;
    const worktreePath = path.join(this.config.worktreeRoot, delegation.id);
    await mkdir(this.config.worktreeRoot, { recursive: true, mode: 0o700 });
    await this.#git(root, ["worktree", "add", "-b", branchName, worktreePath, baseCommit], signal);
    this.#store.update(delegation.id, {
      baseCommit,
      branchName,
      worktreePath,
      now: new Date().toISOString(),
    });
    return {
      root: worktreePath,
      cwd: relative ? path.join(worktreePath, relative) : worktreePath,
      baseCommit,
      branchName,
    };
  }

  #taskContext(topicId: string, workItemId: string): { item: WorkItem; context: string; contextFingerprint: string; projectPath: string } {
    const detail = this.#database.getTopicDetail(
      topicId,
      this.config.defaultMessageLimit,
    );
    const item = detail.workItems.find((candidate) => candidate.id === workItemId);
    if (detail.topic.status === "closed") throw new CouncilConflictError("已关闭议题不能继续执行任务。");
    if (!item || !detail.topic.projectPath) {
      throw new Error("任务或项目路径已失效。");
    }
    const accepted = detail.decisions.filter((decision) => decision.status === "accepted");
    const context = [
      `议题：${detail.topic.title}`,
      `当前问题：${detail.topic.question}`,
      detail.topic.constraints.length > 0
        ? `约束：\n${detail.topic.constraints.map((value) => `- ${value}`).join("\n")}`
        : "约束：无额外约束",
      `当前实施项：${item.title}\n${item.details || "无补充说明"}`,
      accepted.length > 0
        ? `已接受决策：\n${accepted.map((decision) => [
            `- ${decision.title}`,
            `  结论：${decision.decision}`,
            `  理由：${decision.rationale}`,
          ].join("\n")).join("\n")}`
        : "已接受决策：无",
    ].join("\n\n");
    return {
      item,
      context: compact(context, this.config.maxContextChars),
      contextFingerprint: createHash("sha256").update(context).digest("hex"),
      projectPath: detail.topic.projectPath,
    };
  }

  async #runSingle(
    id: string,
    createInitialBaseline: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const delegation = this.#store.get(id);
      if (!delegation) throw new Error("任务委派不存在。");
      const task = this.#taskContext(delegation.topicId, delegation.workItemId);
      const workspace = await this.#prepareWorktree(
        delegation,
        task.projectPath,
        createInitialBaseline,
        signal,
      );
      await this.#executeInWorkspace(id, workspace, signal);
    } catch (error) {
      this.#recordFailure(id, error, true);
      throw error;
    }
  }

  async #runBatch(
    ids: readonly string[],
    createInitialBaseline: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const first = ids[0] ? this.#store.get(ids[0]) : undefined;
    if (!first) {
      throw new Error("批量任务委派不存在。");
    }
    let activeId: string | undefined;
    try {
      const firstTask = this.#taskContext(first.topicId, first.workItemId);
      const workspace = await this.#prepareWorktree(
        first,
        firstTask.projectPath,
        createInitialBaseline,
        signal,
      );
      for (const id of ids) {
        activeId = id;
        workspace.baseCommit = await this.#executeInWorkspace(id, workspace, signal);
      }
    } catch (error) {
      const activeIndex = activeId ? ids.indexOf(activeId) : -1;
      for (const [index, id] of ids.entries()) {
        const current = this.#store.get(id);
        if (!current || !ACTIVE_STATUSES.has(current.status)) continue;
        const reason = index > activeIndex && activeIndex >= 0
          ? new Error("批量委派已暂停：前序任务未完成，请修复后重新委派。")
          : error;
        this.#recordFailure(id, reason, id === activeId);
      }
      throw error;
    }
  }

  async #executeInWorkspace(
    id: string,
    workspace: PreparedWorkspace,
    signal: AbortSignal,
    checkpoint?: { headCommit: string; summary: string },
  ): Promise<string> {
    if (signal.aborted) throw Object.assign(new Error("任务执行已取消。"), { name: "AbortError" });
    let delegation = this.#store.get(id);
    if (!delegation) throw new Error("任务委派不存在。");
    const task = this.#taskContext(delegation.topicId, delegation.workItemId);
    const supervisor = this.#requireAgent(delegation.supervisorAgentId, "审核");
    const executor = this.#requireAgent(delegation.executorAgentId, "执行");
    this.#store.update(id, {
      baseCommit: workspace.baseCommit,
      branchName: workspace.branchName,
      worktreePath: workspace.root,
      ...(checkpoint ? { headCommit: checkpoint.headCommit, summary: checkpoint.summary } : {}),
      now: new Date().toISOString(),
    });
    const claimed = this.#database.claimWorkItemAsActor({
      topicId: delegation.topicId,
      workItemId: delegation.workItemId,
      expectedVersion: this.#workItemVersions.get(id) ?? task.item.version,
      statusNote: `${executor.displayName} 正在隔离 worktree 中执行；${supervisor.displayName} 负责审核。`,
      actorId: executor.actorId,
    });
    this.#workItemVersions.set(id, claimed.version);
    delegation = this.#store.update(id, {
      status: "executing",
      now: new Date().toISOString(),
    });
    const fingerprint = createHash("sha256").update(JSON.stringify({
      criteria: delegation.acceptanceCriteria, context: task.contextFingerprint, project: task.projectPath,
      permission: delegation.permissionProfile,
      supervisor: [supervisor.id, supervisor.configRevision, this.#requireNativeProvider(supervisor).configRevision],
      executor: [executor.id, executor.configRevision, this.#requireNativeProvider(executor).configRevision],
    })).digest("hex");
    const privateCheckpoint = this.#store.getPrivate(id)?.checkpoint;
    const continuation = handoffContext(privateCheckpoint?.handoff);
    const savedBrief = privateCheckpoint?.brief;
    const reuseBrief = savedBrief?.fingerprint === fingerprint;
    const briefResponse: RuntimeResult = reuseBrief ? { content: savedBrief.content } : await this.#runtimeGenerate({
      delegationId: id, stage: "brief",
      agent: supervisor,
      cwd: workspace.cwd,
      permissionProfile: "read_only",
      signal,
      prompt: [
        "你是本次代码任务的 supervisor。只讨论当前议题，不读取或总结历史议题。",
        "请给执行 Agent 一份精确、可验证的实施指令：明确范围、必须保留的不变量、测试与验收标准。",
        "不要修改文件，不要运行写操作。",
        ...(workspace.restoredWork ? ["当前隔离工作区已接回上次中断的未提交代码。先检查现有实现与缺口，指示执行者接续完成；草稿不代表已通过验证。"] : []),
        "",
        `验收标准：${delegation.acceptanceCriteria}`,
        task.context,
        ...continuation,
      ].join("\n"),
    });
    const currentCheckpoint = this.#store.getPrivate(id)?.checkpoint;
    this.#store.update(id, { checkpoint: { ...currentCheckpoint, version: 1,
      brief: { content: briefResponse.content, fingerprint } }, now: new Date().toISOString() });
    if (reuseBrief) this.#recordAudit(id, "brief.reused", { summary: "任务范围与 Agent 配置未变，沿用已保存的实施指令。" });
    let supervisorSessionId = briefResponse.sessionId;
    let executorSessionId: string | undefined;
    let review: DelegationReview | undefined;
    let headCommit = checkpoint?.headCommit ?? workspace.baseCommit;
    let executorSummary = checkpoint?.summary ?? "";
    for (let attempt = 1; attempt <= delegation.maxAttempts; attempt += 1) {
      if (signal.aborted) throw Object.assign(new Error("任务执行已取消。"), { name: "AbortError" });
      delegation = this.#store.update(id, {
        status: "executing",
        attempt,
        now: new Date().toISOString(),
      });
      const correction = review?.findings.length
        ? ["", "上轮审核要求修正：", ...review.findings.map((finding) => `- ${finding}`)]
        : [];
      if (!checkpoint || workspace.restoredWork || attempt > 1) {
        const executorResponse = await this.#runtimeGenerate({
          delegationId: id, stage: "execution",
          agent: executor,
          cwd: workspace.cwd,
          ...(executorSessionId ? { sessionId: executorSessionId } : {}),
          permissionProfile: delegation.permissionProfile,
          signal,
          prompt: [
            "你是本次任务的 executor。只处理下面这一个实施项。",
            "在当前隔离 worktree 中直接修改代码并运行必要验证；不要切换仓库，不要访问无关目录。",
            "不要自行 git commit；Council 会扫描敏感内容后统一提交。",
            "不要调用 Council，也不要委派其他 Agent。完成后简要说明改动和测试结果。",
            EXECUTION_CHECKPOINT_INSTRUCTION,
            ...(this.#requireNativeProvider(executor).protocol === "claude-cli" && this.config.executionMaxTurns
              ? [`本次最多 ${this.config.executionMaxTurns} 个模型回合；预留回合用于验证与阶段交接，不要等 CLI 强制中断。`] : []),
            ...(workspace.restoredWork ? ["当前工作区保留了上次未完成的代码，请基于这些改动继续检查、补齐与测试，不要因为存在草稿就假定任务已完成。旧指令如含旧工作区路径，以当前隔离工作区为准。"] : []),
            "",
            "Supervisor 指令：",
            briefResponse.content,
            "",
            "当前实施项原文：",
            `验收标准：${delegation.acceptanceCriteria}`,
            task.context,
            ...continuation,
            ...correction,
          ].join("\n"),
        });
        executorSessionId = executorResponse.sessionId ?? executorSessionId;
        const partial = executionHandoff(executorResponse.content);
        if (partial) {
          this.#store.update(id, { summary: partial, now: new Date().toISOString() });
          this.#recordAudit(id, "execution.checkpoint", { summary: "执行者已保存阶段交接，仍有未完成工作，尚未验收。" });
          throw new DelegationExecutionCheckpointError("execution_checkpoint", "执行已按阶段保存交接，仍有未完成工作；可检查后接续。");
        }
        executorSummary = compact(executorResponse.content, 8_000);
        const beforeCommit = this.#store.getPrivate(id)?.checkpoint;
        const commitTime = new Date().toISOString();
        this.#store.update(id, { summary: executorSummary, checkpoint: { ...beforeCommit, version: 1,
          progress: { phase: "commit", phaseStartedAt: commitTime, lastActivityAt: commitTime } }, now: commitTime });
        headCommit = await commitDelegationChanges({
          root: workspace.root, workItemId: delegation.workItemId,
          baseCommit: workspace.baseCommit, expectedHead: headCommit,
          maxFileChars: this.config.gitMaxOutputChars,
          git: async (cwd, args, env) => (await this.#git(cwd, args, signal, env)).stdout,
        });
        // 提交已产生就先保存检查点，后续取消或 diff 读取失败仍可显式恢复。
        this.#store.update(id, { headCommit, summary: executorSummary, now: new Date().toISOString() });
      }
      if (signal.aborted) throw Object.assign(new Error("任务执行已取消。"), { name: "AbortError" });
      this.#recordAudit(id, "commit.created", { baseCommit: workspace.baseCommit, headCommit });
      const files = (await this.#git(workspace.root,
        ["diff", "--name-only", "--no-renames", "-z", `${workspace.baseCommit}..${headCommit}`, "--"], signal)).stdout.split("\0").filter(Boolean);
      const evidence = await collectReviewEvidence(files, this.config.maxContextChars, async file => {
        try {
          return (await this.#git(workspace.root, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
            "--no-renames", "--unified=3", `${workspace.baseCommit}..${headCommit}`, "--", file], signal)).stdout;
        } catch (error) {
          // 此处只生成审核节选，安全提交扫描已独立完成；超大单文件交给只读补查。
          if (error instanceof ProcessOutputLimitError) return undefined;
          throw error;
        }
      });
      this.#recordAudit(id, "review.evidence", { files: files.length, omittedFiles: evidence.omittedFiles.length });
      delegation = this.#store.update(id, {
        status: "reviewing",
        headCommit,
        executorSessionId,
        summary: executorSummary,
        now: new Date().toISOString(),
      });
      const reviewResponse = await this.#runtimeGenerate({
        delegationId: id, stage: "review",
        agent: supervisor,
        cwd: workspace.cwd,
        ...(supervisorSessionId ? { sessionId: supervisorSessionId } : {}),
        permissionProfile: "read_only",
        signal,
        prompt: [
          "审核 executor 的提交。对抗性检查正确性、边界条件、权限绕过、数据污染、测试缺口和回滚风险。",
          "以当前任务和真实提交为准；执行摘要是待核实的自述。仅在当前隔离工作区只读检查本次变更与相关代码、测试，不扩展到其他议题。",
          "审核材料节选是 Council 的上下文分配，不是实现缺陷。必须自行只读补查；不得要求执行者删除验收内容或压缩报告来迁就内联 diff。无法补查时明确说明阻断原因，不得批准。",
          `审核提交范围：${workspace.baseCommit}..${headCommit}。需要补查时使用 git diff --no-ext-diff --no-textconv 和相对路径读取文件；不能因内联材料有节选就直接批准。`,
          "只返回一个 JSON 对象，不要 Markdown：",
          '{"verdict":"approved|changes_requested|blocked","summary":"结论","findings":["可执行问题"],"inspectedFiles":["已只读补查完整变更的相对路径"]}',
          "无法读取或补查必要证据时返回 blocked；changes_requested 仅用于已核实的实现问题。",
          "",
          `验收标准：${delegation.acceptanceCriteria}`,
          `执行摘要：\n${executorSummary}`,
          `代码 diff：\n${evidence.content}`,
        ].join("\n"),
      });
      supervisorSessionId = reviewResponse.sessionId ?? supervisorSessionId;
      if (signal.aborted) throw Object.assign(new Error("任务执行已取消。"), { name: "AbortError" });
      review = parseDelegationReview(reviewResponse.content, evidence);
      this.#store.update(id, { supervisorSessionId, review: JSON.stringify(review), now: new Date().toISOString() });
      if (review.verdict === "blocked") {
        throw new DelegationReviewError("review_incomplete", "审核未确认已补查完整变更；提交已保留，恢复后重新审核，无需为缩小材料删减实现或报告。");
      }
      if (review.verdict === "approved") {
        const evidence = compact(
          `${executor.displayName} 已完成；${supervisor.displayName} 审核通过。${review.summary}`,
          MAX_WORK_ITEM_STATUS_NOTE_CHARS,
        );
        this.#database.updateWorkItemAsActor({
          topicId: delegation.topicId,
          workItemId: delegation.workItemId,
          status: delegation.completionPolicy === "review" ? "completed" : "in_progress",
          expectedVersion: claimed.version,
          statusNote: delegation.completionPolicy === "human"
            ? compact(`Agent 审核通过，等待人工验收。${evidence}`, MAX_WORK_ITEM_STATUS_NOTE_CHARS)
            : evidence,
          fixCommit: headCommit,
          actorId: supervisor.actorId,
        });
        this.#store.update(id, {
          status: "approved",
          headCommit,
          executorSessionId,
          supervisorSessionId,
          summary: executorSummary,
          review: JSON.stringify(review),
          now: new Date().toISOString(),
        });
        return headCommit;
      }
      this.#store.update(id, {
        status: "changes_requested",
        headCommit,
        executorSessionId,
        supervisorSessionId,
        review: JSON.stringify(review),
        now: new Date().toISOString(),
      });
    }
    throw new DelegationReviewError("review_revision_limit", "审核在最大修订轮次内未通过；提交与审核意见已保留，可检查后接续。");
  }

  #recordFailure(id: string, error: unknown, markWorkItem: boolean): void {
    const current = this.#store.get(id);
    if (!current || current.status === "cancelled" || current.status === "approved") {
      return;
    }
    const message = publicFailure(error);
    const failureCode = delegationFailureCode(error);
    this.#recordAudit(id, "delegation.failed", { summary: message, failureCode });
    this.#store.update(id, {
      status: "failed",
      failureCode,
      error: message,
      now: new Date().toISOString(),
    });
    if (!markWorkItem) return;
    const item = this.#database.listWorkItems({ topicId: current.topicId })
      .find((candidate) => candidate.id === current.workItemId);
    const executor = this.modelRouter.getAgent(current.executorAgentId);
    const expectedVersion = this.#workItemVersions.get(id);
    if (item && item.status !== "completed" && executor && expectedVersion === item.version) {
      try {
        this.#database.updateWorkItemAsActor({
          topicId: current.topicId,
          workItemId: current.workItemId,
          status: "blocked",
          expectedVersion,
          statusNote: compact(message, MAX_WORK_ITEM_STATUS_NOTE_CHARS),
          actorId: executor.actorId,
        });
      } catch {
        // 委派错误已经持久化；实施项若被并发更新，不能覆盖较新的人工状态。
      }
    }
  }
}
