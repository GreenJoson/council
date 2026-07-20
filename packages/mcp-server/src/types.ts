/**
 * @input  依赖：constants.ts 的协议枚举
 * @output 导出：议题、消息、决策与配置类型
 * @pos    MCP 服务的共享类型边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AUTHORS,
  DECISION_STATUSES,
  MESSAGE_KINDS,
  TOPIC_STATUSES,
} from "./constants.js";

export type TopicStatus = (typeof TOPIC_STATUSES)[number];
export type Author = (typeof AUTHORS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

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
  sqliteBusyTimeoutMs: number;
  maxContextChars: number;
  maxOutputChars: number;
  defaultMessageLimit: number;
}

export interface CouncilHttpConfig {
  databasePath: string;
  sqliteBusyTimeoutMs: number;
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
  orchestrationDefaultAgentTimeoutMs: number;
  orchestrationAgentCleanupTimeoutMs: number;
  orchestrationConfirmCompletion: boolean;
  orchestrationRunPageLimit: number;
  orchestrationStartupScanLimit: number;
  orchestrationShutdownTimeoutMs: number;
}

export interface Topic {
  id: string;
  title: string;
  question: string;
  constraints: string[];
  projectPath?: string;
  status: TopicStatus;
  createdBy: Author;
  createdAt: string;
  updatedAt: string;
}

export interface CouncilMessage {
  id: string;
  topicId: string;
  author: Author;
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
  createdBy: Author;
  createdAt: string;
  updatedAt: string;
}

export interface TopicDetail {
  topic: Topic;
  messages: CouncilMessage[];
  decisions: Decision[];
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
