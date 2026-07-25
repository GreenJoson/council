/**
 * @input  依赖：未知 SQLite RuntimeBinding/lease 行与编排公开类型
 * @output 导出：严格 RuntimeBinding/lease 解码、状态与 transport 校验
 * @pos    SQLiteCouncilStore 的 RuntimeBinding 持久化防腐层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { InvalidRunStateError } from "../errors.js";
import type {
  RuntimeBinding,
  RuntimeBindingLease,
  RuntimeBindingStatus,
  RuntimeTransportKind,
} from "../types.js";

export interface RuntimeBindingRow {
  id: unknown;
  topic_id: unknown;
  agent_id: unknown;
  actor_id: unknown;
  provider_id: unknown;
  binding_revision: unknown;
  agent_config_revision: unknown;
  provider_config_revision: unknown;
  project_path: unknown;
  transport_kind: unknown;
  session_id: unknown;
  cursor_created_at: unknown;
  cursor_message_id: unknown;
  status: unknown;
  state_version: unknown;
  epoch: unknown;
  process_instance_id: unknown;
  last_activity_at: unknown;
  close_reason: unknown;
  created_at: unknown;
  updated_at: unknown;
  closed_at: unknown;
}

export interface RuntimeBindingLeaseRow {
  binding_id: unknown;
  owner_id: unknown;
  lease_token: unknown;
  epoch: unknown;
  expires_at_ms: unknown;
}

const STATUS_VALUES: readonly RuntimeBindingStatus[] = [
  "starting",
  "ready",
  "thinking",
  "streaming",
  "idle",
  "interrupted",
  "closing",
  "closed",
];

const TRANSPORT_VALUES: readonly RuntimeTransportKind[] = [
  "claude-resume",
  "codex-resume",
  "openai-sessionless",
];

function fail(message: string): never {
  throw new InvalidRunStateError(`SQLite RuntimeBinding 损坏：${message}`);
}

export function runtimeString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    fail(`${path} 必须是非空字符串。`);
  }
  return value;
}

export function runtimeOptionalString(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return runtimeString(value, path);
}

export function runtimePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${path} 必须是正安全整数。`);
  }
  return value;
}

export function runtimeNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${path} 必须是非负安全整数。`);
  }
  return value;
}

export function runtimeBindingStatus(value: unknown): RuntimeBindingStatus {
  if (typeof value !== "string" || !STATUS_VALUES.includes(value as RuntimeBindingStatus)) {
    fail("status 无效。");
  }
  return value as RuntimeBindingStatus;
}

export function runtimeTransportKind(value: unknown): RuntimeTransportKind {
  if (typeof value !== "string" || !TRANSPORT_VALUES.includes(value as RuntimeTransportKind)) {
    fail("transport_kind 无效。");
  }
  return value as RuntimeTransportKind;
}

export function decodeRuntimeBinding(row: RuntimeBindingRow): RuntimeBinding {
  const status = runtimeBindingStatus(row.status);
  const cursorCreatedAt = runtimeOptionalString(row.cursor_created_at, "cursor_created_at");
  const cursorMessageId = runtimeOptionalString(row.cursor_message_id, "cursor_message_id");
  if (Boolean(cursorCreatedAt) !== Boolean(cursorMessageId)) {
    fail("cursor 必须同时包含时间与消息 ID。");
  }
  const closedAt = runtimeOptionalString(row.closed_at, "closed_at");
  if ((status === "closed") !== Boolean(closedAt)) {
    fail("closed 状态与 closed_at 不一致。");
  }
  return {
    id: runtimeString(row.id, "id"),
    topicId: runtimeString(row.topic_id, "topic_id"),
    agentId: runtimeString(row.agent_id, "agent_id"),
    actorId: runtimeString(row.actor_id, "actor_id"),
    providerId: runtimeString(row.provider_id, "provider_id"),
    bindingRevision: runtimeString(row.binding_revision, "binding_revision"),
    agentConfigRevision: runtimePositiveInteger(
      row.agent_config_revision,
      "agent_config_revision",
    ),
    providerConfigRevision: runtimePositiveInteger(
      row.provider_config_revision,
      "provider_config_revision",
    ),
    ...(runtimeOptionalString(row.project_path, "project_path")
      ? { projectPath: row.project_path as string }
      : {}),
    transportKind: runtimeTransportKind(row.transport_kind),
    ...(runtimeOptionalString(row.session_id, "session_id")
      ? { sessionId: row.session_id as string }
      : {}),
    ...(cursorCreatedAt && cursorMessageId
      ? { cursor: { createdAt: cursorCreatedAt, messageId: cursorMessageId } }
      : {}),
    status,
    stateVersion: runtimePositiveInteger(row.state_version, "state_version"),
    epoch: runtimeNonNegativeInteger(row.epoch, "epoch"),
    ...(runtimeOptionalString(row.process_instance_id, "process_instance_id")
      ? { processInstanceId: row.process_instance_id as string }
      : {}),
    lastActivityAt: runtimeString(row.last_activity_at, "last_activity_at"),
    ...(runtimeOptionalString(row.close_reason, "close_reason")
      ? { closeReason: row.close_reason as string }
      : {}),
    createdAt: runtimeString(row.created_at, "created_at"),
    updatedAt: runtimeString(row.updated_at, "updated_at"),
    ...(closedAt ? { closedAt } : {}),
  };
}

export function decodeRuntimeBindingLease(
  row: RuntimeBindingLeaseRow,
): RuntimeBindingLease {
  return {
    bindingId: runtimeString(row.binding_id, "lease.binding_id"),
    ownerId: runtimeString(row.owner_id, "lease.owner_id"),
    token: runtimeString(row.lease_token, "lease.lease_token"),
    epoch: runtimePositiveInteger(row.epoch, "lease.epoch"),
    expiresAtMs: runtimePositiveInteger(row.expires_at_ms, "lease.expires_at_ms"),
  };
}
