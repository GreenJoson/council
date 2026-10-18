/**
 * @input  依赖：无
 * @output 导出：Council Web 的动态 Actor、含关闭态的 Topic/Message/Decision/实施项（v18 任务：
 *         kind/source/priority/brief、可选 topicId）行快照、任务类型与来源常量、
 *         人工 Accepted 输入、superseded/decidedAt 与仓储边界类型；Message 可带原始 ISO createdAt 供按时间归属 Run
 * @pos    前端状态和后续本地 API 之间的稳定领域模型；DecisionStatus 与 CouncilDecision
 *         同时供讨论面板、决策包、决策记录与架构档案四处消费
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

export type TopicStatus = "open" | "proposed" | "discussing" | "synthesis" | "decided" | "closed";

export type DecisionStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type WorkItemStatus = "pending" | "in_progress" | "blocked" | "completed";
export type WorkItemOrigin = "manual" | "review_finding";
export type WorkItemSeverity = "blocking" | "non_blocking";

/**
 * v18 任务产出类型与来源。Web 是独立包，不能 import mcp-server 的常量，
 * 所以这里保留一份与服务端 WORK_ITEM_KINDS / WORK_ITEM_SOURCES 同值的副本；
 * 服务端增删取值时必须同步这里，否则严格 parser 会拒绝新值。
 */
export const WORK_ITEM_KINDS = ["code", "image", "prototype", "research", "pipeline"] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
export const WORK_ITEM_SOURCES = ["topic", "direct", "pipeline"] as const;
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number];

/**
 * 议题实施完成度。分母只数叶子节点——父任务状态由子任务派生，
 * 把它也计进去等于同一件事数两次。
 */
export interface WorkItemProgress {
  total: number;
  completed: number;
  blocked: number;
  openBlockingFindings: number;
}

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
  /**
   * 议题导航要在不拉取每个议题详情的前提下显示「12 / 15」，只能由列表接口带下来。
   * 没有实施项的议题不带这个字段，导航据此区分「还没拆」和「一条都没做完」。
   */
  workItemProgress?: WorkItemProgress;
}

export interface CouncilMessage {
  id: string;
  author: AgentId;
  actorSnapshot: ActorSnapshot;
  kind: MessageKind;
  title: string;
  content: string;
  createdLabel: string;
  /** 原始 ISO 时间；同题盲答按它把回答归到对应 Run。静态 mock 数据可缺省 */
  createdAt?: string;
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
  id: string;
  title: string;
  summary: string;
  rationale: string;
  status: DecisionStatus;
  proposedBy: AgentId;
  proposedBySnapshot: ActorSnapshot;
  createdAt: string;
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

export interface CouncilWorkItem {
  id: string;
  /** v18 起直接任务不挂议题；议题内实施项总是带它。 */
  topicId?: string;
  kind: WorkItemKind;
  source: WorkItemSource;
  /** 看板排序用的整数优先级，越大越靠前；服务端默认 0。 */
  priority: number;
  projectPath?: string;
  /** 任务简报：结构由任务类型决定，前端只做 record 校验、不解释内部字段。 */
  brief?: Record<string, unknown>;
  /** 审核发现可以先于决策存在，因此锚点是可选的。 */
  decisionId?: string;
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
  reviewRound?: number;
  fixCommit?: string;
  assignee?: AgentId;
  claimedLabel?: string;
  createdBy: AgentId;
  createdBySnapshot: ActorSnapshot;
  updatedBy: AgentId;
  updatedBySnapshot: ActorSnapshot;
  createdLabel: string;
  updatedLabel: string;
  completedLabel?: string;
}

export interface RecordManualDecisionInput {
  topicId: string;
  title: string;
  summary: string;
  rationale: string;
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
  workItems: CouncilWorkItem[];
  /** 当前议题的完整决策包；按创建时间升序，任何状态都不得静默丢弃。 */
  decisions: CouncilDecision[];
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

export interface AddWorkItemsInput {
  topicId: string;
  decisionId?: string;
  /** 给了就挂成子任务；决策锚点继承自父任务。 */
  parentId?: string;
  items: Array<{ title: string; details?: string }>;
}

export interface UpdateWorkItemInput {
  topicId: string;
  workItemId: string;
  status: WorkItemStatus;
  statusNote?: string;
  fixCommit?: string;
  expectedVersion: number;
}

export interface ClaimWorkItemInput {
  topicId: string;
  workItemId: string;
  statusNote?: string;
  expectedVersion: number;
}
