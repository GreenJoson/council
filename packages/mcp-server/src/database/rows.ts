/**
 * @input  依赖：Actor 快照解析与领域类型
 * @output 导出：topics/messages/decisions/work_items（含 v18 任务列）/assets/asset_links/actor_identities 等表的行接口、
 *         行 → 领域对象的映射函数、实施项叶子完成度汇总与父状态派生规则
 * @pos    database/ 各仓储共享的纯映射层，不持有连接；快照与索引身份不一致时直接抛错，不做修复
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { parseActorSnapshot, type ActorIdentity } from "../actor-identity.js";
import type {
  Asset,
  AssetKind,
  AssetLink,
  AssetLinkRole,
  AssetLinkTargetKind,
  CouncilMessage,
  Decision,
  DecisionStatus,
  MessageKind,
  Topic,
  TopicStatus,
  WorkItem,
  WorkItemKind,
  WorkItemOrigin,
  WorkItemProgress,
  WorkItemSeverity,
  WorkItemSource,
  WorkItemStatus,
} from "../types.js";

export interface TopicRow {
  id: string;
  title: string;
  question: string;
  constraints_json: string;
  project_path: string | null;
  status: TopicStatus;
  created_by_actor_id: string;
  created_by_snapshot_json: string;
  created_by_legacy: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  topic_id: string;
  author_actor_id: string;
  author_snapshot_json: string;
  author_legacy: string | null;
  kind: MessageKind;
  content: string;
  parent_message_id: string | null;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  topic_id: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives_json: string;
  status: DecisionStatus;
  created_by_actor_id: string;
  created_by_snapshot_json: string;
  created_by_legacy: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemRow {
  id: string;
  /** v18 起可空：非议题任务没有议题。 */
  topic_id: string | null;
  decision_id: string | null;
  title: string;
  details: string;
  status: WorkItemStatus;
  status_note: string | null;
  version: number;
  created_by_actor_id: string;
  created_by_snapshot_json: string;
  updated_by_actor_id: string;
  updated_by_snapshot_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  parent_id: string | null;
  sort_order: number;
  origin: WorkItemOrigin;
  severity: WorkItemSeverity | null;
  source_message_id: string | null;
  source_cycle_id: string | null;
  review_round: number | null;
  fix_commit: string | null;
  assignee_actor_id: string | null;
  claimed_at: string | null;
  kind: WorkItemKind;
  source: WorkItemSource;
  priority: number;
  project_path: string | null;
  brief_json: string | null;
}

export interface WorkItemProgressRow {
  topic_id: string;
  total: number;
  completed: number;
  blocked: number;
  open_blocking: number;
}

export interface DecisionReferenceRow {
  id: string;
  status: DecisionStatus;
}

export interface CountRow {
  count: number;
}

export interface SessionRow {
  session_id: string;
}

export interface ActorIdentityRow {
  id: string;
  slug: string;
  display_name: string;
  short_name: string;
  role: string;
  actor_type: ActorIdentity["actorType"];
  status: ActorIdentity["status"];
}

export interface RevisionRow {
  key: string;
  value: number;
}

export function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function topicFromRow(row: TopicRow): Topic {
  const createdBySnapshot = parseActorSnapshot(row.created_by_snapshot_json);
  if (createdBySnapshot.actorId !== row.created_by_actor_id) {
    throw new Error("Topic Actor snapshot 与索引身份不一致。");
  }
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    constraints: parseStringArray(row.constraints_json),
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    status: row.status,
    createdByActorId: row.created_by_actor_id,
    createdBySnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function messageFromRow(row: MessageRow): CouncilMessage {
  const actorSnapshot = parseActorSnapshot(row.author_snapshot_json);
  if (actorSnapshot.actorId !== row.author_actor_id) {
    throw new Error("Message Actor snapshot 与索引身份不一致。");
  }
  return {
    id: row.id,
    topicId: row.topic_id,
    actorId: row.author_actor_id,
    actorSnapshot,
    kind: row.kind,
    content: row.content,
    ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
    createdAt: row.created_at,
  };
}

export function decisionFromRow(row: DecisionRow): Decision {
  const createdBySnapshot = parseActorSnapshot(row.created_by_snapshot_json);
  if (createdBySnapshot.actorId !== row.created_by_actor_id) {
    throw new Error("Decision Actor snapshot 与索引身份不一致。");
  }
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    decision: row.decision,
    rationale: row.rationale,
    alternatives: parseStringArray(row.alternatives_json),
    status: row.status,
    createdByActorId: row.created_by_actor_id,
    createdBySnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 父任务状态的派生规则。顺序即优先级：
 * 有子任务受阻就是受阻（先解依赖），全部完成才算完成，
 * 只要有人动过（进行中或已完成一部分）就是进行中，否则待处理。
 */
/** 与 WorkItemRepository.readProgress 的 SQL 同口径：只数叶子。两处必须一起改。 */
export function summarizeWorkItemProgress(
  topicId: string,
  rows: readonly WorkItemRow[],
): Map<string, WorkItemProgress> {
  const parentIds = new Set(
    rows.map((row) => row.parent_id).filter((id): id is string => Boolean(id)),
  );
  const leaves = rows.filter((row) => !parentIds.has(row.id));
  if (leaves.length === 0) {
    return new Map();
  }
  return new Map([[topicId, {
    total: leaves.length,
    completed: leaves.filter((row) => row.status === "completed").length,
    blocked: leaves.filter((row) => row.status === "blocked").length,
    openBlockingFindings: leaves.filter(
      (row) =>
        row.origin === "review_finding"
        && row.severity === "blocking"
        && row.status !== "completed",
    ).length,
  }]]);
}

export function withWorkItemProgress(
  topic: Topic,
  progress: ReadonlyMap<string, WorkItemProgress>,
): Topic {
  const summary = progress.get(topic.id);
  // 没有实施项的议题不带这个字段：议题导航据此区分「还没拆」和「0 / N」，
  // 前者不该在列表里显示一个毫无信息量的 0/0 徽章。
  return summary ? { ...topic, workItemProgress: summary } : topic;
}

export function deriveParentStatus(
  childStatuses: readonly WorkItemStatus[],
): WorkItemStatus {
  if (childStatuses.some((status) => status === "blocked")) {
    return "blocked";
  }
  if (childStatuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (
    childStatuses.some(
      (status) => status === "in_progress" || status === "completed",
    )
  ) {
    return "in_progress";
  }
  return "pending";
}

// schema 的 CHECK 已保证 brief_json 是 JSON 对象；这里仍做形状校验，坏数据直接抛错而不是静默丢弃。
function parseWorkItemBrief(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Work item brief_json 不是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

export function workItemFromRow(row: WorkItemRow): WorkItem {
  const createdBySnapshot = parseActorSnapshot(row.created_by_snapshot_json);
  const updatedBySnapshot = parseActorSnapshot(row.updated_by_snapshot_json);
  if (createdBySnapshot.actorId !== row.created_by_actor_id) {
    throw new Error("Work item 创建者快照与索引身份不一致。");
  }
  if (updatedBySnapshot.actorId !== row.updated_by_actor_id) {
    throw new Error("Work item 更新者快照与索引身份不一致。");
  }
  return {
    id: row.id,
    ...(row.topic_id ? { topicId: row.topic_id } : {}),
    kind: row.kind,
    source: row.source,
    priority: row.priority,
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    ...(row.brief_json === null ? {} : { brief: parseWorkItemBrief(row.brief_json) }),
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    title: row.title,
    details: row.details,
    status: row.status,
    ...(row.status_note ? { statusNote: row.status_note } : {}),
    version: row.version,
    sortOrder: row.sort_order,
    origin: row.origin,
    ...(row.severity ? { severity: row.severity } : {}),
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.source_cycle_id ? { sourceCycleId: row.source_cycle_id } : {}),
    ...(row.review_round === null ? {} : { reviewRound: row.review_round }),
    ...(row.fix_commit ? { fixCommit: row.fix_commit } : {}),
    ...(row.assignee_actor_id ? { assigneeActorId: row.assignee_actor_id } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    createdByActorId: row.created_by_actor_id,
    createdBySnapshot,
    updatedByActorId: row.updated_by_actor_id,
    updatedBySnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

// v19 资产：行接口只给仓储用；storage_rel_path 只出现在 AssetRow，不进公开 DTO。
export interface AssetRow {
  id: string;
  project_path: string;
  kind: AssetKind;
  mime: string;
  byte_size: number;
  sha256: string;
  storage_rel_path: string;
  width: number | null;
  height: number | null;
  origin_delegation_id: string | null;
  origin_actor_id: string | null;
  prompt: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface AssetLinkRow {
  asset_id: string;
  target_kind: AssetLinkTargetKind;
  target_id: string;
  role: AssetLinkRole;
  created_at: string;
}

export function assetLinkFromRow(row: AssetLinkRow): AssetLink {
  return {
    targetKind: row.target_kind,
    targetId: row.target_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function assetFromRow(row: AssetRow, links: readonly AssetLinkRow[]): Asset {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    byteSize: row.byte_size,
    sha256: row.sha256,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    ...(row.prompt === null ? {} : { prompt: row.prompt }),
    origin: {
      ...(row.origin_delegation_id ? { delegationId: row.origin_delegation_id } : {}),
      ...(row.origin_actor_id ? { actorId: row.origin_actor_id } : {}),
    },
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    links: links.map(assetLinkFromRow),
  };
}

export function actorIdentityFromRow(row: ActorIdentityRow): ActorIdentity {
  return {
    schemaVersion: 1,
    actorId: row.id,
    slug: row.slug,
    displayName: row.display_name,
    shortName: row.short_name,
    role: row.role,
    actorType: row.actor_type,
    status: row.status,
  };
}
