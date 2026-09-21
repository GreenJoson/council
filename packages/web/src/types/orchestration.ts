/**
 * @input  依赖：Council 动态 Actor 编排公开协议
 * @output 导出：含权限/职责的 Capabilities、Run、跨 Agent 实施项委派、AI 计划、会话和独立快照类型
 * @pos    Web 自动轮次 UI 与 OrchestrationRepository 的稳定领域模型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 委派公开阶段进度和可选预算指标
 */

export type OrchestrationStatus =
  | "idle"
  | "running"
  | "waiting_agent"
  | "waiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationMessageKind =
  | "brief"
  | "proposal"
  | "critique"
  | "rebuttal"
  | "synthesis"
  | "note";

export type RuntimeCapabilityKey =
  | "text"
  | "repository_read"
  | "repository_write"
  | "shell_read"
  | "shell_write"
  | "tests"
  | "git_diff"
  | "git_commit"
  | "media_read"
  | "vision"
  | "session_resume";

export interface OrchestrationAdapter {
  id: string;
  actorId: string;
  label: string;
  mentionAlias?: string;
  providerId?: string;
  providerName?: string;
  brand?: {
    glyphId: string;
    colorToken: string;
    displayName: string;
  };
  available: boolean;
  limitation?: string;
  runtimeCapabilities: RuntimeCapabilityKey[];
  permissionProfile?: "read_only" | "workspace_write" | "danger_full_access";
  executionRole?: "advisor" | "executor" | "reviewer" | "hybrid";
}

export type WorkItemDelegationStatus =
  | "queued"
  | "executing"
  | "reviewing"
  | "changes_requested"
  | "approved"
  | "failed"
  | "cancelled";

export interface WorkItemDelegation {
  execution?: {
    phase: "brief" | "execution" | "commit" | "review";
    phaseStartedAt: string;
    lastActivityAt: string;
    turnsUsed?: number;
    turnLimit?: number;
    toolCalls?: number;
    lastTool?: string;
    stopReason?: string;
    checkpointAvailable?: boolean;
  };
  resumedFromId?: string;
  failureCode?: string;
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  id: string;
  topicId: string;
  workItemId: string;
  supervisorAgentId: string;
  executorAgentId: string;
  permissionProfile: "workspace_write" | "danger_full_access";
  status: WorkItemDelegationStatus;
  attempt: number;
  maxAttempts: number;
  baseCommit?: string;
  headCommit?: string;
  branchName?: string;
  summary?: string;
  review?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StartWorkItemDelegationInput {
  topicId: string;
  workItemId: string;
  expectedVersion: number;
  supervisorAgentId: string;
  executorAgentId: string;
  requestedPermission: "workspace_write" | "danger_full_access";
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  createInitialBaseline?: boolean;
}

export interface StartWorkItemDelegationBatchInput {
  topicId: string;
  workItems: Array<{ workItemId: string; expectedVersion: number }>;
  supervisorAgentId: string;
  executorAgentId: string;
  requestedPermission: "workspace_write" | "danger_full_access";
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  createInitialBaseline?: boolean;
}

export interface OrchestrationDefaultPolicy {
  maxRounds: number;
  agentIdleTimeoutMs: number;
  agentTimeoutMs: number;
  maxAttemptsPerRound: number;
  maxManualRecoveries: number;
  confirmation: {
    beforeRounds: number[];
    beforeCompletion: boolean;
  };
}

export interface OrchestrationCapabilities {
  adapters: OrchestrationAdapter[];
  defaultPolicy: OrchestrationDefaultPolicy;
}

export interface OrchestrationRoundPlan {
  adapterId: string;
  actorId: string;
  messageKind: OrchestrationMessageKind;
  instruction: string;
}

export interface OrchestrationFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface OrchestrationRun {
  id: string;
  topicId: string;
  status: OrchestrationStatus;
  plan: OrchestrationRoundPlan[];
  policy: OrchestrationDefaultPolicy;
  nextRoundIndex: number;
  currentAttempt: number;
  manualRecoveriesUsed: number;
  confirmedGates: string[];
  pendingGateId?: string;
  activeAgentId?: string;
  stopReason?: string;
  failure?: OrchestrationFailure;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationAgentOutput {
  runId: string;
  topicId: string;
  adapterId: string;
  sequence: number;
  content: string;
}

export type RuntimeBindingStatus =
  | "starting"
  | "ready"
  | "thinking"
  | "streaming"
  | "idle"
  | "interrupted"
  | "closing"
  | "closed";

export type RuntimeTransportKind =
  | "claude-resume"
  | "codex-resume"
  | "acp"
  | "openai-tool-loop"
  | "openai-sessionless";

export interface RuntimeBinding {
  id: string;
  topicId: string;
  agentId: string;
  actorId: string;
  providerId: string;
  transportKind: RuntimeTransportKind;
  status: RuntimeBindingStatus;
  hasSession: boolean;
  stateVersion: number;
  lastActivityAt: string;
  closeReason?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface CreateOrchestrationRunInput {
  topicId: string;
  confirmationBeforeCompletion?: boolean;
  plan: Array<{
    adapterId: string;
    messageKind: OrchestrationMessageKind;
    instruction: string;
    requestMessageId?: string;
  }>;
}

export interface GenerateWorkItemsInput {
  topicId: string;
  adapterId: string;
  /** 多决策议题必须显式锚定；缺省仅用于旧调用的最近 Accepted 兼容路径。 */
  decisionId?: string;
}

export interface GenerateWorkItemsResult {
  createdCount: number;
}

export interface ApproveOrchestrationRunInput {
  runId: string;
  expectedGateId: string;
  expectedVersion: number;
  approvalId: string;
}

export type CycleStage =
  | "proposal"
  | "critique"
  | "rebuttal"
  | "synthesis"
  | "awaiting_user"
  | "completed";

export interface CycleTurn {
  agentId: string;
  stage: "proposal" | "critique" | "rebuttal" | "synthesis";
  round: number;
  stance: "agree" | "non_blocking" | "blocking";
  messageId: string;
  commitRef?: string;
  commitTargets?: Array<{ repository: string; commit: string }>;
  verdictDeclared?: boolean;
}

export type DiscussionCycleKind = "discussion" | "fix_review";
export type CycleReviewScope = "discussion" | "workspace" | "commit";

export interface FrozenCycleRequirements {
  schemaVersion: 1;
  cycleKind: DiscussionCycleKind;
  reviewScope: CycleReviewScope;
  task: {
    all: RuntimeCapabilityKey[];
    proposer: RuntimeCapabilityKey[];
    reviewers: RuntimeCapabilityKey[];
  };
  byParticipant: Record<string, RuntimeCapabilityKey[]>;
}

export interface RuntimeCapabilitySnapshot {
  schemaVersion: 1;
  adapterId: string;
  actorId: string;
  agentConfigRevision: number;
  providerId: string;
  providerConfigRevision: number;
  bindingRevision: string;
  transportKind: string;
  declared: RuntimeCapabilityKey[];
  granted: RuntimeCapabilityKey[];
}

export interface DiscussionCycle {
  id: string;
  topicId: string;
  stage: CycleStage;
  status: "active" | "completed" | "abandoned";
  /** 开局冻结的名册；首位是提案人。 */
  participants: string[];
  kind: DiscussionCycleKind;
  requirements: FrozenCycleRequirements;
  runtimeCapabilities: RuntimeCapabilitySnapshot[];
  turns: CycleTurn[];
  roundBudget: number;
  currentRound: number;
  proposedDecisionId?: string;
  stopReason?: string;
  outcome?: {
    kind: "blocking_disagreements";
    items: Array<{
      agentId: string;
      round: number;
      messageId: string;
    }>;
  };
}

export interface CycleBlockingQuestion {
  id: string;
  askedByActorId: string;
  question: string;
  rationale: string;
  options: string[];
  questionMessageId: string;
}

/**
 * 状态机算出的下一步。界面只关心「在等什么」：
 * `await_user` 等用户回答，`await_fix` 等外部 Agent 把审出的问题修掉。
 */
export type CycleActionKind =
  | "invoke"
  | "await_user"
  | "await_fix"
  | "converge"
  | "abandon"
  | "done";

export interface DiscussionCycleView {
  cycle: DiscussionCycle;
  openQuestion?: CycleBlockingQuestion;
  action?: { kind: CycleActionKind };
  /** 仅修复互审：未关闭的阻断发现数，归零才收敛。 */
  reviewLedger?: { openBlockingFindings: number };
}

export interface StartCycleInput {
  topicId: string;
  participants: string[];
  roundBudget?: number;
  kind?: DiscussionCycleKind;
  reviewScope?: CycleReviewScope;
  taskRequirements?: {
    all?: RuntimeCapabilityKey[];
    proposer?: RuntimeCapabilityKey[];
    reviewers?: RuntimeCapabilityKey[];
  };
}

/** 提交一批修复并开一轮复审；不带 targets 时只触发复审，自述由外部 Agent 自己发。 */
export interface SubmitFixesInput {
  topicId: string;
  summary?: string;
  targets?: Array<{ repository: string; commit: string }>;
}

export interface AnswerCycleQuestionInput {
  topicId: string;
  questionMessageId: string;
  /** 回答正文；服务端会以用户身份发成公开消息并挂在提问下面。 */
  content: string;
}

export interface CycleMetrics {
  cycles: {
    total: number;
    converged: number;
    abandoned: number;
    active: number;
    awaitingUser: number;
  };
  rounds: { count: number; mean: number; median: number; max: number };
  wallClockMs: { count: number; mean: number; median: number; max: number };
  questions: { total: number; open: number; perCycle: number };
  verdicts: { checked: number; missing: number; missingCycleIds: string[] };
  /** `divergedCycleIds` 非空即为决策与讨论对不上，属于要立刻查的事故。 */
  decisionConsistency: { checked: number; divergedCycleIds: string[] };
}

export interface OrchestrationSnapshot {
  /** 已应用的数据库编排版本；草稿文本更新不推进它。 */
  revision?: number;
  capabilities?: OrchestrationCapabilities;
  activeTopicId?: string;
  runs: OrchestrationRun[];
  /** 当前议题的活动圆桌；null 表示确认过没有，undefined 表示还没读到。 */
  cycle?: DiscussionCycleView | null;
  /** 全局累计的圆桌运行度量，用来判断这套流程到底有没有比手工搬运快。 */
  cycleMetrics?: CycleMetrics;
  runtimeBindings?: RuntimeBinding[];
  agentOutputs?: OrchestrationAgentOutput[];
  sync: {
    status: "connected" | "syncing" | "offline";
    label: string;
  };
}
