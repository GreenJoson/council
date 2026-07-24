/**
 * @input  依赖：已由 Node 迁移器准备的 SQLite、领域类型与安全错误语义
 * @output 导出：动态 Actor alias/可信 actorId 写入、快照一致性、无损 Session 历史与 revision
 * @pos    双桌面客户端共享身份、内容和变更检测的数据访问层；身份漂移或停用时失败关闭
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CouncilConflictError, CouncilNotFoundError } from "./errors.js";
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
    const nextMessageOffset = messageOffset + messageRows.length;
    const hasMoreMessages = nextMessageOffset < messageCountRow.count;
    return {
      topic,
      messages: messageRows.map(messageFromRow),
      decisions: decisionRows.map(decisionFromRow),
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
    return {
      total: countRow.count,
      count: rows.length,
      offset: input.offset,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      topics: rows.map(topicFromRow),
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

  getCounts(): { topics: number; messages: number; decisions: number } {
    const count = (table: "topics" | "messages" | "decisions"): number => {
      const row = this.#database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as unknown as CountRow;
      return row.count;
    };
    return {
      topics: count("topics"),
      messages: count("messages"),
      decisions: count("decisions"),
    };
  }

  getRevision(): number {
    return this.getRevisions().total;
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
