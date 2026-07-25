/**
 * @input  依赖：Council SQLite、RuntimeBinding 仓储、公开消息 codec 与议题上下文读取器
 * @output 导出：议题级请求去重、首轮全上下文和 session 增量上下文构建
 * @pos    SQLiteCouncilStore 的 RuntimeBinding 调用上下文职责
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import { InvalidRunStateError } from "../errors.js";
import type {
  CouncilPublicMessage,
  CouncilTopicContext,
  RuntimeBindingInvocationContext,
} from "../types.js";
import { assertActorId, assertMessageKind } from "./run-codec.js";
import type { RuntimeBindingRepository } from "./runtime-binding-repository.js";

export interface RuntimeMessageRow {
  id: unknown;
  topic_id: unknown;
  author_actor_id: unknown;
  kind: unknown;
  content: unknown;
  created_at: unknown;
}

export interface RuntimeInvocationContextDependencies {
  database: DatabaseSync;
  runtimeBindings: RuntimeBindingRepository;
  contextMessageLimit: number;
  getTopicContext: (topicId: string) => Promise<CouncilTopicContext>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRunStateError(`${path} 必须是非空字符串。`);
  }
  return value;
}

export function decodeCouncilMessageRows(
  rows: readonly RuntimeMessageRow[],
  topicId: string,
): CouncilPublicMessage[] {
  return rows.map((row, index): CouncilPublicMessage => {
    const actorId = row.author_actor_id;
    const kind = row.kind;
    assertActorId(actorId, `messages[${String(index)}].author_actor_id`);
    assertMessageKind(kind, `messages[${String(index)}].kind`);
    const messageTopicId = nonEmptyString(
      row.topic_id,
      `messages[${String(index)}].topic_id`,
    );
    if (messageTopicId !== topicId) {
      throw new InvalidRunStateError("消息不属于请求的议题。");
    }
    return {
      id: nonEmptyString(row.id, `messages[${String(index)}].id`),
      topicId: messageTopicId,
      actorId,
      kind,
      content: nonEmptyString(row.content, `messages[${String(index)}].content`),
      createdAt: nonEmptyString(row.created_at, `messages[${String(index)}].created_at`),
    };
  });
}

export async function loadRuntimeBindingInvocationContext(
  dependencies: RuntimeInvocationContextDependencies,
  bindingId: string,
  requestMessageId?: string,
): Promise<RuntimeBindingInvocationContext> {
  const { database, runtimeBindings, contextMessageLimit, getTopicContext } = dependencies;
  const binding = runtimeBindings.get(bindingId);
  if (binding.status === "closing" || binding.status === "closed") {
    throw new InvalidRunStateError("已关闭的 RuntimeBinding 不能构建调用上下文。");
  }
  if (requestMessageId) {
    const consumed = database.prepare(`
      SELECT 1
      FROM runtime_binding_requests
      WHERE topic_id = ? AND agent_id = ? AND request_message_id = ?
    `).get(binding.topicId, binding.agentId, requestMessageId);
    if (consumed) {
      throw new InvalidRunStateError(
        "当前 human 请求已被该议题的同一 Agent 成功消费，拒绝重复调用。",
      );
    }
  }
  const topic = await getTopicContext(binding.topicId);
  if (
    !binding.sessionId
    || !binding.cursor
    || binding.transportKind === "openai-sessionless"
  ) {
    if (requestMessageId) {
      const request = topic.messages.find((message) => message.id === requestMessageId);
      if (!request || request.actorId !== "human") {
        throw new InvalidRunStateError(
          "当前请求必须是 RuntimeBinding 首轮上下文中的 human 消息。",
        );
      }
    }
    const last = topic.messages.at(-1);
    return {
      binding,
      topic,
      firstTurn: true,
      ...(last
        ? { consumedCursor: { createdAt: last.createdAt, messageId: last.id } }
        : {}),
    };
  }
  const rows = database.prepare(`
    SELECT id, topic_id, author_actor_id, kind, content, created_at
    FROM messages
    WHERE topic_id = ?
      AND (
        created_at > ?
        OR (created_at = ? AND id > ?)
      )
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(
    binding.topicId,
    binding.cursor.createdAt,
    binding.cursor.createdAt,
    binding.cursor.messageId,
    contextMessageLimit,
  ) as unknown as RuntimeMessageRow[];
  const messages = decodeCouncilMessageRows(rows, binding.topicId);
  if (requestMessageId) {
    const request = messages.find((message) => message.id === requestMessageId);
    if (!request || request.actorId !== "human") {
      throw new InvalidRunStateError(
        "当前请求必须是 RuntimeBinding 游标后的 human 消息，拒绝重复或越序调用。",
      );
    }
  }
  const last = messages.at(-1);
  return {
    binding,
    topic: { ...topic, messages },
    firstTurn: false,
    ...(last
      ? {
          consumedCursor: {
            createdAt: last.createdAt,
            messageId: last.id,
          },
        }
      : {}),
  };
}
