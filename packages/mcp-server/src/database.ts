/**
 * @input  依赖：SQLite 数据文件、领域类型与安全错误语义
 * @output 导出：CouncilDatabase 持久化与单调 revision 服务
 * @pos    双桌面客户端共享状态和变更检测的唯一数据访问层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CouncilConflictError, CouncilNotFoundError } from "./errors.js";
import type {
  Author,
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
  created_by: Author;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  topic_id: string;
  author: Author;
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
  created_by: Author;
  created_at: string;
  updated_at: string;
}

interface CountRow {
  count: number;
}

interface SessionRow {
  session_id: string;
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
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    constraints: parseStringArray(row.constraints_json),
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): CouncilMessage {
  return {
    id: row.id,
    topicId: row.topic_id,
    author: row.author,
    kind: row.kind,
    content: row.content,
    ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
    createdAt: row.created_at,
  };
}

function decisionFromRow(row: DecisionRow): Decision {
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    decision: row.decision,
    rationale: row.rationale,
    alternatives: parseStringArray(row.alternatives_json),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CouncilDatabase {
  readonly #database: DatabaseSync;

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
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        project_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'closed')),
        created_by TEXT NOT NULL CHECK (created_by IN ('human', 'claude', 'codex', 'chair', 'other')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK (author IN ('human', 'claude', 'codex', 'chair', 'other')),
        kind TEXT NOT NULL CHECK (kind IN ('brief', 'proposal', 'critique', 'rebuttal', 'synthesis', 'note')),
        content TEXT NOT NULL,
        parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        decision TEXT NOT NULL,
        rationale TEXT NOT NULL,
        alternatives_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
        created_by TEXT NOT NULL CHECK (created_by IN ('human', 'claude', 'codex', 'chair', 'other')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (topic_id, agent)
      );

      CREATE TABLE IF NOT EXISTS council_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO council_meta (key, value) VALUES ('revision', 0);
      INSERT OR IGNORE INTO council_meta (key, value) VALUES ('content_revision', 0);
      INSERT OR IGNORE INTO council_meta (key, value) VALUES ('orchestration_revision', 0);

      DROP TRIGGER IF EXISTS trg_topics_revision_insert;
      DROP TRIGGER IF EXISTS trg_topics_revision_update;
      DROP TRIGGER IF EXISTS trg_topics_revision_delete;
      DROP TRIGGER IF EXISTS trg_messages_revision_insert;
      DROP TRIGGER IF EXISTS trg_messages_revision_update;
      DROP TRIGGER IF EXISTS trg_messages_revision_delete;
      DROP TRIGGER IF EXISTS trg_decisions_revision_insert;
      DROP TRIGGER IF EXISTS trg_decisions_revision_update;
      DROP TRIGGER IF EXISTS trg_decisions_revision_delete;

      CREATE TRIGGER trg_topics_revision_insert
        AFTER INSERT ON topics BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_topics_revision_update
        AFTER UPDATE ON topics BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_topics_revision_delete
        AFTER DELETE ON topics BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_messages_revision_insert
        AFTER INSERT ON messages BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_messages_revision_update
        AFTER UPDATE ON messages BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_messages_revision_delete
        AFTER DELETE ON messages BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_decisions_revision_insert
        AFTER INSERT ON decisions BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_decisions_revision_update
        AFTER UPDATE ON decisions BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;
      CREATE TRIGGER trg_decisions_revision_delete
        AFTER DELETE ON decisions BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
          UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
        END;

      CREATE INDEX IF NOT EXISTS idx_topics_project_updated
        ON topics(project_path, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_topic_created
        ON messages(topic_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_decisions_topic_created
        ON decisions(topic_id, created_at ASC);
      `);
      this.#database.exec("COMMIT;");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK;");
      } catch {
        // 原始迁移错误优先；构造器会关闭连接。
      }
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

  createTopic(input: {
    title: string;
    question: string;
    constraints: string[];
    projectPath?: string;
    createdBy: Author;
  }): Topic {
    const id = `topic_${randomUUID()}`;
    const now = new Date().toISOString();
    this.#database
      .prepare(`
        INSERT INTO topics (
          id, title, question, constraints_json, project_path,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `)
      .run(
        id,
        input.title,
        input.question,
        JSON.stringify(input.constraints),
        input.projectPath ?? null,
        input.createdBy,
        now,
        now,
      );
    return this.getTopic(id);
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
    author: Author;
    kind: MessageKind;
    content: string;
    parentMessageId?: string;
  }): CouncilMessage {
    this.getTopic(input.topicId);
    const id = `message_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#transaction(() => {
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
            id, topic_id, author, kind, content, parent_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.topicId,
          input.author,
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
    createdBy: Author;
  }): Decision {
    this.getTopic(input.topicId);
    if (input.status === "accepted" && input.createdBy !== "human") {
      throw new CouncilConflictError("Accepted 决策必须由用户确认。");
    }
    const id = `decision_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.#database
        .prepare(`
          INSERT INTO decisions (
            id, topic_id, title, decision, rationale, alternatives_json,
            status, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.topicId,
          input.title,
          input.decision,
          input.rationale,
          JSON.stringify(input.alternatives),
          input.status,
          input.createdBy,
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
    const row = this.#database
      .prepare("SELECT session_id FROM agent_sessions WHERE topic_id = ? AND agent = ?")
      .get(topicId, agent) as unknown as SessionRow | undefined;
    return row?.session_id;
  }

  setAgentSession(topicId: string, agent: string, sessionId: string): void {
    this.getTopic(topicId);
    this.#database
      .prepare(`
        INSERT INTO agent_sessions (topic_id, agent, session_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(topic_id, agent) DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `)
      .run(topicId, agent, sessionId, new Date().toISOString());
  }

  deleteAgentSession(topicId: string, agent: string): boolean {
    this.getTopic(topicId);
    const result = this.#database
      .prepare("DELETE FROM agent_sessions WHERE topic_id = ? AND agent = ?")
      .run(topicId, agent);
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
