/**
 * @input  依赖：已由 Node 迁移器准备的 SQLite、database/ 下的领域仓储与行映射、安全错误语义
 * @output 导出：CouncilDatabase（连接与 PRAGMA、BEGIN IMMEDIATE 事务、动态 Actor alias/可信 actorId
 *         解析、无损 Session 历史、计数/revision/圆桌度量）及同名同签名转发到仓储的议题、消息、
 *         决策、实施项方法；CouncilRevisions
 * @pos    双桌面客户端共享身份、内容和变更检测的数据访问入口；领域 SQL 住在 database/ 各仓储，
 *         调用方签名不变；身份漂移或停用时失败关闭
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CouncilConflictError } from "./errors.js";
import {
  computeCycleMetrics,
  type CycleMetrics,
} from "./orchestration/cycle-metrics.js";
import type { ActorIdentity } from "./actor-identity.js";
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
  WorkItemSeverity,
  WorkItemStatus,
} from "./types.js";
import type { DatabaseContext, TopicLookup } from "./database/context.js";
import { DecisionRepository } from "./database/decision-repository.js";
import { MessageRepository } from "./database/message-repository.js";
import {
  actorIdentityFromRow,
  type ActorIdentityRow,
  type CountRow,
  type RevisionRow,
  type SessionRow,
} from "./database/rows.js";
import { TopicRepository } from "./database/topic-repository.js";
import { WorkItemRepository } from "./database/work-item-repository.js";

export interface CouncilRevisions {
  total: number;
  content: number;
  orchestration: number;
}

export class CouncilDatabase {
  readonly #database: DatabaseSync;
  readonly #topics: TopicRepository;
  readonly #messages: MessageRepository;
  readonly #decisions: DecisionRepository;
  readonly #workItems: WorkItemRepository;

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
    // 仓储构造期只持有引用，不碰数据库。议题查找用闭包延迟到调用时解析，
    // 这样消息/决策/实施项仓储与议题仓储的相互依赖不需要特殊的构造顺序。
    const context: DatabaseContext = {
      database: this.#database,
      transaction: (operation) => this.#transaction(operation),
      activeActorById: (actorId) => this.#activeActorById(actorId),
      resolveActorAlias: (alias) => this.resolveActorAlias(alias),
    };
    const topics: TopicLookup = { get: (topicId) => this.#topics.get(topicId) };
    this.#messages = new MessageRepository(context, topics);
    this.#decisions = new DecisionRepository(context, topics);
    this.#workItems = new WorkItemRepository(context, topics);
    this.#topics = new TopicRepository(context, {
      messages: this.#messages,
      decisions: this.#decisions,
      workItems: this.#workItems,
    });
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

  // ------------------------------------------------------------
  // 议题：实现见 database/topic-repository.ts
  // ------------------------------------------------------------

  createTopic(input: {
    title: string;
    question: string;
    constraints: string[];
    projectPath?: string;
    createdByAlias: string;
  }): Topic {
    return this.#topics.create(input);
  }

  createTopicAsActor(input: {
    title: string;
    question: string;
    constraints: string[];
    projectPath?: string;
    actorId: string;
  }): Topic {
    return this.#topics.createAsActor(input);
  }

  updateTopicAsActor(input: {
    topicId: string;
    title?: string;
    question?: string;
    constraints?: string[];
    expectedUpdatedAt: string;
    actorId: string;
  }): Topic {
    return this.#topics.updateAsActor(input);
  }

  closeTopicAsActor(input: { topicId: string; actorId: string }): Topic {
    return this.#topics.closeAsActor(input);
  }

  getTopic(topicId: string): Topic {
    return this.#topics.get(topicId);
  }

  getTopicDetail(topicId: string, messageLimit: number, messageOffset = 0): TopicDetail {
    return this.#topics.getDetail(topicId, messageLimit, messageOffset);
  }

  listTopics(input: {
    projectPath?: string;
    status?: TopicStatus;
    limit: number;
    offset: number;
  }): PaginatedTopics {
    return this.#topics.list(input);
  }

  // ------------------------------------------------------------
  // 消息：实现见 database/message-repository.ts
  // ------------------------------------------------------------

  getMessage(messageId: string): CouncilMessage {
    return this.#messages.get(messageId);
  }

  findReplyBy(parentMessageId: string, actorId: string): CouncilMessage | undefined {
    return this.#messages.findReplyBy(parentMessageId, actorId);
  }

  createMessage(input: {
    topicId: string;
    actorAlias: string;
    kind: MessageKind;
    content: string;
    parentMessageId?: string;
  }): CouncilMessage {
    return this.#messages.create(input);
  }

  createMessageAsActor(input: {
    topicId: string;
    actorId: string;
    kind: MessageKind;
    content: string;
    parentMessageId?: string;
  }): CouncilMessage {
    return this.#messages.createAsActor(input);
  }

  // ------------------------------------------------------------
  // 决策：实现见 database/decision-repository.ts
  // ------------------------------------------------------------

  createDecision(input: {
    topicId: string;
    title: string;
    decision: string;
    rationale: string;
    alternatives: string[];
    status: DecisionStatus;
    createdByAlias: string;
  }): Decision {
    return this.#decisions.create(input);
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
    return this.#decisions.createAsActor(input);
  }

  acceptDecisionsAsActor(input: {
    topicId: string;
    decisionIds: string[];
    actorId: string;
  }): Decision[] {
    return this.#decisions.acceptAsActor(input);
  }

  // ------------------------------------------------------------
  // 实施项：实现见 database/work-item-repository.ts
  // ------------------------------------------------------------

  createWorkItems(input: {
    topicId: string;
    decisionId?: string;
    parentId?: string;
    items: Array<{ title: string; details?: string }>;
    createdByAlias: string;
  }): WorkItem[] {
    return this.#workItems.create(input);
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
    return this.#workItems.createAsActor(input);
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
    return this.#workItems.update(input);
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
    return this.#workItems.updateAsActor(input);
  }

  claimWorkItemAsActor(input: {
    topicId: string;
    workItemId: string;
    expectedVersion: number;
    statusNote?: string;
    actorId: string;
  }): WorkItem {
    return this.#workItems.claimAsActor(input);
  }

  listWorkItems(input: {
    topicId: string;
    status?: WorkItemStatus;
    assigneeActorId?: string;
    origin?: WorkItemOrigin;
  }): WorkItem[] {
    return this.#workItems.list(input);
  }

  // ------------------------------------------------------------
  // Agent session、计数与 revision：仍由本文件直接持有
  // ------------------------------------------------------------

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
