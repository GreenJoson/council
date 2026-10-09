/**
 * @input  依赖：共享数据库上下文、议题存在性查找、行映射与安全错误语义
 * @output 导出：MessageRepository —— 单条消息读取、指定 Actor 的首条回复查找（幂等回答用）、
 *         议题详情用的消息分页、动态 alias/可信 actorId 发消息（父消息必须同属当前议题）
 * @pos    消息领域仓储；写入在 BEGIN IMMEDIATE 事务内完成并同步推进议题 updated_at
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { serializeActorSnapshot, toActorSnapshot } from "../actor-identity.js";
import { CouncilConflictError, CouncilNotFoundError } from "../errors.js";
import type { CouncilMessage, MessageKind } from "../types.js";
import type { DatabaseContext, TopicLookup } from "./context.js";
import { messageFromRow, type CountRow, type MessageRow } from "./rows.js";

export class MessageRepository {
  readonly #context: DatabaseContext;
  readonly #topics: TopicLookup;

  constructor(context: DatabaseContext, topics: TopicLookup) {
    this.#context = context;
    this.#topics = topics;
  }

  get(messageId: string): CouncilMessage {
    const row = this.#context.database
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
    const row = this.#context.database
      .prepare(`
        SELECT * FROM messages
        WHERE parent_message_id = ? AND author_actor_id = ?
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `)
      .get(parentMessageId, actorId) as unknown as MessageRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  /**
   * 议题详情用的消息分页：先按时间倒序截取最近一页，再翻回正序交给界面。
   * total 与页内容来自两条语句，不在事务内；详情本身就是快照读取。
   */
  readPage(
    topicId: string,
    limit: number,
    offset: number,
  ): { total: number; messages: CouncilMessage[] } {
    const messageCountRow = this.#context.database
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?")
      .get(topicId) as unknown as CountRow;
    const messageRows = this.#context.database
      .prepare(`
        SELECT * FROM (
          SELECT rowid AS internal_rowid, *
          FROM messages
          WHERE topic_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ? OFFSET ?
        ) ORDER BY created_at ASC, internal_rowid ASC
      `)
      .all(topicId, limit, offset) as unknown as MessageRow[];
    return {
      total: messageCountRow.count,
      messages: messageRows.map(messageFromRow),
    };
  }

  create(input: {
    topicId: string;
    actorAlias: string;
    kind: MessageKind;
    content: string;
    parentMessageId?: string;
  }): CouncilMessage {
    const actor = this.#context.resolveActorAlias(input.actorAlias);
    return this.createAsActor({
      topicId: input.topicId,
      actorId: actor.actorId,
      kind: input.kind,
      content: input.content,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    });
  }

  createAsActor(input: {
    topicId: string;
    actorId: string;
    kind: MessageKind;
    content: string;
    parentMessageId?: string;
  }): CouncilMessage {
    const id = `message_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#context.transaction(() => {
      this.#topics.get(input.topicId);
      const actor = this.#context.activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      if (input.parentMessageId) {
        const parent = this.#context.database
          .prepare("SELECT topic_id FROM messages WHERE id = ?")
          .get(input.parentMessageId) as unknown as Pick<MessageRow, "topic_id"> | undefined;
        if (!parent) {
          throw new CouncilNotFoundError("父消息不存在，无法建立回复关系。");
        }
        if (parent.topic_id !== input.topicId) {
          throw new CouncilConflictError("父消息不属于当前议题，无法建立回复关系。");
        }
      }
      this.#context.database
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
      this.#context.database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(now, input.topicId);
      const row = this.#context.database
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(id) as unknown as MessageRow;
      return messageFromRow(row);
    });
  }
}
