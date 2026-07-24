/**
 * @input  依赖：现有 Council SQLite、编排端口、严格快照 codec 与随机 ID
 * @output 导出：含分页、单活动约束与 lease fencing 的 SQLiteCouncilStore
 * @pos    以 SQLite CAS 和 token/epoch 保证跨进程执行与消息原子一致性
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  InvalidRunStateError,
  LeaseConflictError,
  LeaseLostError,
  RunNotFoundError,
  StoreConflictError,
} from "../errors.js";
import type { CouncilStore } from "../ports.js";
import type {
  ApproveGateInput,
  ApproveGateResult,
  ClaimRunLeaseInput,
  CouncilPublicMessage,
  CouncilTopicContext,
  CreateRunInput,
  ListRunsForTopicInput,
  ListRestartCandidatesInput,
  OrchestrationRun,
  PaginatedRuns,
  RenewRunLeaseInput,
  RoundCommitInput,
  RoundCommitResult,
  RunLease,
} from "../types.js";
import {
  MAX_APPROVAL_ID_CHARS,
  MAX_LEASE_OWNER_CHARS,
  MAX_MESSAGE_CHARS,
} from "../constants.js";
import {
  assertMessageKind,
  assertPublicAuthor,
  decodeRunSnapshot,
  encodeRunSnapshot,
  validateRunSnapshot,
} from "./run-codec.js";
import { assertOrchestrationSchema } from "./schema.js";

interface RunRow {
  id: unknown;
  topic_id: unknown;
  status: unknown;
  snapshot_schema_version: unknown;
  snapshot_json: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface ApprovalRow {
  gate_id: unknown;
  expected_version: unknown;
  approved_by: unknown;
}

interface TopicRow {
  id: unknown;
  title: unknown;
  question: unknown;
  constraints_json: unknown;
  project_path: unknown;
}

interface MessageRow {
  id: unknown;
  topic_id: unknown;
  author: unknown;
  kind: unknown;
  content: unknown;
  created_at: unknown;
}

interface LeaseRow {
  run_id: unknown;
  owner_id: unknown;
  lease_token: unknown;
  epoch: unknown;
  expires_at_ms: unknown;
}

interface CountRow {
  count: unknown;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const LEASABLE_STATUSES = new Set(["running", "waiting_agent"]);
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const GATE_ID_PATTERN = /^before_(?:completion|round:[1-9][0-9]*)$/;
const DEFAULT_CONTEXT_MESSAGE_LIMIT = 1_000;

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

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRunStateError(`${path} 必须是非负安全整数。`);
  }
  return value;
}

function leaseOwner(value: unknown, path: string): string {
  const owner = nonEmptyString(value, path);
  if (owner.length > MAX_LEASE_OWNER_CHARS || !LEASE_OWNER_PATTERN.test(owner)) {
    throw new InvalidRunStateError(`${path} 必须是有效的执行者标识。`);
  }
  return owner;
}

function safeExpiry(nowMs: number, ttlMs: number): number {
  positiveInteger(ttlMs, "lease.ttlMs");
  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new InvalidRunStateError("lease 到期时间超出安全整数范围。");
  }
  return expiresAtMs;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function strictStringArray(json: string, path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidRunStateError(`${path} 不是有效 JSON。`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new InvalidRunStateError(`${path} 必须是字符串数组。`);
  }
  return [...parsed];
}

function assertSameImmutableFields(current: OrchestrationRun, next: OrchestrationRun): void {
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

function decodeRunRow(row: RunRow): OrchestrationRun {
  const snapshotSchemaVersion = positiveInteger(
    row.snapshot_schema_version,
    "orchestration_runs.snapshot_schema_version",
  );
  if (snapshotSchemaVersion !== 1) {
    throw new InvalidRunStateError("不支持的运行快照结构版本。");
  }
  const snapshot = decodeRunSnapshot(nonEmptyString(row.snapshot_json, "snapshot_json"));
  const id = nonEmptyString(row.id, "orchestration_runs.id");
  const topicId = nonEmptyString(row.topic_id, "orchestration_runs.topic_id");
  const status = nonEmptyString(row.status, "orchestration_runs.status");
  const version = positiveInteger(row.version, "orchestration_runs.version");
  const createdAt = nonEmptyString(row.created_at, "orchestration_runs.created_at");
  const updatedAt = nonEmptyString(row.updated_at, "orchestration_runs.updated_at");
  if (
    snapshot.id !== id ||
    snapshot.topicId !== topicId ||
    snapshot.status !== status ||
    snapshot.version !== version ||
    snapshot.createdAt !== createdAt ||
    snapshot.updatedAt !== updatedAt
  ) {
    throw new InvalidRunStateError("运行快照与可索引列不一致。");
  }
  return snapshot;
}

export class SQLiteCouncilStore implements CouncilStore {
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #contextMessageLimit: number;
  #closed = false;

  constructor(
    databasePath: string,
    busyTimeoutMs: number,
    now: () => number = Date.now,
    contextMessageLimit: number = DEFAULT_CONTEXT_MESSAGE_LIMIT,
  ) {
    if (!databasePath.trim()) {
      throw new Error("SQLite 数据库路径不能为空。");
    }
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
      throw new Error("SQLite busy timeout 必须是正整数。");
    }
    if (!Number.isSafeInteger(contextMessageLimit) || contextMessageLimit <= 0) {
      throw new Error("SQLite Agent 上下文消息上限必须是正整数。");
    }
    this.#now = now;
    this.#contextMessageLimit = contextMessageLimit;
    const database = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      database.exec("PRAGMA journal_mode = WAL;");
      database.exec("PRAGMA synchronous = NORMAL;");
      assertOrchestrationSchema(database);
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
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

  #getRunRow(runId: string): RunRow {
    const row = this.#database
      .prepare("SELECT * FROM orchestration_runs WHERE id = ?")
      .get(runId) as unknown as RunRow | undefined;
    if (!row) {
      throw new RunNotFoundError(`编排运行 ${runId} 不存在。`);
    }
    return row;
  }

  #getRun(runId: string): OrchestrationRun {
    return decodeRunRow(this.#getRunRow(runId));
  }

  #getLeaseRow(runId: string): LeaseRow | undefined {
    return this.#database
      .prepare(`
        SELECT run_id, owner_id, lease_token, epoch, expires_at_ms
        FROM orchestration_run_leases
        WHERE run_id = ?
      `)
      .get(runId) as unknown as LeaseRow | undefined;
  }

  #leaseFromRow(row: LeaseRow): RunLease {
    return {
      runId: nonEmptyString(row.run_id, "orchestration_run_leases.run_id"),
      ownerId: leaseOwner(row.owner_id, "orchestration_run_leases.owner_id"),
      token: nonEmptyString(row.lease_token, "orchestration_run_leases.lease_token"),
      epoch: positiveInteger(row.epoch, "orchestration_run_leases.epoch"),
      expiresAtMs: positiveInteger(
        row.expires_at_ms,
        "orchestration_run_leases.expires_at_ms",
      ),
    };
  }

  #assertLease(lease: RunLease, nowMs: number): RunLease {
    const runId = nonEmptyString(lease.runId, "lease.runId");
    const ownerId = leaseOwner(lease.ownerId, "lease.ownerId");
    const token = nonEmptyString(lease.token, "lease.token");
    const epoch = positiveInteger(lease.epoch, "lease.epoch");
    const row = this.#getLeaseRow(runId);
    if (!row) {
      throw new LeaseLostError("运行没有有效的执行 lease。");
    }
    const current = this.#leaseFromRow(row);
    if (
      current.ownerId !== ownerId ||
      current.token !== token ||
      current.epoch !== epoch ||
      current.expiresAtMs <= nowMs
    ) {
      throw new LeaseLostError("执行 lease 已过期或被其他执行者接管。");
    }
    return current;
  }

  #assertTopicExists(topicId: string): void {
    const row = this.#database
      .prepare("SELECT id FROM topics WHERE id = ?")
      .get(topicId) as unknown as Pick<TopicRow, "id"> | undefined;
    if (!row || row.id !== topicId) {
      throw new InvalidRunStateError(`Council 议题 ${topicId} 不存在。`);
    }
  }

  #saveRun(
    current: OrchestrationRun,
    desired: OrchestrationRun,
    expectedVersion: number,
    now: string,
  ): OrchestrationRun {
    if (current.version !== expectedVersion || desired.version !== expectedVersion) {
      throw new StoreConflictError("运行版本与 CAS 前置条件不一致。");
    }
    assertSameImmutableFields(current, desired);
    const saved = validateRunSnapshot({
      ...desired,
      version: expectedVersion + 1,
      updatedAt: now,
    });
    let result;
    try {
      result = this.#database.prepare(`
        UPDATE orchestration_runs
        SET topic_id = ?, status = ?, snapshot_json = ?, version = ?,
            created_at = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        saved.topicId,
        saved.status,
        encodeRunSnapshot(saved),
        saved.version,
        saved.createdAt,
        saved.updatedAt,
        saved.id,
        expectedVersion,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new StoreConflictError("同一议题已经存在活动编排运行。");
      }
      throw error;
    }
    if (result.changes !== 1) {
      throw new StoreConflictError("运行版本已变化，CAS 更新被拒绝。");
    }
    return saved;
  }

  async createRun(input: CreateRunInput): Promise<OrchestrationRun> {
    const now = new Date(this.#now()).toISOString();
    const run = validateRunSnapshot({
      id: `run_${randomUUID()}`,
      topicId: input.topicId,
      status: "idle",
      plan: input.plan,
      policy: input.policy,
      nextRoundIndex: 0,
      currentAttempt: 0,
      manualRecoveriesUsed: 0,
      confirmedGates: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return this.#transaction(() => {
      this.#assertTopicExists(run.topicId);
      try {
        this.#database.prepare(`
          INSERT INTO orchestration_runs (
            id, topic_id, status, snapshot_schema_version, snapshot_json,
            version, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        `).run(
          run.id,
          run.topicId,
          run.status,
          encodeRunSnapshot(run),
          run.version,
          run.createdAt,
          run.updatedAt,
        );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new StoreConflictError("同一议题已经存在活动编排运行。");
        }
        throw error;
      }
      return run;
    });
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    return this.#getRun(nonEmptyString(runId, "runId"));
  }

  async listRunsForTopic(input: ListRunsForTopicInput): Promise<PaginatedRuns> {
    const topicId = nonEmptyString(input.topicId, "listRunsForTopic.topicId");
    const limit = positiveInteger(input.limit, "listRunsForTopic.limit");
    const offset = nonNegativeInteger(input.offset, "listRunsForTopic.offset");
    this.#assertTopicExists(topicId);
    const countRow = this.#database
      .prepare("SELECT COUNT(*) AS count FROM orchestration_runs WHERE topic_id = ?")
      .get(topicId) as unknown as CountRow;
    const total = nonNegativeInteger(countRow.count, "orchestration_runs.count");
    const rows = this.#database
      .prepare(`
        SELECT * FROM orchestration_runs
        WHERE topic_id = ?
        ORDER BY updated_at DESC, rowid DESC
        LIMIT ? OFFSET ?
      `)
      .all(topicId, limit, offset) as unknown as RunRow[];
    const runs = rows.map(decodeRunRow);
    const nextOffset = offset + runs.length;
    const hasMore = nextOffset < total;
    return {
      total,
      count: runs.length,
      offset,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      runs,
    };
  }

  async listRestartCandidates(input: ListRestartCandidatesInput): Promise<PaginatedRuns> {
    const limit = positiveInteger(input.limit, "listRestartCandidates.limit");
    const offset = nonNegativeInteger(input.offset, "listRestartCandidates.offset");
    const countRow = this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM orchestration_runs
        WHERE status IN ('running', 'waiting_agent')
      `)
      .get() as unknown as CountRow;
    const total = nonNegativeInteger(countRow.count, "orchestration_restart_candidates.count");
    const rows = this.#database
      .prepare(`
        SELECT * FROM orchestration_runs
        WHERE status IN ('running', 'waiting_agent')
        ORDER BY updated_at ASC, id ASC
        LIMIT ? OFFSET ?
      `)
      .all(limit, offset) as unknown as RunRow[];
    const runs = rows.map(decodeRunRow);
    const nextOffset = offset + runs.length;
    const hasMore = nextOffset < total;
    return {
      total,
      count: runs.length,
      offset,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      runs,
    };
  }

  async replaceRun(
    run: OrchestrationRun,
    expectedVersion: number,
  ): Promise<OrchestrationRun> {
    positiveInteger(expectedVersion, "expectedVersion");
    const desired = validateRunSnapshot(run);
    return this.#transaction(() => {
      const current = this.#getRun(desired.id);
      if (current.version !== expectedVersion) {
        throw new StoreConflictError("运行版本已变化，无法替换。");
      }
      return this.#saveRun(
        current,
        desired,
        expectedVersion,
        new Date(this.#now()).toISOString(),
      );
    });
  }

  async replaceRunWithLease(
    run: OrchestrationRun,
    expectedVersion: number,
    lease: RunLease,
  ): Promise<OrchestrationRun> {
    positiveInteger(expectedVersion, "expectedVersion");
    const desired = validateRunSnapshot(run);
    return this.#transaction(() => {
      const nowMs = this.#now();
      this.#assertLease(lease, nowMs);
      if (lease.runId !== desired.id) {
        throw new LeaseLostError("执行 lease 不属于当前运行。");
      }
      const current = this.#getRun(desired.id);
      if (current.version !== expectedVersion) {
        throw new StoreConflictError("运行版本已变化，无法替换。");
      }
      return this.#saveRun(
        current,
        desired,
        expectedVersion,
        new Date(nowMs).toISOString(),
      );
    });
  }

  async cancelRun(runId: string): Promise<OrchestrationRun> {
    const normalizedRunId = nonEmptyString(runId, "runId");
    return this.#transaction(() => {
      const current = this.#getRun(normalizedRunId);
      if (TERMINAL_STATUSES.has(current.status)) {
        return current;
      }
      const {
        activeAgentId: _activeAgentId,
        pendingGateId: _pendingGateId,
        stopReason: _stopReason,
        failure: _failure,
        ...stable
      } = current;
      const desired: OrchestrationRun = { ...stable, status: "cancelled" };
      const cancelled = this.#saveRun(
        current,
        desired,
        current.version,
        new Date(this.#now()).toISOString(),
      );
      this.#database
        .prepare("DELETE FROM orchestration_run_leases WHERE run_id = ?")
        .run(normalizedRunId);
      return cancelled;
    });
  }

  async approveGate(input: ApproveGateInput): Promise<ApproveGateResult> {
    const runId = nonEmptyString(input.runId, "approveGate.runId");
    const approvalId = nonEmptyString(input.approvalId, "approveGate.approvalId");
    const gateId = nonEmptyString(input.expectedGateId, "approveGate.expectedGateId");
    const expectedVersion = positiveInteger(input.expectedVersion, "approveGate.expectedVersion");
    if (
      approvalId.length > MAX_APPROVAL_ID_CHARS ||
      !APPROVAL_ID_PATTERN.test(approvalId)
    ) {
      throw new InvalidRunStateError("approveGate.approvalId 格式无效。");
    }
    if (!GATE_ID_PATTERN.test(gateId)) {
      throw new InvalidRunStateError("approveGate.expectedGateId 格式无效。");
    }
    if (input.approvedBy !== "human") {
      throw new InvalidRunStateError("人工确认门只能由 human 批准。");
    }

    return this.#transaction(() => {
      const existing = this.#database
        .prepare(`
          SELECT gate_id, expected_version, approved_by
          FROM orchestration_approvals
          WHERE run_id = ? AND approval_id = ?
        `)
        .get(runId, approvalId) as unknown as ApprovalRow | undefined;
      if (existing) {
        if (
          existing.gate_id !== gateId ||
          existing.expected_version !== expectedVersion ||
          existing.approved_by !== input.approvedBy
        ) {
          throw new StoreConflictError("同一个 approvalId 不能表示不同的批准操作。");
        }
        return { run: this.#getRun(runId), applied: false };
      }

      const current = this.#getRun(runId);
      if (
        current.version !== expectedVersion ||
        current.status !== "waiting_user" ||
        current.pendingGateId !== gateId
      ) {
        throw new StoreConflictError("人工批准的门或运行版本已经变化。");
      }
      const { pendingGateId: _pendingGateId, ...stable } = current;
      const desired: OrchestrationRun = {
        ...stable,
        status: "running",
        confirmedGates: [...current.confirmedGates, gateId],
      };
      const now = new Date(this.#now()).toISOString();
      const saved = this.#saveRun(current, desired, expectedVersion, now);
      this.#database
        .prepare(`
          INSERT INTO orchestration_approvals (
            run_id, approval_id, gate_id, expected_version,
            approved_by, applied_run_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          runId,
          approvalId,
          gateId,
          expectedVersion,
          input.approvedBy,
          saved.version,
          now,
        );
      return { run: saved, applied: true };
    });
  }

  async getTopicContext(topicId: string): Promise<CouncilTopicContext> {
    const normalizedTopicId = nonEmptyString(topicId, "topicId");
    const topic = this.#database
      .prepare(`
        SELECT id, title, question, constraints_json, project_path
        FROM topics
        WHERE id = ?
      `)
      .get(normalizedTopicId) as unknown as TopicRow | undefined;
    if (!topic) {
      throw new InvalidRunStateError(`Council 议题 ${normalizedTopicId} 不存在。`);
    }
    const storedTopicId = nonEmptyString(topic.id, "topics.id");
    if (storedTopicId !== normalizedTopicId) {
      throw new InvalidRunStateError("议题查询返回了不一致的标识。");
    }
    const constraintsJson = nonEmptyString(topic.constraints_json, "topics.constraints_json");
    const projectPath = topic.project_path === null
      ? undefined
      : nonEmptyString(topic.project_path, "topics.project_path");
    const rows = this.#database
      .prepare(`
        SELECT id, topic_id, author, kind, content, created_at
        FROM messages
        WHERE topic_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(normalizedTopicId, this.#contextMessageLimit) as unknown as MessageRow[];
    rows.reverse();
    const messages = rows.map((row, index): CouncilPublicMessage => {
      const author = row.author;
      const kind = row.kind;
      assertPublicAuthor(author, `messages[${String(index)}].author`);
      assertMessageKind(kind, `messages[${String(index)}].kind`);
      const messageTopicId = nonEmptyString(row.topic_id, `messages[${String(index)}].topic_id`);
      if (messageTopicId !== normalizedTopicId) {
        throw new InvalidRunStateError("消息不属于请求的议题。");
      }
      return {
        id: nonEmptyString(row.id, `messages[${String(index)}].id`),
        topicId: messageTopicId,
        author,
        kind,
        content: nonEmptyString(row.content, `messages[${String(index)}].content`),
        createdAt: nonEmptyString(row.created_at, `messages[${String(index)}].created_at`),
      };
    });
    return {
      topicId: normalizedTopicId,
      title: nonEmptyString(topic.title, "topics.title"),
      question: nonEmptyString(topic.question, "topics.question"),
      constraints: strictStringArray(constraintsJson, "topics.constraints_json"),
      ...(projectPath ? { projectPath } : {}),
      messages,
    };
  }

  async commitRound(input: RoundCommitInput): Promise<RoundCommitResult> {
    const expectedVersion = positiveInteger(input.expectedVersion, "commitRound.expectedVersion");
    const desired = validateRunSnapshot(input.run);
    const messageTopicId = nonEmptyString(input.message.topicId, "commitRound.message.topicId");
    const content = nonEmptyString(input.message.content, "commitRound.message.content");
    assertPublicAuthor(input.message.author, "commitRound.message.author");
    assertMessageKind(input.message.kind, "commitRound.message.kind");
    if (content.trim().length === 0) {
      throw new InvalidRunStateError("commitRound.message.content 不能只有空白。");
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new InvalidRunStateError("commitRound.message.content 超过长度上限。");
    }

    return this.#transaction(() => {
      const nowMs = this.#now();
      this.#assertLease(input.lease, nowMs);
      if (input.lease.runId !== desired.id) {
        throw new LeaseLostError("执行 lease 不属于当前运行。");
      }
      const current = this.#getRun(desired.id);
      const round = current.plan[current.nextRoundIndex];
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
        input.message.author !== round.publicAuthor ||
        input.message.kind !== round.messageKind
      ) {
        throw new StoreConflictError("轮次已取消、过期或不符合原子提交状态转换。");
      }
      assertSameImmutableFields(current, desired);
      const now = new Date(nowMs).toISOString();
      const saved = this.#saveRun(current, desired, expectedVersion, now);
      const message: CouncilPublicMessage = {
        id: `message_${randomUUID()}`,
        topicId: messageTopicId,
        author: input.message.author,
        kind: input.message.kind,
        content,
        createdAt: now,
      };
      this.#database
        .prepare(`
          INSERT INTO messages (
            id, topic_id, author, kind, content, parent_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?)
        `)
        .run(
          message.id,
          message.topicId,
          message.author,
          message.kind,
          message.content,
          message.createdAt,
        );
      this.#database
        .prepare("UPDATE topics SET updated_at = ? WHERE id = ?")
        .run(now, message.topicId);
      return { run: saved, message };
    });
  }

  async claimRunLease(input: ClaimRunLeaseInput): Promise<RunLease> {
    const runId = nonEmptyString(input.runId, "claimRunLease.runId");
    const ownerId = leaseOwner(input.ownerId, "claimRunLease.ownerId");
    const ttlMs = positiveInteger(input.ttlMs, "claimRunLease.ttlMs");
    return this.#transaction(() => {
      const run = this.#getRun(runId);
      if (!LEASABLE_STATUSES.has(run.status)) {
        throw new LeaseConflictError(`状态 ${run.status} 不允许获取执行 lease。`);
      }
      const nowMs = this.#now();
      const expiresAtMs = safeExpiry(nowMs, ttlMs);
      const currentRow = this.#getLeaseRow(runId);
      if (!currentRow) {
        const lease: RunLease = {
          runId,
          ownerId,
          token: `lease_${randomUUID()}`,
          epoch: 1,
          expiresAtMs,
        };
        this.#database
          .prepare(`
            INSERT INTO orchestration_run_leases (
              run_id, owner_id, lease_token, epoch, expires_at_ms, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(
            lease.runId,
            lease.ownerId,
            lease.token,
            lease.epoch,
            lease.expiresAtMs,
            new Date(nowMs).toISOString(),
          );
        return lease;
      }
      const current = this.#leaseFromRow(currentRow);
      if (current.expiresAtMs > nowMs) {
        if (current.ownerId === ownerId) {
          const renewed: RunLease = { ...current, expiresAtMs };
          const result = this.#database
            .prepare(`
              UPDATE orchestration_run_leases
              SET expires_at_ms = ?, updated_at = ?
              WHERE run_id = ? AND lease_token = ? AND epoch = ?
            `)
            .run(
              renewed.expiresAtMs,
              new Date(nowMs).toISOString(),
              renewed.runId,
              renewed.token,
              renewed.epoch,
            );
          if (result.changes !== 1) {
            throw new LeaseLostError("刷新已有执行 lease 时所有权已变化。");
          }
          return renewed;
        }
        throw new LeaseConflictError("运行已由另一个执行者持有有效 lease。");
      }
      const lease: RunLease = {
        runId,
        ownerId,
        token: `lease_${randomUUID()}`,
        epoch: current.epoch + 1,
        expiresAtMs,
      };
      const result = this.#database
        .prepare(`
          UPDATE orchestration_run_leases
          SET owner_id = ?, lease_token = ?, epoch = ?, expires_at_ms = ?, updated_at = ?
          WHERE run_id = ? AND epoch = ?
        `)
        .run(
          lease.ownerId,
          lease.token,
          lease.epoch,
          lease.expiresAtMs,
          new Date(nowMs).toISOString(),
          runId,
          current.epoch,
        );
      if (result.changes !== 1) {
        throw new LeaseLostError("接管过期执行 lease 时所有权已变化。");
      }
      return lease;
    });
  }

  async renewRunLease(input: RenewRunLeaseInput): Promise<RunLease> {
    const ttlMs = positiveInteger(input.ttlMs, "renewRunLease.ttlMs");
    return this.#transaction(() => {
      const nowMs = this.#now();
      const current = this.#assertLease(input.lease, nowMs);
      const renewed: RunLease = {
        ...current,
        expiresAtMs: safeExpiry(nowMs, ttlMs),
      };
      const result = this.#database
        .prepare(`
          UPDATE orchestration_run_leases
          SET expires_at_ms = ?, updated_at = ?
          WHERE run_id = ? AND lease_token = ? AND epoch = ?
        `)
        .run(
          renewed.expiresAtMs,
          new Date(nowMs).toISOString(),
          renewed.runId,
          renewed.token,
          renewed.epoch,
        );
      if (result.changes !== 1) {
        throw new LeaseLostError("续租期间执行 lease 已被接管。");
      }
      return renewed;
    });
  }

  async releaseRunLease(lease: RunLease): Promise<boolean> {
    const runId = nonEmptyString(lease.runId, "releaseRunLease.runId");
    const ownerId = leaseOwner(lease.ownerId, "releaseRunLease.ownerId");
    const token = nonEmptyString(lease.token, "releaseRunLease.token");
    const epoch = positiveInteger(lease.epoch, "releaseRunLease.epoch");
    return this.#transaction(() => {
      const nowMs = this.#now();
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
        throw new InvalidRunStateError("当前时间不能用于释放 lease。");
      }
      const result = this.#database
        .prepare(`
          UPDATE orchestration_run_leases
          SET lease_token = ?, expires_at_ms = ?, updated_at = ?
          WHERE run_id = ? AND owner_id = ? AND lease_token = ? AND epoch = ?
        `)
        .run(
          `released_${randomUUID()}`,
          nowMs,
          new Date(nowMs).toISOString(),
          runId,
          ownerId,
          token,
          epoch,
        );
      return result.changes === 1;
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }
}
