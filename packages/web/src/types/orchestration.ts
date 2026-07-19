/**
 * @input  依赖：Council 自动轮次公开协议
 * @output 导出：Capabilities、Run、计划输入和独立快照类型
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

export type OrchestrationPublicAuthor = "human" | "claude" | "codex" | "chair" | "other";

export interface OrchestrationAdapter {
  id: string;
  publicAuthor: OrchestrationPublicAuthor;
  label: string;
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
  publicAuthor: OrchestrationPublicAuthor;
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

export interface CreateOrchestrationRunInput {
  topicId: string;
  plan: Array<{
    adapterId: string;
    messageKind: OrchestrationMessageKind;
    instruction: string;
  }>;
}

export interface ApproveOrchestrationRunInput {
  runId: string;
  expectedGateId: string;
  expectedVersion: number;
  approvalId: string;
}

export interface OrchestrationSnapshot {
  capabilities?: OrchestrationCapabilities;
  activeTopicId?: string;
  runs: OrchestrationRun[];
  sync: {
    status: "connected" | "syncing" | "offline";
    label: string;
  };
}
