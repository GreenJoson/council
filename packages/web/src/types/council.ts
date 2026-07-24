/**
 * @input  依赖：无
 * @output 导出：Council Web 的动态 Actor、Topic/Message/Decision 行快照、
 *         superseded/decidedAt 与仓储边界类型
 * @pos    前端状态和后续本地 API 之间的稳定领域模型；DecisionStatus 与 CouncilDecision
 *         同时供讨论面板、决策记录与架构档案三处消费
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type AgentId = string;

export type MessageKind =
  | "proposal"
  | "critique"
  | "rebuttal"
  | "synthesis"
  | "note";

export type TopicStatus = "open" | "proposed" | "discussing" | "synthesis" | "decided";

export type DecisionStatus = "proposed" | "accepted" | "superseded";

export interface Participant {
  id: AgentId;
  slug: string;
  name: string;
  shortName: string;
  role: string;
}

export interface ActorSnapshot {
  schemaVersion: 1;
  actorId: AgentId;
  slug: string;
  displayName: string;
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

export interface CouncilMessage {
  id: string;
  author: AgentId;
  actorSnapshot: ActorSnapshot;
  kind: MessageKind;
  title: string;
  content: string;
  createdLabel: string;
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
  authorSnapshot?: ActorSnapshot;
  createdLabel: string;
}

export interface CouncilDecision {
  title: string;
  summary: string;
  rationale: string;
  status: DecisionStatus;
  proposedBy: AgentId;
  proposedBySnapshot: ActorSnapshot;
  /**
   * 决策进入 accepted/superseded 状态的时间（ISO 8601）；仍是 proposed 时留空。
   * 架构档案时间线用它生成稳定的 ADR 编号——编号按"最初被接受的时间"升序分配，
   * 之后即使决策被取代也不会重新排序，所以取代动作发生时不应改写这个值。
   */
  decidedAt?: string;
  /**
   * 若此决策已被取代，指向取代它的新议题 id，用于渲染"已被 ADR-xxx 取代"徽章并支持跳转。
   * 目前只有 mock/本地数据会显式关联这层取代关系——真实 HTTP/Native 后端的决策记录里
   * 没有存储"谁取代了谁"的外键，所以该字段在那两种模式下始终是 undefined（见
   * workspace-mapper.ts 顶部注释），UI 需要在缺省时优雅降级为"仅显示已取代状态，不提供跳转"。
   */
  supersededByTopicId?: string;
}

export interface TopicDetail extends TopicSummary {
  question: string;
  createdLabel: string;
  owner: AgentId;
  ownerSnapshot: ActorSnapshot;
  participants: AgentId[];
  messages: CouncilMessage[];
  messageTotal?: number;
  constraints: ConstraintItem[];
  evidence: EvidenceItem[];
  alternatives: AlternativeItem[];
  decision?: CouncilDecision;
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
  activeTopicId?: string;
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
