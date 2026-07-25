/**
 * @input  依赖：Council SQLite、冻结 Run、双 lease 与 RuntimeBinding 仓储
 * @output 导出：Run、公开消息、逻辑请求账本、session/游标和 lease 的原子提交
 * @pos    SQLiteCouncilStore 的单轮提交事务职责
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_MESSAGE_CHARS } from "../constants.js";
import {
  InvalidRunStateError,
  LeaseLostError,
  StoreConflictError,
} from "../errors.js";
import type {
  CouncilPublicMessage,
  OrchestrationRun,
  RoundCommitInput,
  RoundCommitResult,
  RunLease,
} from "../types.js";
import {
  assertActorId,
  assertMessageKind,
  validateRunSnapshot,
} from "./run-codec.js";
import type { RuntimeBindingRepository } from "./runtime-binding-repository.js";

export interface AtomicRoundCommitDependencies {
  database: DatabaseSync;
  runtimeBindings: RuntimeBindingRepository;
  now: () => number;
  assertRunLease: (lease: RunLease, nowMs: number) => void;
  getRun: (runId: string) => OrchestrationRun;
  saveRun: (
    current: OrchestrationRun,
    desired: OrchestrationRun,
    expectedVersion: number,
    now: string,
  ) => OrchestrationRun;
  actorSnapshotJson: (actorId: string) => string;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRunStateError(`${path} 必须是非空字符串。`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidRunStateError(`${path} 必须是正安全整数。`);
  }
  return value;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function assertExecutableSnapshot(run: OrchestrationRun): void {
  if (
    run.plan.some((round) =>
      !round.bindingRevision?.trim() || !round.runtimeBindingId?.trim()
    )
  ) {
    throw new InvalidRunStateError(
      "旧运行缺少冻结的 Agent bindingRevision 或 runtimeBindingId，只允许读取或取消；请创建新运行。",
    );
  }
}

export function assertSameImmutableFields(
  current: OrchestrationRun,
  next: OrchestrationRun,
): void {
  if (
    next.id !== current.id ||
    next.topicId !== current.topicId ||
    next.createdAt !== current.createdAt ||
    JSON.stringify(next.plan) !== JSON.stringify(current.plan) ||
    JSON.stringify(next.policy) !== JSON.stringify(current.policy)
  ) {
    throw new StoreConflictError("运行的标识、议题、创建时间、计划或策略不可替换。");
  }
}

export function commitAtomicRound(
  dependencies: AtomicRoundCommitDependencies,
  input: RoundCommitInput,
): RoundCommitResult {
  const {
    database,
    runtimeBindings,
    now: readNow,
    assertRunLease,
    getRun,
    saveRun,
    actorSnapshotJson,
  } = dependencies;
  const expectedVersion = positiveInteger(input.expectedVersion, "commitRound.expectedVersion");
  const desired = validateRunSnapshot(input.run, 4);
  assertExecutableSnapshot(desired);
  const messageTopicId = nonEmptyString(input.message.topicId, "commitRound.message.topicId");
  const content = nonEmptyString(input.message.content, "commitRound.message.content");
  assertActorId(input.message.actorId, "commitRound.message.actorId");
  assertMessageKind(input.message.kind, "commitRound.message.kind");
  if (content.trim().length === 0) {
    throw new InvalidRunStateError("commitRound.message.content 不能只有空白。");
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    throw new InvalidRunStateError("commitRound.message.content 超过长度上限。");
  }

  const nowMs = readNow();
  assertRunLease(input.lease, nowMs);
  runtimeBindings.assertLease(input.bindingLease, nowMs);
  if (input.lease.runId !== desired.id) {
    throw new LeaseLostError("执行 lease 不属于当前运行。");
  }
  const current = getRun(desired.id);
  const round = current.plan[current.nextRoundIndex];
  const binding = runtimeBindings.get(input.bindingLease.bindingId);
  if (
    current.version !== expectedVersion ||
    current.status !== "waiting_agent" ||
    !round ||
    desired.version !== expectedVersion ||
    desired.status !== "running" ||
    desired.nextRoundIndex !== current.nextRoundIndex + 1 ||
    desired.currentAttempt !== 0 ||
    desired.manualRecoveriesUsed !== current.manualRecoveriesUsed ||
    JSON.stringify(desired.confirmedGates) !== JSON.stringify(current.confirmedGates) ||
    desired.updatedAt !== current.updatedAt ||
    desired.activeAgentId !== undefined ||
    desired.pendingGateId !== undefined ||
    desired.stopReason !== undefined ||
    desired.failure !== undefined ||
    messageTopicId !== current.topicId ||
    desired.topicId !== current.topicId ||
    input.message.actorId !== round.actorId ||
    input.message.kind !== round.messageKind ||
    !round.runtimeBindingId ||
    round.runtimeBindingId !== binding.id ||
    input.bindingLease.bindingId !== binding.id ||
    input.bindingLease.epoch !== binding.epoch ||
    binding.topicId !== current.topicId ||
    binding.actorId !== round.actorId ||
    binding.bindingRevision !== round.bindingRevision ||
    !["ready", "thinking", "streaming"].includes(binding.status)
  ) {
    throw new StoreConflictError("轮次已取消、过期或不符合原子提交状态转换。");
  }
  assertSameImmutableFields(current, desired);
  const consumedCursor = input.consumedCursor ?? binding.cursor;
  const requestMessage = round.requestMessageId
    ? database.prepare(`
        SELECT topic_id, author_actor_id, created_at
        FROM messages
        WHERE id = ?
      `).get(round.requestMessageId) as unknown as
        | { topic_id: unknown; author_actor_id: unknown; created_at: unknown }
        | undefined
    : undefined;
  if (
    round.requestMessageId
    && (
      !requestMessage
      || requestMessage.topic_id !== current.topicId
      || requestMessage.author_actor_id !== "human"
      || typeof requestMessage.created_at !== "string"
      || !consumedCursor
      || consumedCursor.createdAt < requestMessage.created_at
      || (
        consumedCursor.createdAt === requestMessage.created_at
        && consumedCursor.messageId < round.requestMessageId
      )
    )
  ) {
    throw new StoreConflictError("本轮 human 请求不存在、归属错误或未包含在消费水位中。");
  }
  if (consumedCursor) {
    const consumedMessage = database.prepare(`
      SELECT topic_id, created_at
      FROM messages
      WHERE id = ?
    `).get(consumedCursor.messageId) as unknown as
      | { topic_id: unknown; created_at: unknown }
      | undefined;
    if (
      !consumedMessage
      || consumedMessage.topic_id !== current.topicId
      || consumedMessage.created_at !== consumedCursor.createdAt
      || (
        binding.cursor
        && (
          consumedCursor.createdAt < binding.cursor.createdAt
          || (
            consumedCursor.createdAt === binding.cursor.createdAt
            && consumedCursor.messageId < binding.cursor.messageId
          )
        )
      )
    ) {
      throw new StoreConflictError("本轮公开上下文消费水位无效或发生回退。");
    }
  }
  const now = new Date(nowMs).toISOString();
  if (round.requestMessageId) {
    const consumed = database.prepare(`
      INSERT OR IGNORE INTO runtime_binding_requests (
        topic_id, agent_id, request_message_id, consumed_at
      ) VALUES (?, ?, ?, ?)
    `).run(current.topicId, binding.agentId, round.requestMessageId, now);
    if (consumed.changes !== 1) {
      throw new StoreConflictError("当前 human 请求已被该议题的同一 Agent 成功消费。");
    }
  }
  const saved = saveRun(current, desired, expectedVersion, now);
  const message: CouncilPublicMessage = {
    id: `message_${randomUUID()}`,
    topicId: messageTopicId,
    actorId: input.message.actorId,
    kind: input.message.kind,
    content,
    createdAt: now,
  };
  database.prepare(`
    INSERT INTO messages (
      id, topic_id, author_actor_id, author_snapshot_json,
      author_legacy, kind, content, parent_message_id, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)
  `).run(
    message.id,
    message.topicId,
    message.actorId,
    actorSnapshotJson(input.message.actorId),
    message.kind,
    message.content,
    message.createdAt,
  );
  database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?")
    .run(now, message.topicId);
  let bindingResult;
  try {
    bindingResult = database.prepare(`
      UPDATE runtime_bindings
      SET status = 'idle', state_version = state_version + 1,
          session_id = COALESCE(?, session_id),
          cursor_created_at = ?, cursor_message_id = ?,
          last_activity_at = ?, updated_at = ?
      WHERE id = ? AND state_version = ? AND epoch = ?
        AND binding_revision = ? AND agent_id = ? AND actor_id = ?
        AND status IN ('ready', 'thinking', 'streaming')
        AND EXISTS (
          SELECT 1
          FROM agent_definitions AS agents
          INNER JOIN provider_profiles AS providers
            ON providers.id = agents.provider_id
          WHERE agents.id = runtime_bindings.agent_id
            AND agents.actor_id = runtime_bindings.actor_id
            AND agents.provider_id = runtime_bindings.provider_id
            AND agents.enabled = 1
            AND agents.deleted_at IS NULL
            AND providers.status = 'active'
        )
    `).run(
      input.bindingSessionId ?? null,
      consumedCursor?.createdAt ?? null,
      consumedCursor?.messageId ?? null,
      now,
      now,
      binding.id,
      binding.stateVersion,
      input.bindingLease.epoch,
      binding.bindingRevision,
      binding.agentId,
      binding.actorId,
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new StoreConflictError(
        "外部 session 已被另一个活动 RuntimeBinding 占用，拒绝跨议题复用。",
      );
    }
    throw error;
  }
  if (bindingResult.changes !== 1) {
    throw new StoreConflictError("RuntimeBinding 状态或配置已变化，拒绝提交迟到回复。");
  }
  const released = database.prepare(`
    DELETE FROM runtime_binding_leases
    WHERE binding_id = ? AND owner_id = ? AND lease_token = ? AND epoch = ?
  `).run(
    input.bindingLease.bindingId,
    input.bindingLease.ownerId,
    input.bindingLease.token,
    input.bindingLease.epoch,
  );
  if (released.changes !== 1) {
    throw new LeaseLostError("RuntimeBinding lease 在提交回复前已丢失。");
  }
  return { run: saved, message };
}
