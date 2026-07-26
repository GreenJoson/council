/**
 * @input  依赖：编排协议枚举
 * @output 导出：轮次策略、运行快照、Run/RuntimeBinding lease、共享上下文与 Agent 调用类型
 * @pos    编排核心和外部适配器之间的严格类型契约
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  FAILURE_CODES,
  MESSAGE_KINDS,
  RUN_STATUSES,
  STOP_REASONS,
} from "./constants.js";

export type RunStatus = (typeof RUN_STATUSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type ActorId = string;
export type StopReason = (typeof STOP_REASONS)[number];
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface RoundPlan {
  adapterId: string;
  actorId: ActorId;
  /** v3 Run 必须冻结；仅旧 v1/v2 快照可缺省并进入只读/可取消兼容态。 */
  bindingRevision?: string;
  /** v4 Run 必须冻结；旧 v1-v3 快照缺失时只能读取或取消。 */
  runtimeBindingId?: string;
  /** Composer 直召冻结已落库的人类请求；手动 Run 不设置并使用 instruction。 */
  requestMessageId?: string;
  messageKind: MessageKind;
  instruction: string;
}

export interface ConfirmationPolicy {
  beforeRounds: readonly number[];
  beforeCompletion: boolean;
}

export interface OrchestrationPolicy {
  maxRounds: number;
  allowedAgents: readonly string[];
  agentTimeoutMs: number;
  agentCleanupTimeoutMs: number;
  maxAttemptsPerRound: number;
  maxManualRecoveries: number;
  confirmation: ConfirmationPolicy;
}

export interface RunFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
}

export interface OrchestrationRun {
  id: string;
  topicId: string;
  status: RunStatus;
  plan: readonly RoundPlan[];
  policy: OrchestrationPolicy;
  nextRoundIndex: number;
  currentAttempt: number;
  manualRecoveriesUsed: number;
  confirmedGates: readonly string[];
  pendingGateId?: string;
  activeAgentId?: string;
  stopReason?: StopReason;
  failure?: RunFailure;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunInput {
  topicId: string;
  plan: readonly RoundPlan[];
  policy: OrchestrationPolicy;
}

export interface CouncilPublicMessage {
  id: string;
  topicId: string;
  actorId: ActorId;
  kind: MessageKind;
  content: string;
  createdAt: string;
}

export interface CouncilTopicContext {
  topicId: string;
  title: string;
  question: string;
  constraints: readonly string[];
  projectPath?: string;
  messages: readonly CouncilPublicMessage[];
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
  | "openai-sessionless";

export interface RuntimeBindingCursor {
  createdAt: string;
  messageId: string;
}

export interface RuntimeBinding {
  id: string;
  topicId: string;
  agentId: string;
  actorId: ActorId;
  providerId: string;
  bindingRevision: string;
  agentConfigRevision: number;
  providerConfigRevision: number;
  projectPath?: string;
  transportKind: RuntimeTransportKind;
  sessionId?: string;
  cursor?: RuntimeBindingCursor;
  status: RuntimeBindingStatus;
  stateVersion: number;
  epoch: number;
  processInstanceId?: string;
  lastActivityAt: string;
  closeReason?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface EnsureRuntimeBindingInput {
  topicId: string;
  agentId: string;
  actorId: ActorId;
  providerId: string;
  bindingRevision: string;
  agentConfigRevision: number;
  providerConfigRevision: number;
  transportKind: RuntimeTransportKind;
  processInstanceId: string;
}

export interface ListRuntimeBindingsInput {
  topicId: string;
  includeClosed?: boolean;
}

export interface RuntimeBindingLease {
  bindingId: string;
  ownerId: string;
  token: string;
  epoch: number;
  expiresAtMs: number;
}

export interface ClaimRuntimeBindingLeaseInput {
  bindingId: string;
  ownerId: string;
  ttlMs: number;
  processInstanceId: string;
}

export interface RenewRuntimeBindingLeaseInput {
  lease: RuntimeBindingLease;
  ttlMs: number;
}

export interface TransitionRuntimeBindingInput {
  lease: RuntimeBindingLease;
  expectedStateVersion: number;
  status: RuntimeBindingStatus;
  processInstanceId?: string;
  sessionId?: string;
  clearSession?: boolean;
  closeReason?: string;
}

export interface RuntimeBindingInvocationContext {
  binding: RuntimeBinding;
  topic: CouncilTopicContext;
  firstTurn: boolean;
  consumedCursor?: RuntimeBindingCursor;
}

export interface FinalizeRuntimeBindingCloseInput {
  bindingId: string;
  expectedStateVersion: number;
  processInstanceId?: string;
  closeReason?: string;
}

export interface ListRunsForTopicInput {
  topicId: string;
  limit: number;
  offset: number;
}

export interface ListRestartCandidatesInput {
  limit: number;
  offset: number;
}

export interface PaginatedRuns {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  runs: readonly OrchestrationRun[];
}

/** 只包含执行所有权凭据；不得通过 REST 或日志公开。 */
export interface RunLease {
  runId: string;
  ownerId: string;
  token: string;
  epoch: number;
  expiresAtMs: number;
}

export interface ClaimRunLeaseInput {
  runId: string;
  ownerId: string;
  ttlMs: number;
}

export interface RenewRunLeaseInput {
  lease: RunLease;
  ttlMs: number;
}

export interface ExecutionLeaseRequest {
  ownerId: string;
  ttlMs: number;
  renewIntervalMs: number;
}

export type RestartDisposition =
  | "resume_running"
  | "fail_interrupted_agent"
  | "await_user"
  | "ignore";

export interface AgentInvocation {
  runId: string;
  topicId: string;
  roundNumber: number;
  attempt: number;
  adapterId: string;
  actorId: ActorId;
  runtimeBindingId: string;
  requestMessageId?: string;
  sessionId?: string;
  firstTurn: boolean;
  instruction: string;
  messageKind: MessageKind;
  context: CouncilTopicContext;
}

export interface AgentInvocationOptions {
  signal: AbortSignal;
  notifyStreaming?: () => void;
  runtimeEvents?: import("./runtime/contracts.js").RuntimeEventSink;
}

export interface AgentResult {
  content: string;
  sessionId?: string;
}

export interface RoundCommitInput {
  expectedVersion: number;
  lease: RunLease;
  bindingLease: RuntimeBindingLease;
  run: OrchestrationRun;
  bindingSessionId?: string;
  consumedCursor?: RuntimeBindingCursor;
  message: {
    topicId: string;
    actorId: ActorId;
    kind: MessageKind;
    content: string;
  };
}

export interface RoundCommitResult {
  run: OrchestrationRun;
  message: CouncilPublicMessage;
}

export interface ApproveGateInput {
  runId: string;
  expectedGateId: string;
  expectedVersion: number;
  approvalId: string;
  approvedByActorId: ActorId;
}

export interface ApproveGateResult {
  run: OrchestrationRun;
  applied: boolean;
}
