/**
 * @input  依赖：constants.ts 的协议枚举
 * @output 导出：议题、消息、决策、实施项树/完成度与含 schema 迁移策略的配置类型
 * @pos    MCP 服务的共享类型边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  DECISION_STATUSES,
  MESSAGE_KINDS,
  TOPIC_STATUSES,
  WORK_ITEM_ORIGINS,
  WORK_ITEM_SEVERITIES,
  WORK_ITEM_STATUSES,
} from "./constants.js";
import type { ActorId, ActorSnapshot } from "./actor-identity.js";

export type TopicStatus = (typeof TOPIC_STATUSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type WorkItemOrigin = (typeof WORK_ITEM_ORIGINS)[number];
export type WorkItemSeverity = (typeof WORK_ITEM_SEVERITIES)[number];

export interface CouncilConfig {
  dataDir: string;
  databasePath: string;
  claudeCommand: string;
  claudeArgs: string[];
  claudeModel?: string;
  claudePermissionMode: "plan";
  claudeTimeoutMs: number;
  claudeKillGraceMs: number;
  claudeMaxTurns: number;
  codexCommand: string;
  codexArgs: string[];
  codexModel?: string;
  codexSandboxMode: "read-only";
  codexTimeoutMs: number;
  codexKillGraceMs: number;
  kimiAcpCommand: string;
  geminiAcpCommand: string;
  grokAcpCommand: string;
  codexAcpCommand: string;
  claudeAcpCommand: string;
  acpStartupTimeoutMs: number;
  acpKillGraceMs: number;
  acpMaxFileReadChars: number;
  toolLoopMaxSteps: number;
  toolLoopMaxContextChars: number;
  toolLoopMaxFileBytes: number;
  toolLoopMaxScanFiles: number;
  gitCommand: string;
  gitDiffTimeoutMs: number;
  gitDiffKillGraceMs: number;
  gitDiffMaxFiles: number;
  gitDiffMaxLines: number;
  gitDiffMaxHunksPerFile: number;
  gitDiffMaxOutputChars: number;
  delegationWorktreeRoot: string;
  delegationRetryDelayMs: number;
  keychainCommand?: string;
  sqliteBusyTimeoutMs: number;
  schemaMigrationMaxAttempts: number;
  maxContextChars: number;
  maxOutputChars: number;
  defaultMessageLimit: number;
}

export interface McpCouncilConfig extends CouncilConfig {
  callerActorAlias: string;
}

export interface CouncilHttpConfig {
  databasePath: string;
  sqliteBusyTimeoutMs: number;
  schemaMigrationMaxAttempts: number;
  defaultMessageLimit: number;
  host: string;
  port: number;
  allowedOrigins: string[];
  corsMaxAgeSeconds: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  bodyLimitBytes: number;
  eventPollMs: number;
  eventRetryMs: number;
  eventHeartbeatMs: number;
  shutdownTimeoutMs: number;
  orchestrationLeaseTtlMs: number;
  orchestrationLeaseRenewMs: number;
  orchestrationSweepIntervalMs: number;
  orchestrationDefaultMaxRounds: number;
  orchestrationDefaultMaxAttempts: number;
  orchestrationDefaultMaxRecoveries: number;
  orchestrationDefaultAgentIdleTimeoutMs: number;
  orchestrationDefaultAgentTimeoutMs: number;
  orchestrationAgentCleanupTimeoutMs: number;
  orchestrationConfirmCompletion: boolean;
  orchestrationRunPageLimit: number;
  orchestrationStartupScanLimit: number;
  orchestrationShutdownTimeoutMs: number;
  runtimeBindingIdleTimeoutMs: number;
}

export interface Topic {
  id: string;
  title: string;
  question: string;
  constraints: string[];
  projectPath?: string;
  status: TopicStatus;
  createdByActorId: ActorId;
  createdBySnapshot: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
  /**
   * 议题的实施完成度。不是 topics 表的列，而是列表查询顺带聚合出来的派生属性——
   * 议题导航要在不拉取每个议题详情的前提下显示「12 / 15」，只能由查询侧算好带下来。
   */
  workItemProgress?: WorkItemProgress;
}

export interface CouncilMessage {
  id: string;
  topicId: string;
  actorId: ActorId;
  actorSnapshot: ActorSnapshot;
  kind: MessageKind;
  content: string;
  parentMessageId?: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  topicId: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  status: DecisionStatus;
  createdByActorId: ActorId;
  createdBySnapshot: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  topicId: string;
  /** 审核发现可以在议题还没有 Accepted 决策时就落库，因此锚点放宽为可选。 */
  decisionId?: string;
  /** 顶层任务没有父级；子任务随父级级联删除。 */
  parentId?: string;
  title: string;
  details: string;
  status: WorkItemStatus;
  statusNote?: string;
  version: number;
  sortOrder: number;
  origin: WorkItemOrigin;
  severity?: WorkItemSeverity;
  /** 产出这条发现的那次评审发言，用于从任务跳回原始论据。 */
  sourceMessageId?: string;
  sourceCycleId?: string;
  reviewRound?: number;
  /** 修复证据：外部 Agent 改完代码后回写的 commit。 */
  fixCommit?: string;
  assigneeActorId?: ActorId;
  claimedAt?: string;
  createdByActorId: ActorId;
  createdBySnapshot: ActorSnapshot;
  updatedByActorId: ActorId;
  updatedBySnapshot: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * 议题级完成度。父任务状态由子任务派生，计入分母的只有叶子节点——
 * 否则一个两层拆解会把同一件事数两次。
 */
export interface WorkItemProgress {
  total: number;
  completed: number;
  blocked: number;
  openBlockingFindings: number;
}

export interface TopicDetail {
  topic: Topic;
  messages: CouncilMessage[];
  decisions: Decision[];
  workItems: WorkItem[];
  messageTotal: number;
  messageLimit: number;
  messageOffset: number;
  hasMoreMessages: boolean;
  nextMessageOffset?: number;
}

export interface PaginatedTopics {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  topics: Topic[];
}

export interface ClaudeResponse {
  content: string;
  sessionId?: string;
  model?: string;
}

export interface CodexResponse {
  content: string;
  sessionId?: string;
}
