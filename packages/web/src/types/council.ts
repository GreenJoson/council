/**
 * @input  依赖：无
 * @output 导出：Council Web 的议题、消息、决策与仓储边界类型
 * @pos    前端状态和后续本地 API 之间的稳定领域模型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type AgentId = "claude" | "codex" | "user" | "chair";

export type MessageKind =
  | "proposal"
  | "critique"
  | "rebuttal"
  | "synthesis"
  | "note";

export type TopicStatus = "proposed" | "discussing" | "synthesis" | "decided";

export type DecisionStatus = "proposed" | "accepted";

export interface Participant {
  id: AgentId;
  name: string;
  shortName: string;
  role: string;
}

export interface TopicSummary {
  id: string;
  title: string;
  status: TopicStatus;
  updatedLabel: string;
  unreadCount?: number;
}

export interface MessageAttachment {
  name: string;
  meta: string;
}

export interface CouncilMessage {
  id: string;
  author: AgentId;
  kind: MessageKind;
  title: string;
  content: string;
  createdLabel: string;
  attachment?: MessageAttachment;
}

export interface ConstraintItem {
  id: string;
  label: string;
  tone: "positive" | "warning";
}

export interface EvidenceItem {
  id: string;
  label: string;
  meta: string;
}

export interface AlternativeItem {
  id: string;
  title: string;
  author: AgentId;
  createdLabel: string;
}

export interface CouncilDecision {
  title: string;
  summary: string;
  rationale: string;
  status: DecisionStatus;
  proposedBy: AgentId;
}

export interface TopicDetail extends TopicSummary {
  question: string;
  createdLabel: string;
  owner: AgentId;
  participants: AgentId[];
  messages: CouncilMessage[];
  constraints: ConstraintItem[];
  evidence: EvidenceItem[];
  alternatives: AlternativeItem[];
  decision: CouncilDecision;
}

export interface ProjectSummary {
  id: string;
  name: string;
}

export interface SyncState {
  status: "connected" | "syncing" | "offline";
  label: string;
}

export interface WorkspaceSnapshot {
  project: ProjectSummary;
  topics: TopicDetail[];
  participants: Participant[];
  sync: SyncState;
}

export interface PublishMessageInput {
  topicId: string;
  author: AgentId;
  kind: MessageKind;
  content: string;
}

export interface CreateTopicInput {
  title: string;
  question: string;
  constraints: string[];
}
