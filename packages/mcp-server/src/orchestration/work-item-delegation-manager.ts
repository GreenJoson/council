/**
 * @input  依赖：Model Router 权限/职责、Claude/Codex headless runtime、CouncilDatabase、Git、委派账本与任务上下文解析
 * @output 导出：关键上下文完整的委派（议题任务与无议题直接任务）、按任务/项目列委派、逐文件审核、追加提交、修正草稿与交接恢复（沿用原 kind 与输入图）、显式权限及优雅关闭
 * @pos    supervisor→executor→review 的隔离 worktree 执行闭环；普通讨论永远不进入本层。
 *         审核提示词写明 approved 时 findings 必须为空（解析器会把带 findings 的 approved 改判 changes_requested），非阻断建议与人工验证项进 summary
 *         kind=code 走审核闭环（需要 Git 仓库，非仓库给出初始化指引）；kind=image 不建 worktree、不碰 Git，
 *         在委派根目录下的隔离空目录交给 delegation-image-execution（单段、强制人工验收、不接续），项目可以还不是仓库
 *         P3：prototype 任务按 code 委派；代码委派的输入图拷进 `.council/in/`（写 exclude）并以相对路径进入两段提示词；
 *         onSettled/get 供流水线订阅终态与启动对账；stageProjectInputs 供流水线 brief/review 把资产拷进项目 `.council/in/`
 *         P4 Worker 团队：setTeamHooks 让 Lead 执行阶段注入 Council 团队 MCP 与「团队模式」指令，并在快照/提交前
 *         从仓储同步 Lead headCommit（Worker 合并会移动 Lead HEAD），交付提交经 withLeadWorkspace 排进团队锁；startTeamWorker 建 team_worker 子委派并交给
 *         delegation-worker-execution（不审核、不认领实施项）；setTeamLeadHead / teamLeadWorkspace / projectPathOf 供 TeamService 用
 *         全新仓库的安全基线拆到 delegation-initial-baseline
 *         流水线原型（任务 kind=prototype）在非 Git 项目改走 delegation-standalone-workspace 的独立 Demo 仓库（建在委派根目录，
 *         不碰项目），提示词与审核带上 Demo 约定；exportStandaloneDemo 供流水线在通过后把 Demo 导出到项目 council-demos/
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 阶段执行、审核材料、Git 交付与交接分属专用模块；跨工作区不复用模型会话
 */

import {
  DEFAULT_CODEX_IMAGE_MAX_OUTPUTS,
  DEFAULT_CODEX_IMAGE_IDLE_TIMEOUT_MS,
  DEFAULT_CODEX_IMAGE_TIMEOUT_MS,
  EXECUTION_DEFAULTS,
  loadAssetConfig,
} from "../config.js";
import { runExecutionSegments } from "./delegation-execution-segments.js";
import { delegationInputAssetsContext, delegationTaskContext } from "./delegation-task-context.js";
import { assertDelegableTask, resolveDelegationTask, type ResolvedDelegationTask } from "./delegation-task-resolver.js";
import { collectReviewEvidence, parseDelegationReview, DelegationReviewError, type DelegationReview } from "./delegation-review.js";
import { commitDelegationChanges } from "./delegation-git-delivery.js";
import { createDelegationHandoff, handoffContext } from "./delegation-handoff.js";
import { EXECUTION_CHECKPOINT_INSTRUCTION } from "./delegation-execution-result.js";
import { delegationFailureCode, validateRecoveryCheckpoint } from "./delegation-recovery.js";
import { FORBIDDEN_STAGED_PATH, SECRET_DIFF_PATTERN, snapshotUncommittedWork } from "./delegation-workspace-snapshot.js";
import { RuntimeAuditStore, redactAuditText } from "./runtime-audit-store.js";
import { runDelegationRuntimeStage, type DelegationRuntimeInput } from "./delegation-runtime-stage.js";
import { executeTeamWorker, type TeamWorkerWorkspace } from "./delegation-worker-execution.js";
import { createInitialBaseline as establishInitialBaseline } from "./delegation-initial-baseline.js";
import {
  exportStandaloneDemo,
  prepareStandaloneRepository,
  standaloneCommonDir,
  standaloneWorkspaceInstructions,
} from "./delegation-standalone-workspace.js";
import type { RuntimeMcpServers } from "../runtime-mcp-servers.js";
import {
  copyInputAssets,
  COUNCIL_INPUT_DIR,
  defaultImageSupervisor,
  excludeCouncilDir,
  executeImageDelegation,
  IMAGE_EXECUTOR_REQUIRED_MESSAGE,
  validateImageDelegationRequest,
} from "./delegation-image-execution.js";
import { AssetService } from "../assets/asset-service.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
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
import type { AssetConfig, CouncilConfig, CouncilHttpConfig, WorkItem, WorkItemKind } from "../types.js";
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
  /** 议题入口传入时校验任务归属；直接任务入口省略。 */
  topicId?: string;
  workItemId: string;
  expectedVersion: number;
  /** code 必填；image 可省略，默认取启用的 Claude CLI Agent（优先 @claude）。 */
  supervisorAgentId?: string;
  executorAgentId: string;
  requestedPermission: DelegationExecutionPermission;
  /** 只有无 HEAD 的全新仓库允许；显式确认后建立经过敏感扫描的初始提交。 */
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  createInitialBaseline?: boolean;
  /** code 或 image；缺省视为 code，且须与任务 kind 一致。 */
  kind?: WorkItemKind;
  /** code 只接受空数组；image 为参考图资产 id（最多 8 个，同项目、kind=image）。 */
  inputAssetIds?: readonly string[];
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

/** TeamService 注入：只有活跃团队的 Lead 委派返回运行时附加项，其余委派返回 undefined。 */
export interface DelegationTeamHooks {
  leadRuntime(delegationId: string): { mcpServers: RuntimeMcpServers; instructions: readonly string[] } | undefined;
  /** Lead 交付提交与团队检查点/合并共用同一把团队锁，避免合并移动 HEAD 时被交付提交 reset 掉。 */
  withLeadWorkspace<T>(delegationId: string, task: () => Promise<T>): Promise<T>;
}

export interface StartTeamWorkerInput {
  leadDelegationId: string;
  label: string;
  brief: string;
  scopePaths: readonly string[];
  requestedPermission: DelegationExecutionPermission;
  workspace: TeamWorkerWorkspace;
}

interface PreparedWorkspace {
  root: string;
  cwd: string;
  baseCommit: string;
  branchName: string;
  restoredWork?: boolean;
  /** 非 Git 项目的原型：独立 Demo 仓库，提示词与审核带上 Demo 约定。 */
  standalone?: boolean;
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
  maxExecutionSegments?: number;
  executionTimeoutMs?: number;
  /** 图像委派：Codex 默认产物目录（兜底收集）、单次超时、静默卡住上限与入库张数上限、资产库配置；缺省按默认值回落。 */
  codexHome?: string;
  imageTimeoutMs?: number;
  imageIdleTimeoutMs?: number;
  imageMaxOutputs?: number;
  assets?: AssetConfig;
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
    "安全", "批量", "Claude", "Codex", "恢复", "原工作区", "图像", "生图",
  ];
  return controlled.some((prefix) => message.startsWith(prefix))
    ? compact(message, 500)
    : "任务执行失败，请检查本地日志。";
}

export class WorkItemDelegationManager {
  readonly #audit: RuntimeAuditStore;
  readonly #store: WorkItemDelegationStore;
  readonly #database: CouncilDatabase;
  readonly #assets: AssetService;
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks = new Map<string, Promise<void>>();
  /** 只允许回写本次派发/认领所得版本，不覆盖执行期间的人工作答。 */
  readonly #workItemVersions = new Map<string, number>();
  #teamHooks: DelegationTeamHooks | undefined;

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
    this.#assets = new AssetService(
      this.#database,
      config.assets ?? loadAssetConfig({}, path.dirname(config.databasePath)),
    );
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
      maxExecutionSegments: councilConfig.delegationMaxExecutionSegments,
      executionTimeoutMs: councilConfig.delegationExecutionTimeoutMs,
      ...(councilConfig.codexHome ? { codexHome: councilConfig.codexHome } : {}),
      ...(councilConfig.codexImageTimeoutMs ? { imageTimeoutMs: councilConfig.codexImageTimeoutMs } : {}),
      ...(councilConfig.codexImageIdleTimeoutMs ? { imageIdleTimeoutMs: councilConfig.codexImageIdleTimeoutMs } : {}),
      ...(councilConfig.codexImageMaxOutputs ? { imageMaxOutputs: councilConfig.codexImageMaxOutputs } : {}),
      ...(councilConfig.assets ? { assets: councilConfig.assets } : {}),
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

  /** 任务入口：列出单个任务（含无议题任务）的全部委派，新者在前。 */
  listForWorkItem(workItemId: string): WorkItemDelegation[] {
    this.#database.getWorkItem(workItemId);
    return this.#store.listForWorkItem(workItemId);
  }

  listForProject(projectPath: string): WorkItemDelegation[] {
    return this.#store.listForProject(projectPath);
  }

  get activeTaskCount(): number { return this.#tasks.size; }

  /** 单条委派公开快照；流水线启动对账用。 */
  get(id: string): WorkItemDelegation | undefined {
    return this.#store.get(id);
  }

  setTeamHooks(hooks: DelegationTeamHooks): void {
    this.#teamHooks = hooks;
  }

  /** 任务所在项目路径（议题任务取议题绑定路径）；TeamService 计算 Worker 工作区内的相对 cwd 用。 */
  projectPathOf(workItemId: string): string {
    return this.#taskContext(workItemId).projectPath;
  }

  /** Lead 工作区根目录与当前记录的 HEAD；Lead 尚未建好 worktree 时返回 undefined。 */
  teamLeadWorkspace(id: string): { root: string; baseCommit: string; headCommit: string } | undefined {
    const lead = this.#store.getPrivate(id);
    if (!lead?.worktreePath || !lead.baseCommit || !ACTIVE_STATUSES.has(lead.status)) return undefined;
    return { root: lead.worktreePath, baseCommit: lead.baseCommit, headCommit: lead.headCommit ?? lead.baseCommit };
  }

  /** TeamService 在 Lead 工作区提交检查点或合并 Worker 后回写；Lead 执行阶段以此为快照/提交基准。 */
  setTeamLeadHead(id: string, headCommit: string): void {
    const lead = this.#store.get(id);
    if (!lead || !ACTIVE_STATUSES.has(lead.status)) throw new CouncilConflictError("Lead 委派已结束，不能再合并。");
    this.#store.update(id, { headCommit, now: new Date().toISOString() });
  }

  /**
   * 建 Worker 子委派（team_worker=1，沿用 Lead 的执行者、审核者与完成策略），立即异步执行。
   * 权限取请求值与 Lead 权限的交集；工作区由 TeamService 事先从 Lead HEAD 分叉。
   */
  startTeamWorker(input: StartTeamWorkerInput): WorkItemDelegation {
    const lead = this.#store.get(input.leadDelegationId);
    if (!lead || !ACTIVE_STATUSES.has(lead.status)) throw new CouncilConflictError("Lead 委派已结束，不能再派发 Worker。");
    const executor = this.#requireAgent(lead.executorAgentId, "执行");
    const permission = intersectPermissionProfiles(
      intersectPermissionProfiles(executor.permissionProfile, lead.permissionProfile),
      input.requestedPermission,
    );
    if (!isExecutionPermission(permission)) throw new CouncilValidationError("Worker 权限不足以执行代码改动。");
    const brief = input.brief.trim();
    if (!brief) throw new CouncilValidationError("Worker 指令不能为空。");
    const delegation = this.#store.create({
      id: `delegation-${randomUUID()}`,
      ...(lead.topicId ? { topicId: lead.topicId } : {}),
      workItemId: lead.workItemId,
      supervisorAgentId: lead.supervisorAgentId,
      executorAgentId: lead.executorAgentId,
      permissionProfile: permission,
      // 与 Lead 相同，避免实施项验收触发器按「最新一条委派」读到不同的完成策略。
      completionPolicy: lead.completionPolicy,
      acceptanceCriteria: compact(brief, 4_000),
      maxAttempts: this.config.maxAttempts,
      branchName: input.workspace.branchName,
      teamWorker: true,
      now: new Date().toISOString(),
    });
    this.#recordAudit(delegation.id, "delegation.created", { criteria: delegation.acceptanceCriteria, leadDelegationId: lead.id });
    const controller = new AbortController();
    this.#controllers.set(delegation.id, controller);
    const run = executeTeamWorker(delegation.id, input.workspace,
      { brief, scopePaths: input.scopePaths, label: input.label }, {
        store: this.#store, executor, executorProtocol: this.#requireNativeProvider(executor).protocol,
        generate: (stage) => this.#runtimeGenerate(stage),
        git: async (cwd, args, env) => (await this.#git(cwd, args, controller.signal, env)).stdout,
        record: (kind, data) => this.#recordAudit(delegation.id, kind, data),
        maxFileChars: this.config.gitMaxOutputChars,
        ...(this.config.maxExecutionSegments ? { maxExecutionSegments: this.config.maxExecutionSegments } : {}),
        ...(this.config.executionTimeoutMs ? { executionTimeoutMs: this.config.executionTimeoutMs } : {}),
        ...(this.config.executionMaxTurns ? { executionMaxTurns: this.config.executionMaxTurns } : {}),
      }, controller.signal)
      .then(() => undefined)
      .catch((error: unknown) => this.#recordFailure(delegation.id, error, false))
      .finally(() => {
        this.#controllers.delete(delegation.id);
        this.#tasks.delete(delegation.id);
      });
    this.#tasks.set(delegation.id, run);
    return delegation;
  }

  /** 委派进入终态（approved/failed/cancelled）时异步通知一次；返回取消订阅函数。 */
  onSettled(listener: (delegation: WorkItemDelegation) => void | Promise<void>): () => void {
    return this.#store.onSettled(listener);
  }

  /**
   * 流水线 brief/review 阶段：把资产拷进 `<root>/.council/in/` 并尽量写 exclude（非 Git 目录跳过）；
   * 返回相对 root 的 posix 路径。复用本管理器持有的资产服务与 Git 执行器，不另起一套。
   */
  async stageProjectInputs(
    root: string,
    assetIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Array<{ assetId: string; relativePath: string }>> {
    if (assetIds.length === 0) return [];
    const inputDir = path.join(root, COUNCIL_INPUT_DIR);
    await mkdir(inputDir, { recursive: true });
    await excludeCouncilDir(async (cwd, args, gitSignal) => (await this.#git(cwd, args, gitSignal)).stdout, root, signal)
      .catch(() => undefined);
    const copied = await copyInputAssets(this.#assets, inputDir, assetIds);
    return copied.map((item) => ({ assetId: item.assetId, relativePath: item.relativePath }));
  }

  start(input: StartWorkItemDelegationInput): WorkItemDelegation {
    const { item, topicId, projectPath } = assertDelegableTask(this.#database, input, this.#taskLimits);
    const kind = input.kind ?? "code";
    const inputAssetIds = [...(input.inputAssetIds ?? [])];
    if (kind === "image") validateImageDelegationRequest(this.#database, { item, projectPath, inputAssetIds });
    const { supervisor, executor, permission } = kind === "image"
      ? this.#resolveImageAssignment(input)
      : this.#resolveAssignment({ ...input, supervisorAgentId: input.supervisorAgentId ?? "" });
    const now = new Date().toISOString();
    let delegation: WorkItemDelegation;
    try {
      delegation = this.#store.create({
        id: `delegation-${randomUUID()}`,
        ...(topicId ? { topicId } : {}),
        workItemId: input.workItemId,
        kind,
        inputAssetIds,
        supervisorAgentId: supervisor.id,
        executorAgentId: executor.id,
        permissionProfile: permission,
        // 图像产物不经审核，必须由人验收。
        completionPolicy: kind === "image" ? "human" : input.completionPolicy ?? "human",
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
      delegationTaskContext(detail, item, this.config.maxContextChars);
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
    if (previous.kind === "image") throw new CouncilConflictError("图像委派不支持接续，请重新委派。");
    const task = this.#taskContext(previous.workItemId);
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
    if (this.#taskContext(previous.workItemId).item.version !== expectedVersion) {
      throw new CouncilConflictError("实施项在恢复检查期间已变化，请刷新后重试。");
    }
    const latest = this.#store.listForWorkItem(previous.workItemId)[0];
    if (latest?.id !== id) throw new CouncilConflictError("已有更新的委派，请从最新记录继续。");
    // 工作区检查会让出执行权，创建运行前重新核对当前权限上限。
    if (this.#resolveAssignment({ ...previous, requestedPermission: desiredPermission }).permission !== desiredPermission) {
      throw new CouncilConflictError("所选接续权限超过 Agent 当前上限，请检查设置。");
    }
    let created: WorkItemDelegation;
    try {
      // 接续沿用原委派的产出类型与输入图：P3 原型委派靠输入图（选定终稿）进入 `.council/in/`，丢了就等于换题。
      created = this.#store.create({
        id: `delegation-${randomUUID()}`, ...(previous.topicId ? { topicId: previous.topicId } : {}), workItemId: previous.workItemId,
        kind: previous.kind, inputAssetIds: [...previous.inputAssetIds],
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
        ...(checkpoint.standalone ? { standalone: true } : {}),
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

  #resolveAssignment(input: {
    supervisorAgentId: string;
    executorAgentId: string;
    requestedPermission: DelegationExecutionPermission;
  }): DelegationAssignment {
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

  /** 图像委派：执行者必须是 Codex CLI（image_generate 能力由服务层探针校验）；监督者可省略并取默认 Claude。 */
  #resolveImageAssignment(input: Pick<
    StartWorkItemDelegationInput,
    "supervisorAgentId" | "executorAgentId" | "requestedPermission"
  >): DelegationAssignment {
    const executor = this.#requireAgent(input.executorAgentId, "执行");
    if (this.modelRouter.getProvider(executor.providerId)?.protocol !== "codex-cli") {
      throw new CouncilValidationError(IMAGE_EXECUTOR_REQUIRED_MESSAGE);
    }
    const supervisorId = input.supervisorAgentId ?? defaultImageSupervisor(
      this.modelRouter.listAgents(),
      (providerId) => this.modelRouter.getProvider(providerId),
      executor.id,
    ).id;
    return this.#resolveAssignment({ ...input, supervisorAgentId: supervisorId });
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

  async #prepareWorktree(
    delegation: WorkItemDelegation,
    projectPath: string,
    createInitialBaseline: boolean,
    signal: AbortSignal,
    allowStandalone = false,
  ): Promise<PreparedWorkspace> {
    const normalized = await realpath(normalizeProjectPath(projectPath) as string);
    // 非 Git 目录给出可操作的指引，而不是笼统的“Git 操作失败”；出图走隔离目录，不经过这里。
    const toplevel = await this.#runGit(normalized, ["rev-parse", "--show-toplevel"], signal);
    if (toplevel.exitCode !== 0) {
      if (allowStandalone) return await this.#prepareStandaloneWorkspace(delegation, signal);
      throw new Error("项目目录还不是 Git 仓库：代码委派需要 Git 隔离工作区与 diff 审核，请先初始化并提交一次；出图委派与流水线原型阶段不受此限制。");
    }
    const root = await realpath(toplevel.stdout.trim());
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
      baseCommit = await establishInitialBaseline(root, {
        git: (cwd, args, env) => this.#git(cwd, args, signal, env),
        runGit: (cwd, args) => this.#runGit(cwd, args, signal),
      });
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

  /** 非 Git 项目的原型：委派根目录下新建独立仓库（空树基线），项目目录不动。 */
  async #prepareStandaloneWorkspace(delegation: WorkItemDelegation, signal: AbortSignal): Promise<PreparedWorkspace> {
    const suffix = delegation.id.replace(/^delegation-/u, "").slice(0, 12);
    const branchName = delegation.branchName ?? `codex/council-${suffix}`;
    const worktreePath = path.join(this.config.worktreeRoot, delegation.id);
    await mkdir(this.config.worktreeRoot, { recursive: true, mode: 0o700 });
    const baseCommit = await prepareStandaloneRepository({
      root: worktreePath,
      branchName,
      git: async (cwd, args, env) => (await this.#git(cwd, args, signal, env)).stdout,
    });
    this.#store.update(delegation.id, { baseCommit, branchName, worktreePath, now: new Date().toISOString() });
    this.#recordAudit(delegation.id, "workspace.standalone", { summary: "项目不是 Git 仓库，原型改在独立 Demo 工作区执行。" });
    return { root: worktreePath, cwd: worktreePath, baseCommit, branchName, standalone: true };
  }

  /**
   * 流水线原型通过后：独立 Demo 工作区（非 Git 项目）按已审核提交导出到项目 `council-demos/` 下；
   * Git 项目的 worktree 返回 undefined（代码在委派分支上）。工作区已不存在时也返回 undefined。
   */
  async exportStandaloneDemo(id: string, name: string): Promise<{ path: string; fileCount: number } | undefined> {
    const delegation = this.#store.getPrivate(id);
    if (!delegation || delegation.status !== "approved" || !delegation.worktreePath || !delegation.headCommit) return undefined;
    if (!(await lstat(delegation.worktreePath).then(() => true, () => false))) return undefined;
    const signal = new AbortController().signal;
    const git = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => (await this.#git(cwd, args, signal, env)).stdout;
    if (!(await standaloneCommonDir({ root: delegation.worktreePath, worktreeRoot: this.config.worktreeRoot, git }))) {
      return undefined;
    }
    const exported = await exportStandaloneDemo({
      root: delegation.worktreePath,
      headCommit: delegation.headCommit,
      projectPath: this.#taskContext(delegation.workItemId).projectPath,
      name,
      git,
    });
    this.#recordAudit(id, "demo.exported", { path: exported.path, files: exported.fileCount });
    return exported;
  }

  /**
   * 图像委派的工作区：委派根目录下的独立空目录，不依赖 Git。
   * 产物只入资产库、从不提交，worktree 只会带来“必须是仓库 / 必须干净”的无关约束；
   * 生图提示词自包含（brief + `.council/in` 参考图），不读项目文件。
   */
  async #prepareImageWorkspace(delegation: WorkItemDelegation): Promise<{ root: string }> {
    await mkdir(this.config.worktreeRoot, { recursive: true, mode: 0o700 });
    const root = path.join(this.config.worktreeRoot, delegation.id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    this.#store.update(delegation.id, { worktreePath: root, now: new Date().toISOString() });
    return { root: await realpath(root) };
  }

  get #taskLimits(): { messageLimit: number; maxContextChars: number } {
    return { messageLimit: this.config.defaultMessageLimit, maxContextChars: this.config.maxContextChars };
  }

  /** 按任务 id 解析上下文：有议题沿用议题约束与已接受决策，无议题只用任务本身。 */
  #taskContext(workItemId: string): ResolvedDelegationTask {
    return resolveDelegationTask(this.#database, workItemId, this.#taskLimits);
  }

  async #runSingle(
    id: string,
    createInitialBaseline: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const delegation = this.#store.get(id);
      if (!delegation) throw new Error("任务委派不存在。");
      if (delegation.kind === "image") {
        await this.#executeImage(id, await this.#prepareImageWorkspace(delegation), signal);
        return;
      }
      const task = this.#taskContext(delegation.workItemId);
      const workspace = await this.#prepareWorktree(
        delegation,
        task.projectPath,
        createInitialBaseline,
        signal,
        task.item.kind === "prototype",
      );
      await this.#executeInWorkspace(id, workspace, signal);
    } catch (error) {
      this.#recordFailure(id, error, true);
      throw error;
    }
  }

  /** 代码委派输入图：写 exclude 后拷贝，返回提示词段落（相对 cwd 路径）；无输入时不碰工作区。 */
  async #prepareCodeInputAssets(
    assetIds: readonly string[],
    workspace: PreparedWorkspace,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (assetIds.length === 0) return [];
    const inputDir = path.join(workspace.root, COUNCIL_INPUT_DIR);
    await mkdir(inputDir, { recursive: true });
    await excludeCouncilDir(async (cwd, args, gitSignal) => (await this.#git(cwd, args, gitSignal)).stdout, workspace.root, signal);
    const copied = await copyInputAssets(this.#assets, inputDir, assetIds);
    return delegationInputAssetsContext(copied.map((item) =>
      path.relative(workspace.cwd, item.absolutePath).split(path.sep).join("/")));
  }

  async #executeImage(id: string, workspace: { root: string }, signal: AbortSignal): Promise<void> {
    return executeImageDelegation({
      store: this.#store,
      database: this.#database,
      assets: this.#assets,
      codex: this.codexRuntime,
      record: (kind, data) => this.#recordAudit(id, kind, data),
      requireAgent: (agentId, action) => this.#requireAgent(agentId, action),
      taskContext: (workItemId) => this.#taskContext(workItemId),
      workItemVersion: () => this.#workItemVersions.get(id),
      setWorkItemVersion: (version) => this.#workItemVersions.set(id, version),
      config: {
        ...(this.config.codexHome ? { codexHome: this.config.codexHome } : {}),
        timeoutMs: this.config.imageTimeoutMs ?? DEFAULT_CODEX_IMAGE_TIMEOUT_MS,
        idleTimeoutMs: this.config.imageIdleTimeoutMs ?? DEFAULT_CODEX_IMAGE_IDLE_TIMEOUT_MS,
        maxOutputs: this.config.imageMaxOutputs ?? DEFAULT_CODEX_IMAGE_MAX_OUTPUTS,
      },
    }, id, { root: workspace.root }, signal);
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
      const firstTask = this.#taskContext(first.workItemId);
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
    const task = this.#taskContext(delegation.workItemId);
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
    // 代码委派的输入图（原型任务的终稿等）拷进不被提交的 .council/in/，提示词里只给相对 cwd 的路径。
    const inputContext = [
      ...await this.#prepareCodeInputAssets(delegation.inputAssetIds, workspace, signal),
      ...(workspace.standalone ? standaloneWorkspaceInstructions(task.projectPath) : []),
    ];
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
        "你是本次代码任务的 supervisor。只讨论当前任务及其所属议题，不读取或总结历史议题。",
        "请给执行 Agent 一份精确、可验证的实施指令：明确范围、必须保留的不变量、测试与验收标准。",
        "不要修改文件，不要运行写操作。",
        ...(workspace.restoredWork ? ["当前隔离工作区已接回上次中断的未提交代码。先检查现有实现与缺口，指示执行者接续完成；草稿不代表已通过验证。"] : []),
        "",
        `验收标准：${delegation!.acceptanceCriteria}`,
        task.context,
        ...inputContext,
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
    // 团队 Lead：Worker 合并与派发前检查点会移动 Lead HEAD，并由 TeamService 回写仓储；快照与提交前必须同步。
    const syncTeamHead = (): string => {
      if (this.#teamHooks?.leadRuntime(id)) headCommit = this.#store.get(id)?.headCommit ?? headCommit;
      return headCommit;
    };
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
        const executionAssignment = delegation;
        const executorResponse = await runExecutionSegments({
          maxSegments: (this.config.maxExecutionSegments ?? 1) > 1 ? this.config.maxExecutionSegments! : executionAssignment.maxAttempts,
          automaticContinuation: (this.config.maxExecutionSegments ?? 1) > 1,
          timeoutMs: this.config.executionTimeoutMs ?? EXECUTION_DEFAULTS.timeoutMs,
          sessionId: executorSessionId, signal,
          read: () => this.#store.getPrivate(id)!,
          save: (budget, summary) => this.#store.update(id, {
            checkpoint: { ...this.#store.getPrivate(id)?.checkpoint, version: 1, executionBudget: { ...budget } },
            ...(summary ? { summary } : {}), now: new Date().toISOString(),
          }),
          snapshot: async () => (await snapshotUncommittedWork({ root: workspace.root, headCommit: syncTeamHead(),
            allowEmpty: true, maxFileChars: this.config.gitMaxOutputChars,
            git: async (cwd, args, env) => (await this.#git(cwd, args, signal, env)).stdout,
          })).tree,
          validate: () => {
            const current = this.#taskContext(executionAssignment.workItemId);
            if (current.item.version !== claimed.version || current.contextFingerprint !== task.contextFingerprint) {
              throw new CouncilConflictError("任务在执行期间已变化，已停止接续，请检查最新范围。");
            }
            if (this.#resolveAssignment({ ...executionAssignment, requestedPermission: executionAssignment.permissionProfile }).permission !== executionAssignment.permissionProfile) {
              throw new CouncilConflictError("执行权限已变化，已停止接续。");
            }
          },
          record: (kind, data) => this.#recordAudit(id, kind, data),
          generate: (sessionId, segmentContinuation, segmentSignal) => {
            const team = this.#teamHooks?.leadRuntime(id);
            return this.#runtimeGenerate({
            delegationId: id, stage: "execution",
            agent: executor,
            cwd: workspace.cwd,
            ...(sessionId ? { sessionId } : {}),
            permissionProfile: executionAssignment.permissionProfile,
            signal: segmentSignal,
            ...(team ? { mcpServers: team.mcpServers } : {}),
            prompt: [
              "你是本次任务的 executor。只处理下面这一个实施项。",
              "在当前隔离 worktree 中直接修改代码并运行必要验证；不要切换仓库，不要访问无关目录。",
              "不要自行 git commit；Council 会扫描敏感内容后统一提交。",
              ...(team ? team.instructions : ["不要调用 Council，也不要委派其他 Agent。完成后简要说明改动和测试结果。"]),
              EXECUTION_CHECKPOINT_INSTRUCTION,
              ...(this.#requireNativeProvider(executor).protocol === "claude-cli" && this.config.executionMaxTurns
                ? [`本次最多 ${this.config.executionMaxTurns} 个模型回合；预留回合用于验证与阶段交接，不要等 CLI 强制中断。`] : []),
              ...(workspace.restoredWork ? ["当前工作区保留了上次未完成的代码，请基于这些改动继续检查、补齐与测试，不要因为存在草稿就假定任务已完成。旧指令如含旧工作区路径，以当前隔离工作区为准。"] : []),
              "",
              "Supervisor 指令：",
              briefResponse.content,
              "",
              "当前实施项原文：",
              `验收标准：${executionAssignment.acceptanceCriteria}`,
              task.context,
              ...inputContext,
              ...continuation,
              ...correction,
              segmentContinuation,
            ].join("\n"),
            });
          },
        });
        executorSessionId = executorResponse.sessionId ?? executorSessionId;
        executorSummary = compact(executorResponse.content, 8_000);
        const beforeCommit = this.#store.getPrivate(id)?.checkpoint;
        const commitTime = new Date().toISOString();
        this.#store.update(id, { summary: executorSummary, checkpoint: { ...beforeCommit, version: 1,
          progress: { phase: "commit", phaseStartedAt: commitTime, lastActivityAt: commitTime } }, now: commitTime });
        const commitAndSave = async (): Promise<string> => {
          const committed = await commitDelegationChanges({
            root: workspace.root, workItemId: executionAssignment.workItemId,
            baseCommit: workspace.baseCommit, expectedHead: syncTeamHead(),
            maxFileChars: this.config.gitMaxOutputChars,
            git: async (cwd, args, env) => (await this.#git(cwd, args, signal, env)).stdout,
          });
          // 提交已产生就先保存检查点，后续取消或 diff 读取失败仍可显式恢复。
          this.#store.update(id, { headCommit: committed, summary: executorSummary, now: new Date().toISOString() });
          return committed;
        };
        headCommit = await (this.#teamHooks ? this.#teamHooks.withLeadWorkspace(id, commitAndSave) : commitAndSave());
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
          "approved 时 findings 必须为空：findings 里出现任何条目都会按 changes_requested 处理。非阻断建议、顺手可做的小改进，以及只能由人工或在有浏览器、能起服务的环境里验证的项目都不是 findings，逐条写进 summary 留给人工验收；执行环境限制（沙箱不能监听端口、起浏览器）本身不是实现缺陷。",
          "",
          `验收标准：${delegation!.acceptanceCriteria}`,
          `当前任务与约束（不能依赖旧会话是否仍在）：\n${task.context}`,
          ...(workspace.standalone ? standaloneWorkspaceInstructions(task.projectPath) : []),
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
    let item: WorkItem | undefined;
    try { item = this.#database.getWorkItem(current.workItemId); } catch { item = undefined; }
    const executor = this.modelRouter.getAgent(current.executorAgentId);
    const expectedVersion = this.#workItemVersions.get(id);
    if (item && item.status !== "completed" && executor && expectedVersion === item.version) {
      try {
        this.#database.updateWorkItemAsActor({
          ...(current.topicId ? { topicId: current.topicId } : {}),
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
