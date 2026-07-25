/**
 * @input  依赖：Council 动态 Actor 编排公开协议
 * @output 导出：含 actorId 的 Capabilities、Run、持久会话状态、Agent 临时草稿和独立快照类型
 * @pos    Web 自动轮次 UI 与 OrchestrationRepository 的稳定领域模型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
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
}

export interface OrchestrationDefaultPolicy {
  maxRounds: number;
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
}

export interface DiscussionCycle {
  id: string;
  topicId: string;
  stage: CycleStage;
  status: "active" | "completed" | "abandoned";
  /** 开局冻结的名册；首位是提案人。 */
  participants: string[];
  turns: CycleTurn[];
  roundBudget: number;
  currentRound: number;
  proposedDecisionId?: string;
  stopReason?: string;
}

export interface CycleBlockingQuestion {
  id: string;
  askedByActorId: string;
  question: string;
  rationale: string;
  options: string[];
  questionMessageId: string;
}

export interface DiscussionCycleView {
  cycle: DiscussionCycle;
  openQuestion?: CycleBlockingQuestion;
}

export interface StartCycleInput {
  topicId: string;
  participants: string[];
  roundBudget?: number;
}

export interface AnswerCycleQuestionInput {
  topicId: string;
  questionMessageId: string;
  /** 回答正文；服务端会以用户身份发成公开消息并挂在提问下面。 */
  content: string;
}

export interface OrchestrationSnapshot {
  capabilities?: OrchestrationCapabilities;
  activeTopicId?: string;
  runs: OrchestrationRun[];
  /** 当前议题的活动圆桌；null 表示确认过没有，undefined 表示还没读到。 */
  cycle?: DiscussionCycleView | null;
  runtimeBindings?: RuntimeBinding[];
  agentOutputs?: OrchestrationAgentOutput[];
  sync: {
    status: "connected" | "syncing" | "offline";
    label: string;
  };
}
