/**
 * @input  依赖：Council SQLite、RuntimeBinding codec、编排错误与严格公开类型
 * @output 导出：RuntimeBinding 查询、配置冻结、lease fencing、状态迁移与关闭仓储
 * @pos    SQLiteCouncilStore 的议题级 Agent 运行时持久化模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  InvalidRunStateError,
  LeaseConflictError,
  LeaseLostError,
  StoreConflictError,
} from "../errors.js";
import type {
  ClaimRuntimeBindingLeaseInput,
  EnsureRuntimeBindingInput,
  FinalizeRuntimeBindingCloseInput,
  ListRuntimeBindingsInput,
  RenewRuntimeBindingLeaseInput,
  RuntimeBinding,
  RuntimeBindingLease,
  RuntimeBindingStatus,
  TransitionRuntimeBindingInput,
} from "../types.js";
import {
  decodeRuntimeBinding,
  decodeRuntimeBindingLease,
  type RuntimeBindingLeaseRow,
  type RuntimeBindingRow,
} from "./runtime-binding-codec.js";

interface TopicProjectRow {
  project_path: unknown;
  status: unknown;
}

interface AgentDefinitionRow {
  actor_id: unknown;
  provider_id: unknown;
  enabled: unknown;
  deleted_at: unknown;
  provider_status: unknown;
}

const TERMINAL_BINDING_STATUSES = new Set<RuntimeBindingStatus>([
  "closing",
  "closed",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<RuntimeBindingStatus, readonly RuntimeBindingStatus[]>> = {
  starting: ["ready", "thinking", "interrupted", "closing"],
  ready: ["thinking", "interrupted", "closing"],
  thinking: ["streaming", "idle", "interrupted", "closing"],
  streaming: ["idle", "interrupted", "closing"],
  idle: ["starting", "thinking", "interrupted", "closing"],
  interrupted: ["starting", "thinking", "closing"],
  closing: ["closed"],
  closed: [],
};

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
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

function safeExpiry(nowMs: number, ttlMs: number): number {
  const expiresAtMs = nowMs + positiveInteger(ttlMs, "runtimeBindingLease.ttlMs");
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new InvalidRunStateError("RuntimeBinding lease 到期时间超出安全整数范围。");
  }
  return expiresAtMs;
}

function nullableString(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(value, path);
}

export class RuntimeBindingRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => number;

  constructor(database: DatabaseSync, now: () => number) {
    this.#database = database;
    this.#now = now;
  }

  get(bindingId: string): RuntimeBinding {
    const normalizedId = requiredString(bindingId, "runtimeBinding.id");
    const row = this.#database.prepare(`
      SELECT *
      FROM runtime_bindings
      WHERE id = ?
    `).get(normalizedId) as unknown as RuntimeBindingRow | undefined;
    if (!row) {
      throw new InvalidRunStateError(`RuntimeBinding ${normalizedId} 不存在。`);
    }
    return decodeRuntimeBinding(row);
  }

  list(input: ListRuntimeBindingsInput): readonly RuntimeBinding[] {
    const topicId = requiredString(input.topicId, "listRuntimeBindings.topicId");
    const rows = this.#database.prepare(`
      SELECT *
      FROM runtime_bindings
      WHERE topic_id = ?
        AND (? = 1 OR status <> 'closed')
      ORDER BY created_at ASC, id ASC
    `).all(topicId, input.includeClosed ? 1 : 0) as unknown as RuntimeBindingRow[];
    return rows.map(decodeRuntimeBinding);
  }

  listOpen(): readonly RuntimeBinding[] {
    const rows = this.#database.prepare(`
      SELECT *
      FROM runtime_bindings
      WHERE status <> 'closed'
      ORDER BY created_at ASC, id ASC
    `).all() as unknown as RuntimeBindingRow[];
    return rows.map(decodeRuntimeBinding);
  }

  ensure(input: EnsureRuntimeBindingInput): RuntimeBinding {
    const topicId = requiredString(input.topicId, "ensureRuntimeBinding.topicId");
    const agentId = requiredString(input.agentId, "ensureRuntimeBinding.agentId");
    const actorId = requiredString(input.actorId, "ensureRuntimeBinding.actorId");
    const providerId = requiredString(input.providerId, "ensureRuntimeBinding.providerId");
    const bindingRevision = requiredString(
      input.bindingRevision,
      "ensureRuntimeBinding.bindingRevision",
    );
    const agentRevision = positiveInteger(
      input.agentConfigRevision,
      "ensureRuntimeBinding.agentConfigRevision",
    );
    const providerRevision = positiveInteger(
      input.providerConfigRevision,
      "ensureRuntimeBinding.providerConfigRevision",
    );
    const processInstanceId = requiredString(
      input.processInstanceId,
      "ensureRuntimeBinding.processInstanceId",
    );
    const topic = this.#database.prepare(`
      SELECT project_path, status
      FROM topics
      WHERE id = ?
    `).get(topicId) as unknown as TopicProjectRow | undefined;
    if (!topic) {
      throw new InvalidRunStateError(`Council 议题 ${topicId} 不存在。`);
    }
    if (topic.status !== "open") {
      throw new StoreConflictError("只有 open 议题可以创建或重开 RuntimeBinding。");
    }
    const projectPath = nullableString(topic.project_path, "topics.project_path");
    const agent = this.#database.prepare(`
      SELECT agents.actor_id, agents.provider_id, agents.enabled, agents.deleted_at,
             providers.status AS provider_status
      FROM agent_definitions AS agents
      INNER JOIN provider_profiles AS providers ON providers.id = agents.provider_id
      WHERE agents.id = ?
    `).get(agentId) as unknown as AgentDefinitionRow | undefined;
    if (
      !agent ||
      agent.actor_id !== actorId ||
      agent.provider_id !== providerId ||
      agent.enabled !== 1 ||
      agent.deleted_at !== null ||
      agent.provider_status !== "active"
    ) {
      throw new InvalidRunStateError("RuntimeBinding 引用的 Agent/Provider 不存在或不可用。");
    }

    const currentRow = this.#database.prepare(`
      SELECT *
      FROM runtime_bindings
      WHERE topic_id = ? AND agent_id = ? AND status <> 'closed'
    `).get(topicId, agentId) as unknown as RuntimeBindingRow | undefined;
    if (currentRow) {
      const current = decodeRuntimeBinding(currentRow);
      const exact =
        current.actorId === actorId &&
        current.providerId === providerId &&
        current.bindingRevision === bindingRevision &&
        current.agentConfigRevision === agentRevision &&
        current.providerConfigRevision === providerRevision &&
        current.projectPath === projectPath &&
        current.transportKind === input.transportKind;
      if (exact && current.status !== "closing") {
        return current;
      }
      const activeLease = this.#leaseRow(current.id);
      if (activeLease && decodeRuntimeBindingLease(activeLease).expiresAtMs > this.#now()) {
        throw new StoreConflictError("旧 RuntimeBinding 仍在执行，不能切换配置。");
      }
      const now = new Date(this.#now()).toISOString();
      this.#database.prepare(`
        UPDATE runtime_bindings
        SET status = 'closed', state_version = state_version + 1, epoch = epoch + 1,
            process_instance_id = NULL, close_reason = 'config-changed',
            last_activity_at = ?, updated_at = ?, closed_at = ?
        WHERE id = ? AND state_version = ?
      `).run(now, now, now, current.id, current.stateVersion);
      this.#database.prepare(`
        DELETE FROM runtime_binding_leases
        WHERE binding_id = ?
      `).run(current.id);
    }

    const now = new Date(this.#now()).toISOString();
    const id = `binding_${randomUUID()}`;
    this.#database.prepare(`
      INSERT INTO runtime_bindings (
        id, topic_id, agent_id, actor_id, provider_id, binding_revision,
        agent_config_revision, provider_config_revision, project_path,
        transport_kind, session_id, cursor_created_at, cursor_message_id,
        status, state_version, epoch, process_instance_id, last_activity_at,
        close_reason, created_at, updated_at, closed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
        'starting', 1, 0, ?, ?, NULL, ?, ?, NULL
      )
    `).run(
      id,
      topicId,
      agentId,
      actorId,
      providerId,
      bindingRevision,
      agentRevision,
      providerRevision,
      projectPath ?? null,
      input.transportKind,
      processInstanceId,
      now,
      now,
      now,
    );
    return this.get(id);
  }

  claimLease(input: ClaimRuntimeBindingLeaseInput): RuntimeBindingLease {
    const bindingId = requiredString(input.bindingId, "claimRuntimeBindingLease.bindingId");
    const ownerId = requiredString(input.ownerId, "claimRuntimeBindingLease.ownerId");
    const processInstanceId = requiredString(
      input.processInstanceId,
      "claimRuntimeBindingLease.processInstanceId",
    );
    const binding = this.get(bindingId);
    if (TERMINAL_BINDING_STATUSES.has(binding.status)) {
      throw new LeaseConflictError(`RuntimeBinding 状态 ${binding.status} 不允许获取 lease。`);
    }
    const nowMs = this.#now();
    const expiresAtMs = safeExpiry(nowMs, input.ttlMs);
    const existingRow = this.#leaseRow(bindingId);
    if (existingRow) {
      const existing = decodeRuntimeBindingLease(existingRow);
      if (existing.expiresAtMs > nowMs) {
        throw new LeaseConflictError("RuntimeBinding 已有有效 lease，拒绝重复启动 Agent。");
      }
    }
    const epoch = Math.max(
      binding.epoch,
      existingRow ? decodeRuntimeBindingLease(existingRow).epoch : 0,
    ) + 1;
    const lease: RuntimeBindingLease = {
      bindingId,
      ownerId,
      token: `binding_lease_${randomUUID()}`,
      epoch,
      expiresAtMs,
    };
    this.#database.prepare(`
      INSERT INTO runtime_binding_leases (
        binding_id, owner_id, lease_token, epoch, expires_at_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        lease_token = excluded.lease_token,
        epoch = excluded.epoch,
        expires_at_ms = excluded.expires_at_ms,
        updated_at = excluded.updated_at
    `).run(
      lease.bindingId,
      lease.ownerId,
      lease.token,
      lease.epoch,
      lease.expiresAtMs,
      new Date(nowMs).toISOString(),
    );
    const updated = this.#database.prepare(`
      UPDATE runtime_bindings
      SET epoch = ?, process_instance_id = ?, status = 'starting',
          state_version = state_version + 1, updated_at = ?
      WHERE id = ? AND state_version = ? AND status NOT IN ('closing', 'closed')
    `).run(
      epoch,
      processInstanceId,
      new Date(nowMs).toISOString(),
      bindingId,
      binding.stateVersion,
    );
    if (updated.changes !== 1) {
      throw new LeaseLostError("获取 RuntimeBinding lease 时状态已变化。");
    }
    return lease;
  }

  renewLease(input: RenewRuntimeBindingLeaseInput): RuntimeBindingLease {
    const nowMs = this.#now();
    const current = this.assertLease(input.lease, nowMs);
    const renewed = { ...current, expiresAtMs: safeExpiry(nowMs, input.ttlMs) };
    const result = this.#database.prepare(`
      UPDATE runtime_binding_leases
      SET expires_at_ms = ?, updated_at = ?
      WHERE binding_id = ? AND owner_id = ? AND lease_token = ? AND epoch = ?
    `).run(
      renewed.expiresAtMs,
      new Date(nowMs).toISOString(),
      renewed.bindingId,
      renewed.ownerId,
      renewed.token,
      renewed.epoch,
    );
    if (result.changes !== 1) {
      throw new LeaseLostError("续租期间 RuntimeBinding lease 已被接管。");
    }
    return renewed;
  }

  assertLease(lease: RuntimeBindingLease, nowMs: number): RuntimeBindingLease {
    const row = this.#leaseRow(requiredString(lease.bindingId, "runtimeBindingLease.bindingId"));
    if (!row) {
      throw new LeaseLostError("RuntimeBinding 没有有效 lease。");
    }
    const current = decodeRuntimeBindingLease(row);
    if (
      current.ownerId !== lease.ownerId ||
      current.token !== lease.token ||
      current.epoch !== lease.epoch ||
      current.expiresAtMs <= nowMs
    ) {
      throw new LeaseLostError("RuntimeBinding lease 已过期或被其他执行者接管。");
    }
    return current;
  }

  transition(input: TransitionRuntimeBindingInput): RuntimeBinding {
    const nowMs = this.#now();
    const lease = this.assertLease(input.lease, nowMs);
    const current = this.get(lease.bindingId);
    if (current.epoch !== lease.epoch || current.stateVersion !== input.expectedStateVersion) {
      throw new StoreConflictError("RuntimeBinding epoch 或 stateVersion 已变化。");
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(input.status)) {
      throw new InvalidRunStateError(
        `RuntimeBinding 不允许从 ${current.status} 转为 ${input.status}。`,
      );
    }
    if (input.clearSession && input.sessionId) {
      throw new InvalidRunStateError("不能同时清除和写入 RuntimeBinding session。");
    }
    const now = new Date(nowMs).toISOString();
    const sessionId = input.clearSession ? null : input.sessionId ?? current.sessionId ?? null;
    const cursor = input.clearSession ? undefined : current.cursor;
    const closedAt = input.status === "closed" ? now : null;
    const processInstanceId = input.status === "closed"
      ? null
      : input.processInstanceId ?? current.processInstanceId ?? null;
    const result = this.#database.prepare(`
      UPDATE runtime_bindings
      SET status = ?, state_version = state_version + 1,
          process_instance_id = ?, session_id = ?,
          cursor_created_at = ?, cursor_message_id = ?, close_reason = ?,
          last_activity_at = ?, updated_at = ?, closed_at = ?
      WHERE id = ? AND state_version = ? AND epoch = ?
        AND status NOT IN ('closed')
    `).run(
      input.status,
      processInstanceId,
      sessionId,
      cursor?.createdAt ?? null,
      cursor?.messageId ?? null,
      input.closeReason ?? current.closeReason ?? null,
      now,
      now,
      closedAt,
      current.id,
      current.stateVersion,
      lease.epoch,
    );
    if (result.changes !== 1) {
      throw new StoreConflictError("RuntimeBinding 状态转换的 CAS 被拒绝。");
    }
    if (input.status === "closed") {
      this.#database.prepare(`
        DELETE FROM runtime_binding_leases
        WHERE binding_id = ? AND lease_token = ? AND epoch = ?
      `).run(current.id, lease.token, lease.epoch);
    }
    return this.get(current.id);
  }

  releaseLease(lease: RuntimeBindingLease): boolean {
    const result = this.#database.prepare(`
      DELETE FROM runtime_binding_leases
      WHERE binding_id = ? AND owner_id = ? AND lease_token = ? AND epoch = ?
    `).run(lease.bindingId, lease.ownerId, lease.token, lease.epoch);
    return result.changes === 1;
  }

  requestClose(bindingId: string, reason: string): RuntimeBinding {
    const current = this.get(bindingId);
    if (current.status === "closed" || current.status === "closing") return current;
    const now = new Date(this.#now()).toISOString();
    const result = this.#database.prepare(`
      UPDATE runtime_bindings
      SET status = 'closing', state_version = state_version + 1,
          epoch = epoch + 1, close_reason = ?, last_activity_at = ?, updated_at = ?
      WHERE id = ? AND state_version = ? AND status NOT IN ('closing', 'closed')
    `).run(requiredString(reason, "runtimeBinding.closeReason"), now, now, bindingId, current.stateVersion);
    if (result.changes !== 1) {
      throw new StoreConflictError("请求关闭 RuntimeBinding 时状态已变化。");
    }
    this.#database.prepare("DELETE FROM runtime_binding_leases WHERE binding_id = ?")
      .run(bindingId);
    return this.get(bindingId);
  }

  finalizeClose(input: FinalizeRuntimeBindingCloseInput): RuntimeBinding {
    const current = this.get(input.bindingId);
    if (current.status === "closed") return current;
    if (
      current.status !== "closing" ||
      current.stateVersion !== input.expectedStateVersion ||
      (input.processInstanceId && current.processInstanceId !== input.processInstanceId)
    ) {
      throw new StoreConflictError("RuntimeBinding 关闭完成条件已经变化。");
    }
    const now = new Date(this.#now()).toISOString();
    const result = this.#database.prepare(`
      UPDATE runtime_bindings
      SET status = 'closed', state_version = state_version + 1,
          process_instance_id = NULL, close_reason = ?,
          last_activity_at = ?, updated_at = ?, closed_at = ?
      WHERE id = ? AND state_version = ? AND status = 'closing'
        AND NOT EXISTS (
          SELECT 1 FROM runtime_binding_leases WHERE binding_id = runtime_bindings.id
        )
    `).run(
      input.closeReason ?? current.closeReason ?? "closed",
      now,
      now,
      now,
      current.id,
      current.stateVersion,
    );
    if (result.changes !== 1) {
      throw new StoreConflictError("RuntimeBinding 关闭完成的 CAS 被拒绝。");
    }
    return this.get(current.id);
  }

  markInterrupted(processInstanceId: string): number {
    const normalized = requiredString(
      processInstanceId,
      "markRuntimeBindingsInterrupted.processInstanceId",
    );
    const now = new Date(this.#now()).toISOString();
    const ids = this.#database.prepare(`
      SELECT id
      FROM runtime_bindings
      WHERE process_instance_id IS NOT NULL
        AND process_instance_id <> ?
        AND status IN ('starting', 'ready', 'thinking', 'streaming')
    `).all(normalized) as unknown as Array<{ id: unknown }>;
    for (const row of ids) {
      this.requestCloseLeaseOnly(requiredString(row.id, "runtime_bindings.id"));
    }
    const result = this.#database.prepare(`
      UPDATE runtime_bindings
      SET status = 'interrupted', state_version = state_version + 1,
          epoch = epoch + 1, process_instance_id = NULL,
          last_activity_at = ?, updated_at = ?
      WHERE process_instance_id IS NOT NULL
        AND process_instance_id <> ?
        AND status IN ('starting', 'ready', 'thinking', 'streaming')
    `).run(now, now, normalized);
    return Number(result.changes);
  }

  closeIdle(beforeIso: string): number {
    const before = requiredString(beforeIso, "closeIdleRuntimeBindings.beforeIso");
    const pending = this.#database.prepare(`
      SELECT id
      FROM runtime_bindings
      WHERE status = 'closing'
        AND NOT EXISTS (
          SELECT 1 FROM runtime_binding_leases
          WHERE binding_id = runtime_bindings.id
        )
    `).all() as unknown as Array<{ id: unknown }>;
    for (const row of pending) {
      const binding = this.get(requiredString(row.id, "runtime_bindings.id"));
      this.finalizeClose({
        bindingId: binding.id,
        expectedStateVersion: binding.stateVersion,
        closeReason: binding.closeReason ?? "closed",
      });
    }
    const ids = this.#database.prepare(`
      SELECT id
      FROM runtime_bindings
      WHERE status = 'idle' AND last_activity_at < ?
    `).all(before) as unknown as Array<{ id: unknown }>;
    for (const row of ids) {
      const bindingId = requiredString(row.id, "runtime_bindings.id");
      const closing = this.requestClose(bindingId, "idle-timeout");
      if (closing.status !== "closed") {
        this.finalizeClose({
          bindingId,
          expectedStateVersion: closing.stateVersion,
          closeReason: "idle-timeout",
        });
      }
    }
    return pending.length + ids.length;
  }

  private requestCloseLeaseOnly(bindingId: string): void {
    this.#database.prepare("DELETE FROM runtime_binding_leases WHERE binding_id = ?")
      .run(bindingId);
  }

  #leaseRow(bindingId: string): RuntimeBindingLeaseRow | undefined {
    return this.#database.prepare(`
      SELECT binding_id, owner_id, lease_token, epoch, expires_at_ms
      FROM runtime_binding_leases
      WHERE binding_id = ?
    `).get(bindingId) as unknown as RuntimeBindingLeaseRow | undefined;
  }
}
