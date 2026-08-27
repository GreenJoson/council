/**
 * @input  依赖：已由 Node 迁移器准备的 SQLite、领域类型与安全错误语义
 * @output 导出：动态 Actor alias/可信 actorId 写入、实施项树与派生父状态、议题完成度聚合、
 *         快照一致性、无损 Session 历史与 revision
 * @pos    双桌面客户端共享身份、内容和变更检测的数据访问层；身份漂移或停用时失败关闭
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CouncilConflictError, CouncilNotFoundError } from "./errors.js";
import {
  computeCycleMetrics,
  type CycleMetrics,
} from "./orchestration/cycle-metrics.js";
import {
  parseActorSnapshot,
  serializeActorSnapshot,
  toActorSnapshot,
  type ActorIdentity,
} from "./actor-identity.js";
import {
  assertCouncilSchema,
  migrateCouncilSchema,
  readCouncilDatabaseInstanceId,
  type CouncilMigrationOptions,
} from "./schema-migrator.js";
import type {
  CouncilMessage,
  Decision,
  DecisionStatus,
  MessageKind,
  PaginatedTopics,
  Topic,
  TopicDetail,
  TopicStatus,
  WorkItem,
  WorkItemOrigin,
  WorkItemProgress,
  WorkItemSeverity,
  WorkItemStatus,
} from "./types.js";

interface TopicRow {
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

interface MessageRow {
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

interface DecisionRow {
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

interface WorkItemRow {
  id: string;
  topic_id: string;
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
}

interface WorkItemProgressRow {
  topic_id: string;
  total: number;
  completed: number;
  blocked: number;
  open_blocking: number;
}

interface DecisionReferenceRow {
  id: string;
  status: DecisionStatus;
}

interface CountRow {
  count: number;
}

interface SessionRow {
  session_id: string;
}

interface ActorIdentityRow {
  id: string;
  slug: string;
  display_name: string;
  short_name: string;
  role: string;
  actor_type: ActorIdentity["actorType"];
  status: ActorIdentity["status"];
}

interface RevisionRow {
  key: string;
  value: number;
}

export interface CouncilRevisions {
  total: number;
  content: number;
  orchestration: number;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function topicFromRow(row: TopicRow): Topic {
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

function messageFromRow(row: MessageRow): CouncilMessage {
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

function decisionFromRow(row: DecisionRow): Decision {
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
/** 与 #readWorkItemProgress 的 SQL 同口径：只数叶子。两处必须一起改。 */
function summarizeWorkItemProgress(
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

function withWorkItemProgress(
  topic: Topic,
  progress: ReadonlyMap<string, WorkItemProgress>,
): Topic {
  const summary = progress.get(topic.id);
  // 没有实施项的议题不带这个字段：议题导航据此区分「还没拆」和「0 / N」，
  // 前者不该在列表里显示一个毫无信息量的 0/0 徽章。
  return summary ? { ...topic, workItemProgress: summary } : topic;
}

function deriveParentStatus(
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

function workItemFromRow(row: WorkItemRow): WorkItem {
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
    topicId: row.topic_id,
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

function actorIdentityFromRow(row: ActorIdentityRow): ActorIdentity {
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

export class CouncilDatabase {
  readonly #database: DatabaseSync;

  static async open(
    databasePath: string,
    busyTimeoutMs: number,
    migrationOptions: CouncilMigrationOptions,
  ): Promise<CouncilDatabase> {
    await migrateCouncilSchema(databasePath, busyTimeoutMs, migrationOptions);
    return new CouncilDatabase(databasePath, busyTimeoutMs);
  }

  constructor(databasePath: string, busyTimeoutMs: number) {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
      throw new Error("SQLite busy timeout 必须是正整数。");
    }
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#database.exec("PRAGMA synchronous = NORMAL;");
      this.#database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
      assertCouncilSchema(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  getDatabaseInstanceId(): string {
    return readCouncilDatabaseInstanceId(this.#database);
  }

  #activeActorById(actorId: string): ActorIdentity {
    const normalizedActorId = actorId.trim();
    if (!normalizedActorId) {
      throw new CouncilConflictError("Actor ID 不能为空。");
    }
    const row = this.#database.prepare(`
      SELECT id, slug, display_name, short_name, role, actor_type, status
      FROM actor_identities
      WHERE id = ?
    `).get(normalizedActorId) as unknown as ActorIdentityRow | undefined;
    if (!row || row.status !== "active") {
      throw new CouncilConflictError(
        `Actor ID ${normalizedActorId} 未注册或不可用于新写入。`,
      );
    }
    return actorIdentityFromRow(row);
  }

  resolveActorAlias(alias: string): ActorIdentity {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) {
      throw new CouncilConflictError("Actor alias 不能为空。");
    }
    const row = this.#database.prepare(`
      SELECT identities.id, identities.slug, identities.display_name,
             identities.short_name, identities.role,
             identities.actor_type, identities.status
      FROM actor_aliases AS aliases
      INNER JOIN actor_identities AS identities ON identities.id = aliases.actor_id
      WHERE aliases.alias = ? COLLATE NOCASE
    `).get(normalizedAlias) as unknown as ActorIdentityRow | undefined;
    if (!row || row.status !== "active") {
      throw new CouncilConflictError(
        `Actor alias ${normalizedAlias} 未注册或不可用于新写入。`,
      );
    }
    return actorIdentityFromRow(row);
  }

  createTopic(input: {
    title: string;
    question: string;
    constraints: string[];
    projectPath?: string;
    createdByAlias: string;
  }): Topic {
    const actor = this.resolveActorAlias(input.createdByAlias);
    return this.createTopicAsActor({
      title: input.title,
      question: input.question,
      constraints: input.constraints,
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      actorId: actor.actorId,
    });
  }

  createTopicAsActor(input: {
    title: string;
    question: string;
    constraints: string[];
    projectPath?: string;
    actorId: string;
  }): Topic {
    const id = `topic_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#transaction(() => {
      const actor = this.#activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      this.#database
        .prepare(`
          INSERT INTO topics (
            id, title, question, constraints_json, project_path,
            status, created_by_actor_id, created_by_snapshot_json,
            created_by_legacy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?, ?)
        `)
        .run(
          id,
          input.title,
          input.question,
          JSON.stringify(input.constraints),
          input.projectPath ?? null,
          actor.actorId,
          serializeActorSnapshot(actorSnapshot),
          now,
          now,
        );
      return this.getTopic(id);
    });
  }

  getTopic(topicId: string): Topic {
    const row = this.#database
      .prepare("SELECT * FROM topics WHERE id = ?")
      .get(topicId) as unknown as TopicRow | undefined;
    if (!row) {
      throw new CouncilNotFoundError(
        `议题 ${topicId} 不存在。请先调用 council_list_topics 或创建新议题。`,
      );
    }
    return topicFromRow(row);
  }

  getMessage(messageId: string): CouncilMessage {
    const row = this.#database
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as unknown as MessageRow | undefined;
    if (!row) {
      throw new CouncilNotFoundError(`消息 ${messageId} 不存在。`);
    }
    return messageFromRow(row);
  }

  /**
   * 找某条消息下由指定 Actor 发出的第一条回复。
   * 回答阻塞提问靠它做幂等：重试时先认领已经发出去的那条，而不是再发一条。
   */
  findReplyBy(parentMessageId: string, actorId: string): CouncilMessage | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM messages
        WHERE parent_message_id = ? AND author_actor_id = ?
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `)
      .get(parentMessageId, actorId) as unknown as MessageRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  getTopicDetail(topicId: string, messageLimit: number, messageOffset = 0): TopicDetail {
    const topic = this.getTopic(topicId);
    const messageCountRow = this.#database
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?")
      .get(topicId) as unknown as CountRow;
    const messageRows = this.#database
      .prepare(`
        SELECT * FROM (
          SELECT rowid AS internal_rowid, *
          FROM messages
          WHERE topic_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ? OFFSET ?
        ) ORDER BY created_at ASC, internal_rowid ASC
      `)
      .all(topicId, messageLimit, messageOffset) as unknown as MessageRow[];
    const decisionRows = this.#database
      .prepare("SELECT * FROM decisions WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(topicId) as unknown as DecisionRow[];
    const workItemRows = this.#database
      .prepare(`
        SELECT * FROM work_items
        WHERE topic_id = ?
        ORDER BY parent_key ASC, sort_order ASC, created_at ASC, rowid ASC
      `)
      .all(topicId) as unknown as WorkItemRow[];
    const nextMessageOffset = messageOffset + messageRows.length;
    const hasMoreMessages = nextMessageOffset < messageCountRow.count;
    return {
      // 详情已经手握全量实施项，就地汇总即可，不必为同一个数字再查一次库。
      topic: withWorkItemProgress(
        topic,
        summarizeWorkItemProgress(topicId, workItemRows),
      ),
      messages: messageRows.map(messageFromRow),
      decisions: decisionRows.map(decisionFromRow),
      workItems: workItemRows.map(workItemFromRow),
      messageTotal: messageCountRow.count,
      messageLimit,
      messageOffset,
      hasMoreMessages,
      ...(hasMoreMessages ? { nextMessageOffset } : {}),
    };
  }

  listTopics(input: {
    projectPath?: string;
    status?: TopicStatus;
    limit: number;
    offset: number;
  }): PaginatedTopics {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.projectPath) {
      conditions.push("project_path = ?");
      parameters.push(input.projectPath);
    }
    if (input.status) {
      conditions.push("status = ?");
      parameters.push(input.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countRow = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM topics ${where}`)
      .get(...parameters) as unknown as CountRow;
    const rows = this.#database
      .prepare(`SELECT * FROM topics ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...parameters, input.limit, input.offset) as unknown as TopicRow[];
    const nextOffset = input.offset + rows.length;
    const hasMore = nextOffset < countRow.count;
    const progress = this.#readWorkItemProgress(rows.map((row) => row.id));
    return {
      total: countRow.count,
      count: rows.length,
      offset: input.offset,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      topics: rows.map((row) => withWorkItemProgress(topicFromRow(row), progress)),
    };
  }

  createMessage(input: {
    topicId: string;
    actorAlias: string;
    kind: MessageKind;
    content: string;
    parentMessageId?: string;
  }): CouncilMessage {
    const actor = this.resolveActorAlias(input.actorAlias);
    return this.createMessageAsActor({
      topicId: input.topicId,
      actorId: actor.actorId,
      kind: input.kind,
      content: input.content,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    });
  }

  createMessageAsActor(input: {
    topicId: string;
    actorId: string;
    kind: MessageKind;
    content: string;
    parentMessageId?: string;
  }): CouncilMessage {
    const id = `message_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.getTopic(input.topicId);
      const actor = this.#activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      if (input.parentMessageId) {
        const parent = this.#database
          .prepare("SELECT topic_id FROM messages WHERE id = ?")
          .get(input.parentMessageId) as unknown as Pick<MessageRow, "topic_id"> | undefined;
        if (!parent) {
          throw new CouncilNotFoundError("父消息不存在，无法建立回复关系。");
        }
        if (parent.topic_id !== input.topicId) {
          throw new CouncilConflictError("父消息不属于当前议题，无法建立回复关系。");
        }
      }
      this.#database
        .prepare(`
          INSERT INTO messages (
            id, topic_id, author_actor_id, author_snapshot_json,
            author_legacy, kind, content, parent_message_id, created_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.topicId,
          actor.actorId,
          serializeActorSnapshot(actorSnapshot),
          input.kind,
          input.content,
          input.parentMessageId ?? null,
          now,
        );
      this.#database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(now, input.topicId);
      const row = this.#database
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(id) as unknown as MessageRow;
      return messageFromRow(row);
    });
  }

  createDecision(input: {
    topicId: string;
    title: string;
    decision: string;
    rationale: string;
    alternatives: string[];
    status: DecisionStatus;
    createdByAlias: string;
  }): Decision {
    const actor = this.resolveActorAlias(input.createdByAlias);
    return this.createDecisionAsActor({
      topicId: input.topicId,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale,
      alternatives: input.alternatives,
      status: input.status,
      actorId: actor.actorId,
    });
  }

  createDecisionAsActor(input: {
    topicId: string;
    title: string;
    decision: string;
    rationale: string;
    alternatives: string[];
    status: DecisionStatus;
    actorId: string;
  }): Decision {
    const id = `decision_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.getTopic(input.topicId);
      const actor = this.#activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      if (input.status === "accepted" && actor.actorId !== "human") {
        throw new CouncilConflictError("Accepted 决策必须由用户确认。");
      }
      this.#database
        .prepare(`
          INSERT INTO decisions (
            id, topic_id, title, decision, rationale, alternatives_json,
            status, created_by_actor_id, created_by_snapshot_json,
            created_by_legacy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `)
        .run(
          id,
          input.topicId,
          input.title,
          input.decision,
          input.rationale,
          JSON.stringify(input.alternatives),
          input.status,
          actor.actorId,
          serializeActorSnapshot(actorSnapshot),
          now,
          now,
        );
      const topicStatus: TopicStatus = input.status === "accepted" ? "decided" : "open";
      this.#database
        .prepare("UPDATE topics SET status = ?, updated_at = ? WHERE id = ?")
        .run(topicStatus, now, input.topicId);
      const row = this.#database
        .prepare("SELECT * FROM decisions WHERE id = ?")
        .get(id) as unknown as DecisionRow;
      return decisionFromRow(row);
    });
  }

  /**
   * 只统计叶子节点：父任务的状态本来就是子任务汇总出来的，
   * 再把它计入分母等于同一件事数两次，界面上的「12 / 15」会凭空变大。
   */
  #readWorkItemProgress(topicIds: readonly string[]): Map<string, WorkItemProgress> {
    const progress = new Map<string, WorkItemProgress>();
    if (topicIds.length === 0) {
      return progress;
    }
    const placeholders = topicIds.map(() => "?").join(", ");
    const rows = this.#database.prepare(`
      SELECT
        topic_id,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(
          CASE
            WHEN origin = 'review_finding'
              AND severity = 'blocking'
              AND status <> 'completed'
            THEN 1 ELSE 0
          END
        ) AS open_blocking
      FROM work_items AS item
      WHERE topic_id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM work_items AS child WHERE child.parent_id = item.id
        )
      GROUP BY topic_id
    `).all(...topicIds) as unknown as WorkItemProgressRow[];
    for (const row of rows) {
      progress.set(row.topic_id, {
        total: row.total,
        completed: row.completed,
        blocked: row.blocked,
        openBlockingFindings: row.open_blocking,
      });
    }
    return progress;
  }

  createWorkItems(input: {
    topicId: string;
    decisionId?: string;
    parentId?: string;
    items: Array<{ title: string; details?: string }>;
    createdByAlias: string;
  }): WorkItem[] {
    const actor = this.resolveActorAlias(input.createdByAlias);
    return this.createWorkItemsAsActor({
      topicId: input.topicId,
      ...(input.decisionId ? { decisionId: input.decisionId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      items: input.items,
      actorId: actor.actorId,
    });
  }

  createWorkItemsAsActor(input: {
    topicId: string;
    decisionId?: string;
    /** 给了就挂到这个父任务下；父任务的决策锚点会被继承。 */
    parentId?: string;
    origin?: WorkItemOrigin;
    sourceCycleId?: string;
    reviewRound?: number;
    items: Array<{
      title: string;
      details?: string;
      severity?: WorkItemSeverity;
      sourceMessageId?: string;
    }>;
    actorId: string;
  }): WorkItem[] {
    if (input.items.length === 0) {
      throw new CouncilConflictError("至少需要一个实施项。");
    }
    const origin: WorkItemOrigin = input.origin ?? "manual";
    const normalizedItems = input.items.map((item) => ({
      title: item.title.trim(),
      details: item.details?.trim() ?? "",
      severity: item.severity,
      sourceMessageId: item.sourceMessageId,
    }));
    if (normalizedItems.some((item) => !item.title)) {
      throw new CouncilConflictError("实施项标题不能为空。");
    }
    if (origin === "review_finding" && normalizedItems.some((item) => !item.severity)) {
      throw new CouncilConflictError("审核发现必须声明 blocking 或 non_blocking。");
    }
    const normalizedTitles = new Set(normalizedItems.map((item) => item.title.toLowerCase()));
    if (normalizedTitles.size !== normalizedItems.length) {
      throw new CouncilConflictError("同一批实施项不能包含重复标题。");
    }

    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.getTopic(input.topicId);
      const actor = this.#activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      const actorSnapshotJson = serializeActorSnapshot(actorSnapshot);

      const parent = input.parentId
        ? this.#requireWorkItem(input.parentId, input.topicId)
        : undefined;
      const decisionId = parent
        // 子任务不自己选决策：它属于父任务所属的那次决策，否则一棵树会横跨两个 ADR。
        ? parent.decision_id
        : this.#resolveWorkItemDecisionId(input.topicId, input.decisionId, origin);

      const duplicateQuery = this.#database.prepare(`
        SELECT id FROM work_items
        WHERE topic_id = ? AND parent_key = ? AND title = ? COLLATE NOCASE
      `);
      const nextSortOrder = this.#database.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS value
        FROM work_items WHERE topic_id = ? AND parent_key = ?
      `).get(input.topicId, input.parentId ?? "") as unknown as { value: number };
      const insert = this.#database.prepare(`
        INSERT INTO work_items (
          id, topic_id, decision_id, parent_id, title, details,
          status, status_note, version, sort_order, origin, severity,
          source_message_id, source_cycle_id, review_round,
          created_by_actor_id, created_by_snapshot_json,
          updated_by_actor_id, updated_by_snapshot_json,
          created_at, updated_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          'pending', NULL, 1, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?, NULL
        )
      `);
      const createdIds: string[] = [];
      let sortOrder = nextSortOrder.value;
      for (const item of normalizedItems) {
        if (duplicateQuery.get(input.topicId, input.parentId ?? "", item.title)) {
          throw new CouncilConflictError(`实施项“${item.title}”已经存在。`);
        }
        const id = `work_item_${randomUUID()}`;
        insert.run(
          id,
          input.topicId,
          decisionId,
          input.parentId ?? null,
          item.title,
          item.details,
          sortOrder,
          origin,
          item.severity ?? null,
          item.sourceMessageId ?? null,
          input.sourceCycleId ?? null,
          input.reviewRound ?? null,
          actor.actorId,
          actorSnapshotJson,
          actor.actorId,
          actorSnapshotJson,
          now,
          now,
        );
        createdIds.push(id);
        sortOrder += 1;
      }
      if (input.parentId) {
        // 新子任务会把一个已完成的父任务重新拉回进行中，这一步不能省。
        this.#recomputeAncestors(input.parentId, actor.actorId, actorSnapshotJson, now);
      }
      this.#database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(
        now,
        input.topicId,
      );
      const read = this.#database.prepare("SELECT * FROM work_items WHERE id = ?");
      return createdIds.map((id) => workItemFromRow(read.get(id) as unknown as WorkItemRow));
    });
  }

  /**
   * 手工拆解仍然要求先有 Accepted 决策——那是「先定架构再执行」的闸门。
   * 审核发现例外：commit 互审可能发生在议题还没产出任何决策的时候，
   * 若强行要求决策，评审挑出的问题就无处落账，只能散在讨论消息里。
   */
  #resolveWorkItemDecisionId(
    topicId: string,
    decisionId: string | undefined,
    origin: WorkItemOrigin,
  ): string | null {
    const decision = decisionId
      ? this.#database.prepare(`
          SELECT id, status FROM decisions WHERE id = ? AND topic_id = ?
        `).get(decisionId, topicId) as unknown as DecisionReferenceRow | undefined
      : this.#database.prepare(`
          SELECT id, status FROM decisions
          WHERE topic_id = ? AND status = 'accepted'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `).get(topicId) as unknown as DecisionReferenceRow | undefined;
    if (!decision) {
      if (origin === "review_finding") {
        return null;
      }
      throw new CouncilNotFoundError("当前议题没有可绑定的 Accepted 决策。");
    }
    if (decision.status !== "accepted") {
      throw new CouncilConflictError("实施项只能绑定 Accepted 决策。");
    }
    return decision.id;
  }

  #requireWorkItem(workItemId: string, topicId: string): WorkItemRow {
    const row = this.#database.prepare(`
      SELECT * FROM work_items WHERE id = ? AND topic_id = ?
    `).get(workItemId, topicId) as unknown as WorkItemRow | undefined;
    if (!row) {
      throw new CouncilNotFoundError(`实施项 ${workItemId} 不存在。`);
    }
    return row;
  }

  #hasChildren(workItemId: string): boolean {
    const row = this.#database.prepare(`
      SELECT EXISTS(SELECT 1 FROM work_items WHERE parent_id = ?) AS value
    `).get(workItemId) as unknown as { value: number };
    return row.value === 1;
  }

  /**
   * 父任务状态完全由子任务派生，任何一条写入路径都不接受手动设置。
   * 允许手动改父状态，就等于允许「父已完成、子未完成」这种自相矛盾的账本，
   * Agent 也会直接把父节点标完成来跳过实际交付。
   */
  #recomputeAncestors(
    fromWorkItemId: string,
    actorId: string,
    actorSnapshotJson: string,
    now: string,
  ): void {
    const readChildStatuses = this.#database.prepare(`
      SELECT status FROM work_items WHERE parent_id = ?
    `);
    const update = this.#database.prepare(`
      UPDATE work_items
      SET status = ?, version = version + 1,
          updated_by_actor_id = ?, updated_by_snapshot_json = ?,
          updated_at = ?, completed_at = ?
      WHERE id = ?
    `);
    let cursor: string | null = fromWorkItemId;
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(cursor)) {
        throw new CouncilConflictError("实施项父子关系存在环，已停止派生。");
      }
      visited.add(cursor);
      const current: WorkItemRow | undefined = this.#database.prepare(`
        SELECT * FROM work_items WHERE id = ?
      `).get(cursor) as unknown as WorkItemRow | undefined;
      if (!current) {
        return;
      }
      const childStatuses = (readChildStatuses.all(cursor) as unknown as Array<{
        status: WorkItemStatus;
      }>).map((row) => row.status);
      if (childStatuses.length > 0) {
        const derived = deriveParentStatus(childStatuses);
        if (derived !== current.status) {
          update.run(
            derived,
            actorId,
            actorSnapshotJson,
            now,
            derived === "completed" ? current.completed_at ?? now : null,
            cursor,
          );
        }
      }
      cursor = current.parent_id;
    }
  }

  updateWorkItem(input: {
    topicId: string;
    workItemId: string;
    status: WorkItemStatus;
    expectedVersion: number;
    statusNote?: string;
    fixCommit?: string;
    updatedByAlias: string;
  }): WorkItem {
    const actor = this.resolveActorAlias(input.updatedByAlias);
    return this.updateWorkItemAsActor({
      topicId: input.topicId,
      workItemId: input.workItemId,
      status: input.status,
      expectedVersion: input.expectedVersion,
      ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
      ...(input.fixCommit !== undefined ? { fixCommit: input.fixCommit } : {}),
      actorId: actor.actorId,
    });
  }

  updateWorkItemAsActor(input: {
    topicId: string;
    workItemId: string;
    status: WorkItemStatus;
    expectedVersion: number;
    statusNote?: string;
    fixCommit?: string;
    actorId: string;
  }): WorkItem {
    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.getTopic(input.topicId);
      const current = this.#requireWorkItem(input.workItemId, input.topicId);
      if (current.version !== input.expectedVersion) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (this.#hasChildren(input.workItemId)) {
        throw new CouncilConflictError(
          "这是一个父任务，状态由子任务派生；请更新它的子任务。",
        );
      }
      const actor = this.#activeActorById(input.actorId);
      const actorSnapshotJson = serializeActorSnapshot(toActorSnapshot(actor));
      const statusNote = input.statusNote === undefined
        ? current.status_note
        : input.statusNote.trim() || null;
      const fixCommit = input.fixCommit === undefined
        ? current.fix_commit
        : input.fixCommit.trim() || null;
      const completedAt = input.status === "completed"
        ? current.completed_at ?? now
        : null;
      const result = this.#database.prepare(`
        UPDATE work_items
        SET status = ?, status_note = ?, fix_commit = ?, version = version + 1,
            updated_by_actor_id = ?, updated_by_snapshot_json = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND topic_id = ? AND version = ?
      `).run(
        input.status,
        statusNote,
        fixCommit,
        actor.actorId,
        actorSnapshotJson,
        now,
        completedAt,
        input.workItemId,
        input.topicId,
        input.expectedVersion,
      );
      if (result.changes !== 1) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (current.parent_id) {
        this.#recomputeAncestors(current.parent_id, actor.actorId, actorSnapshotJson, now);
      }
      this.#database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(
        now,
        input.topicId,
      );
      const updated = this.#database
        .prepare("SELECT * FROM work_items WHERE id = ?")
        .get(input.workItemId) as unknown as WorkItemRow;
      return workItemFromRow(updated);
    });
  }

  /**
   * 认领一条待办：写上执行者并置为进行中。
   * 这是「外部 Agent 在做什么」唯一可信的来源——它开工前必须先在账本上签名，
   * 界面才能显示是谁正在修哪一条，而不是只看到一个跑了很久的黑箱。
   */
  claimWorkItemAsActor(input: {
    topicId: string;
    workItemId: string;
    expectedVersion: number;
    statusNote?: string;
    actorId: string;
  }): WorkItem {
    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.getTopic(input.topicId);
      const current = this.#requireWorkItem(input.workItemId, input.topicId);
      if (current.version !== input.expectedVersion) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (this.#hasChildren(input.workItemId)) {
        throw new CouncilConflictError("父任务不能被认领；请认领它的子任务。");
      }
      if (current.status === "completed") {
        throw new CouncilConflictError("这条实施项已经完成，无需认领。");
      }
      const actor = this.#activeActorById(input.actorId);
      const actorSnapshotJson = serializeActorSnapshot(toActorSnapshot(actor));
      const statusNote = input.statusNote === undefined
        ? current.status_note
        : input.statusNote.trim() || null;
      const result = this.#database.prepare(`
        UPDATE work_items
        SET status = 'in_progress', status_note = ?, version = version + 1,
            assignee_actor_id = ?, claimed_at = ?,
            updated_by_actor_id = ?, updated_by_snapshot_json = ?,
            updated_at = ?, completed_at = NULL
        WHERE id = ? AND topic_id = ? AND version = ?
      `).run(
        statusNote,
        actor.actorId,
        now,
        actor.actorId,
        actorSnapshotJson,
        now,
        input.workItemId,
        input.topicId,
        input.expectedVersion,
      );
      if (result.changes !== 1) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (current.parent_id) {
        this.#recomputeAncestors(current.parent_id, actor.actorId, actorSnapshotJson, now);
      }
      this.#database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(
        now,
        input.topicId,
      );
      const updated = this.#database
        .prepare("SELECT * FROM work_items WHERE id = ?")
        .get(input.workItemId) as unknown as WorkItemRow;
      return workItemFromRow(updated);
    });
  }

  listWorkItems(input: {
    topicId: string;
    status?: WorkItemStatus;
    assigneeActorId?: string;
    origin?: WorkItemOrigin;
  }): WorkItem[] {
    this.getTopic(input.topicId);
    const conditions = ["topic_id = ?"];
    const parameters: Array<string | number> = [input.topicId];
    if (input.status) {
      conditions.push("status = ?");
      parameters.push(input.status);
    }
    if (input.assigneeActorId) {
      conditions.push("assignee_actor_id = ?");
      parameters.push(input.assigneeActorId);
    }
    if (input.origin) {
      conditions.push("origin = ?");
      parameters.push(input.origin);
    }
    const rows = this.#database.prepare(`
      SELECT * FROM work_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY parent_key ASC, sort_order ASC, created_at ASC, rowid ASC
    `).all(...parameters) as unknown as WorkItemRow[];
    return rows.map(workItemFromRow);
  }

  getAgentSession(topicId: string, agent: string): string | undefined {

    const actor = this.resolveActorAlias(agent);
    const row = this.#database
      .prepare(`
        SELECT session_id
        FROM agent_sessions
        WHERE topic_id = ? AND actor_id = ? AND is_current = 1
      `)
      .get(topicId, actor.actorId) as unknown as SessionRow | undefined;
    return row?.session_id;
  }

  setAgentSession(topicId: string, agent: string, sessionId: string): void {
    this.getTopic(topicId);
    const actor = this.resolveActorAlias(agent);
    const now = new Date().toISOString();
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE agent_sessions
        SET is_current = 0
        WHERE topic_id = ? AND actor_id = ? AND is_current = 1
      `).run(topicId, actor.actorId);
      this.#database.prepare(`
        INSERT INTO agent_sessions (
          id, topic_id, actor_id, session_id,
          legacy_agent, is_current, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 1, ?)
      `).run(`session_${randomUUID()}`, topicId, actor.actorId, sessionId, now);
    });
  }

  deleteAgentSession(topicId: string, agent: string): boolean {
    this.getTopic(topicId);
    const actor = this.resolveActorAlias(agent);
    const result = this.#database
      .prepare(`
        UPDATE agent_sessions
        SET is_current = 0
        WHERE topic_id = ? AND actor_id = ? AND is_current = 1
      `)
      .run(topicId, actor.actorId);
    return result.changes > 0;
  }

  getCounts(): { topics: number; messages: number; decisions: number; workItems: number } {
    const count = (table: "topics" | "messages" | "decisions" | "work_items"): number => {
      const row = this.#database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as unknown as CountRow;
      return row.count;
    };
    return {
      topics: count("topics"),
      messages: count("messages"),
      decisions: count("decisions"),
      workItems: count("work_items"),
    };
  }

  getRevision(): number {
    return this.getRevisions().total;
  }

  /** 圆桌运行度量；SQL 细节在 orchestration/cycle-metrics.ts，这里只借出连接。 */
  getCycleMetrics(): CycleMetrics {
    return computeCycleMetrics(this.#database);
  }

  getRevisions(): CouncilRevisions {
    const rows = this.#database
      .prepare(`
        SELECT key, value FROM council_meta
        WHERE key IN ('revision', 'content_revision', 'orchestration_revision')
      `)
      .all() as unknown as RevisionRow[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const total = values.get("revision");
    const content = values.get("content_revision");
    const orchestration = values.get("orchestration_revision");
    if (
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(content) ||
      !Number.isSafeInteger(orchestration) ||
      (total ?? -1) < 0 ||
      (content ?? -1) < 0 ||
      (orchestration ?? -1) < 0
    ) {
      throw new Error("Council revision 状态无效。");
    }
    return {
      total: total as number,
      content: content as number,
      orchestration: orchestration as number,
    };
  }

  close(): void {
    this.#database.close();
  }
}
