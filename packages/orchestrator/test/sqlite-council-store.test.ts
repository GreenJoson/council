/**
 * @input  依赖：临时 Council SQLite、两个 Store 连接与编排领域类型
 * @output 导出：历史映射/原子升级、v6 持久会话、逻辑请求幂等、双 lease、CAS 和损坏数据测试
 * @pos    SQLiteCouncilStore 双连接 fencing 与安全边界验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DISCUSSION_CYCLE_SCHEMA_SQL,
  InvalidRunStateError,
  readActiveDiscussionCycle,
  startDiscussionCycle,
  deriveCycleRequirements,
  LEGACY_AGENT_CLEANUP_TIMEOUT_MS,
  LeaseConflictError,
  LeaseLostError,
  ORCHESTRATION_SCHEMA_SQL,
  RUNTIME_BINDING_SCHEMA_SQL,
  SQLiteCouncilStore,
  StoreConflictError,
} from "../src/index.js";
import type {
  CreateRunInput,
  OrchestrationRun,
  ActorId,
  RoundCommitInput,
  RunLease,
  RuntimeBindingLease,
  RuntimeTransportKind,
} from "../src/types.js";

const BUSY_TIMEOUT_MS = 5_000;
const TOPIC_ID = "topic_sqlite_store_test";

function cycleStartInput(participants: readonly string[]) {
  return {
    kind: "discussion" as const,
    requirements: deriveCycleRequirements({
      kind: "discussion",
      participants,
    }),
    runtimeCapabilities: participants.map((adapterId) => ({
      schemaVersion: 1 as const,
      adapterId,
      actorId: adapterId,
      agentConfigRevision: 1,
      providerId: `provider-${adapterId}`,
      providerConfigRevision: 1,
      bindingRevision: `test:${adapterId}`,
      transportKind: "test",
      declared: ["text" as const],
      granted: ["text" as const],
    })),
  };
}

function createBaseDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        project_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'closed')),
        created_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
        created_by_snapshot_json TEXT NOT NULL,
        created_by_legacy TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        author_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
        author_snapshot_json TEXT NOT NULL,
        author_legacy TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('brief', 'proposal', 'critique', 'rebuttal', 'synthesis', 'note')),
        content TEXT NOT NULL,
        parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        decision TEXT NOT NULL,
        rationale TEXT NOT NULL,
        alternatives_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('proposed', 'accepted', 'rejected', 'superseded')
        ),
        created_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
        created_by_snapshot_json TEXT NOT NULL,
        created_by_legacy TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE council_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE actor_identities (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        role TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'system', 'agent', 'legacy')),
        status TEXT NOT NULL CHECK (status IN ('active', 'needs_review', 'inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE actor_aliases (
        alias TEXT PRIMARY KEY COLLATE NOCASE,
        actor_id TEXT NOT NULL REFERENCES actor_identities(id) ON DELETE CASCADE,
        alias_kind TEXT NOT NULL CHECK (alias_kind IN ('canonical', 'legacy', 'adapter')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE provider_profiles (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE agent_definitions (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL UNIQUE REFERENCES actor_identities(id),
        provider_id TEXT NOT NULL REFERENCES provider_profiles(id),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        deleted_at TEXT
      );
      INSERT INTO council_meta (key, value) VALUES ('revision', 0);
      CREATE TRIGGER trg_topics_revision_update
        AFTER UPDATE ON topics BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        END;
      CREATE TRIGGER trg_messages_revision_insert
        AFTER INSERT ON messages BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        END;
    `);
    database.exec(ORCHESTRATION_SCHEMA_SQL);
    database.exec(RUNTIME_BINDING_SCHEMA_SQL);
    database.exec(DISCUSSION_CYCLE_SCHEMA_SQL);
    database.exec(`
      ALTER TABLE discussion_cycles ADD COLUMN
        cycle_kind TEXT NOT NULL DEFAULT 'discussion';
      ALTER TABLE discussion_cycles ADD COLUMN
        requirements_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE discussion_cycles ADD COLUMN
        capability_snapshot_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE discussion_cycles ADD COLUMN
        outcome_json TEXT;
    `);
    const now = new Date().toISOString();
    const actorSeed = database.prepare(`
      INSERT INTO actor_identities (
        id, slug, display_name, short_name, role, actor_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const aliasSeed = database.prepare(`
      INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
      VALUES (?, ?, 'canonical', ?)
    `);
    for (const actor of [
      ["human", "human", "User", "U", "决策者", "human", "active"],
      ["claude", "claude", "Claude", "CL", "方案顾问", "agent", "active"],
      ["codex", "codex", "Codex", "CX", "代码审查", "agent", "active"],
      ["deepseek", "deepseek", "DeepSeek", "DS", "模型顾问", "agent", "active"],
      ["kimi", "kimi", "Kimi", "KI", "模型顾问", "agent", "active"],
      [
        "legacy-unknown",
        "legacy-unknown",
        "Legacy unknown",
        "?",
        "待人工识别的历史参与者",
        "legacy",
        "needs_review",
      ],
    ] as const) {
      actorSeed.run(...actor, now, now);
      if (actor[6] === "active") {
        aliasSeed.run(actor[0], actor[0], now);
      }
    }
    database.prepare(`
      INSERT INTO provider_profiles (id, status)
      VALUES ('provider_test', 'active')
    `).run();
    database.prepare(`
      INSERT INTO agent_definitions (
        id, actor_id, provider_id, enabled, deleted_at
      ) VALUES ('alpha', 'claude', 'provider_test', 1, NULL)
    `).run();
    const humanSnapshot = JSON.stringify({
      schemaVersion: 1,
      actorId: "human",
      slug: "human",
      displayName: "User",
      shortName: "U",
      role: "决策者",
    });
    database
      .prepare(`
        INSERT INTO topics (
          id, title, question, constraints_json, project_path,
          status, created_by_actor_id, created_by_snapshot_json, created_by_legacy,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', 'human', ?, NULL, ?, ?)
      `)
      .run(
        TOPIC_ID,
        "SQLite 编排一致性",
        "双连接能否只提交一轮？",
        JSON.stringify(["取消后禁止写入"]),
        path.dirname(databasePath),
        humanSnapshot,
        now,
        now,
      );
    database.prepare(`
      INSERT INTO runtime_bindings (
        id, topic_id, agent_id, actor_id, provider_id, binding_revision,
        agent_config_revision, provider_config_revision, project_path,
        transport_kind, session_id, cursor_created_at, cursor_message_id,
        status, state_version, epoch, process_instance_id, last_activity_at,
        close_reason, created_at, updated_at, closed_at
      ) VALUES (
        'binding_alpha', ?, 'alpha', 'claude', 'provider_test',
        'test-binding:alpha:v1', 1, 1, ?, 'openai-sessionless',
        NULL, NULL, NULL, 'idle', 1, 0, NULL, ?, NULL, ?, ?, NULL
      )
    `).run(TOPIC_ID, path.dirname(databasePath), now, now, now);
  } finally {
    database.close();
  }
}

function withDatabase(
  operation: (databasePath: string, directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "council-orchestrator-store-"));
  const databasePath = path.join(directory, "council.sqlite3");
  createBaseDatabase(databasePath);
  return operation(databasePath, directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function createInput(options?: {
  rounds?: number;
  beforeRounds?: readonly number[];
}): CreateRunInput {
  const rounds = options?.rounds ?? 1;
  return {
    topicId: TOPIC_ID,
    plan: Array.from({ length: rounds }, (_value, index) => ({
      adapterId: "alpha",
      actorId: "claude",
      bindingRevision: "test-binding:alpha:v1",
      runtimeBindingId: "binding_alpha",
      messageKind: index % 2 === 0 ? "proposal" : "critique",
      instruction: `执行第 ${String(index + 1)} 轮`,
    })),
    policy: {
      maxRounds: rounds,
      allowedAgents: ["alpha"],
      agentTimeoutMs: 1_000,
      agentCleanupTimeoutMs: 100,
      maxAttemptsPerRound: 1,
      maxManualRecoveries: 1,
      confirmation: {
        beforeRounds: options?.beforeRounds ?? [],
        beforeCompletion: false,
      },
    },
  };
}

interface LegacyRunRound {
  adapterId: string;
  actorId?: string;
  bindingRevision?: string;
  runtimeBindingId?: string;
  requestMessageId?: string;
  publicAuthor?: string;
  messageKind: string;
  instruction: string;
}

function convertRunToV1(
  databasePath: string,
  runId: string,
  adapterId: string,
  publicAuthor: "human" | "claude" | "codex" | "chair" | "other",
): void {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(
      "SELECT snapshot_json FROM orchestration_runs WHERE id = ?",
    ).get(runId) as unknown as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as {
      plan: LegacyRunRound[];
      activeAgentId?: string;
      policy: {
        allowedAgents: string[];
        agentCleanupTimeoutMs?: number;
      };
    };
    snapshot.plan = snapshot.plan.map(({
      actorId: _actorId,
      bindingRevision: _bindingRevision,
      runtimeBindingId: _runtimeBindingId,
      requestMessageId: _requestMessageId,
      ...round
    }) => ({
      ...round,
      adapterId,
      publicAuthor,
    }));
    snapshot.policy.allowedAgents = [adapterId];
    if (snapshot.activeAgentId !== undefined) {
      snapshot.activeAgentId = adapterId;
    }
    delete snapshot.policy.agentCleanupTimeoutMs;
    database.prepare(`
      UPDATE orchestration_runs
      SET snapshot_schema_version = 1, snapshot_json = ?
      WHERE id = ?
    `).run(JSON.stringify(snapshot), runId);
  } finally {
    database.close();
  }
}

function convertRunToV2WithoutBindingRevision(
  databasePath: string,
  runId: string,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(
      "SELECT snapshot_json FROM orchestration_runs WHERE id = ?",
    ).get(runId) as unknown as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as {
      plan: LegacyRunRound[];
    };
    snapshot.plan = snapshot.plan.map(({
      bindingRevision: _bindingRevision,
      runtimeBindingId: _runtimeBindingId,
      requestMessageId: _requestMessageId,
      ...round
    }) => round);
    database.prepare(`
      UPDATE orchestration_runs
      SET snapshot_schema_version = 2, snapshot_json = ?
      WHERE id = ?
    `).run(JSON.stringify(snapshot), runId);
  } finally {
    database.close();
  }
}

function readSnapshotSchemaVersion(databasePath: string, runId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT snapshot_schema_version
      FROM orchestration_runs
      WHERE id = ?
    `).get(runId) as unknown as { snapshot_schema_version: number };
    return row.snapshot_schema_version;
  } finally {
    database.close();
  }
}

async function moveToWaitingAgent(
  store: SQLiteCouncilStore,
  created: OrchestrationRun,
): Promise<OrchestrationRun> {
  const running = await store.replaceRun({ ...created, status: "running" }, created.version);
  return await store.replaceRun(
    {
      ...running,
      status: "waiting_agent",
      activeAgentId: "alpha",
      currentAttempt: 1,
    },
    running.version,
  );
}

async function prepareBindingLease(
  store: SQLiteCouncilStore,
  waiting: OrchestrationRun,
  transportKind: RuntimeTransportKind = "openai-sessionless",
): Promise<RuntimeBindingLease> {
  const round = waiting.plan[waiting.nextRoundIndex];
  if (!round?.runtimeBindingId || !round.bindingRevision) {
    throw new Error("测试轮次缺少 RuntimeBinding 冻结字段。");
  }
  const ensured = await store.ensureRuntimeBinding({
    topicId: waiting.topicId,
    agentId: round.adapterId,
    actorId: round.actorId,
    providerId: "provider_test",
    bindingRevision: round.bindingRevision,
    agentConfigRevision: 1,
    providerConfigRevision: 1,
    transportKind,
    processInstanceId: "test-process",
  });
  assert.equal(ensured.id, round.runtimeBindingId);
  const bindingLease = await store.claimRuntimeBindingLease({
    bindingId: ensured.id,
    ownerId: `run:${waiting.id}`,
    ttlMs: 60_000,
    processInstanceId: "test-process",
  });
  const claimed = await store.getRuntimeBinding(ensured.id);
  await store.transitionRuntimeBinding({
    lease: bindingLease,
    expectedStateVersion: claimed.stateVersion,
    status: "thinking",
    processInstanceId: "test-process",
  });
  return bindingLease;
}

function nextRoundCommit(
  waiting: OrchestrationRun,
  lease: RunLease,
  bindingLease: RuntimeBindingLease,
  consumedCursor?: RoundCommitInput["consumedCursor"],
): RoundCommitInput {
  const { activeAgentId: _activeAgentId, ...stable } = waiting;
  return {
    expectedVersion: waiting.version,
    lease,
    bindingLease,
    ...(consumedCursor ? { consumedCursor } : {}),
    run: {
      ...stable,
      status: "running",
      nextRoundIndex: waiting.nextRoundIndex + 1,
      currentAttempt: 0,
    },
    message: {
      topicId: waiting.topicId,
      actorId: "claude",
      kind: "proposal",
      content: "原子提交的公开回复。",
    },
  };
}

function countRows(databasePath: string, table: "messages" | "orchestration_approvals"): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as unknown as { count: unknown };
    if (typeof row.count !== "number") {
      throw new Error("测试计数结果无效。");
    }
    return row.count;
  } finally {
    database.close();
  }
}

function getRevision(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM council_meta WHERE key = 'revision'")
      .get() as unknown as { value: unknown };
    if (typeof row.value !== "number") {
      throw new Error("测试 revision 结果无效。");
    }
    return row.value;
  } finally {
    database.close();
  }
}

function getRevisions(databasePath: string): {
  total: number;
  content: number;
  orchestration: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(`
        SELECT key, value FROM council_meta
        WHERE key IN ('revision', 'content_revision', 'orchestration_revision')
      `)
      .all() as unknown as Array<{ key: unknown; value: unknown }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const total = values.get("revision");
    const content = values.get("content_revision");
    const orchestration = values.get("orchestration_revision");
    if (
      typeof total !== "number" ||
      typeof content !== "number" ||
      typeof orchestration !== "number"
    ) {
      throw new Error("测试 revisions 结果无效。");
    }
    return { total, content, orchestration };
  } finally {
    database.close();
  }
}

test("运行快照可在 Store 重启后严格读取且状态变化推进 revision", async () => {
  await withDatabase(async (databasePath) => {
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const created = await first.createRun(createInput());
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = raw.prepare(
        "SELECT snapshot_schema_version FROM orchestration_runs WHERE id = ?",
      ).get(created.id) as unknown as { snapshot_schema_version: unknown };
      assert.equal(row.snapshot_schema_version, 4);
    } finally {
      raw.close();
    }
    const running = await first.replaceRun({ ...created, status: "running" }, created.version);
    const revisionAfterTransitions = getRevision(databasePath);
    first.close();

    const reopened = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const persisted = await reopened.getRun(created.id);
      assert.deepEqual(persisted, running);
      assert.equal(persisted.version, 2);
      assert.ok(revisionAfterTransitions >= 2);
    } finally {
      reopened.close();
    }
  });
});

test("旧 v1 作者快照映射为 Actor 且缺少清理时限时只用协议常量回填", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      convertRunToV1(databasePath, created.id, "alpha", "claude");

      const migrated = await store.getRun(created.id);
      assert.equal(
        migrated.policy.agentCleanupTimeoutMs,
        LEGACY_AGENT_CLEANUP_TIMEOUT_MS,
      );
      assert.equal(migrated.plan[0]?.actorId, "claude");
    } finally {
      store.close();
    }
  });
});

test("旧 v2 缺少 bindingRevision 时只允许读取和取消", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      convertRunToV2WithoutBindingRevision(databasePath, created.id);
      const legacy = await store.getRun(created.id);
      assert.equal(legacy.plan[0]?.bindingRevision, undefined);
      await assert.rejects(
        store.replaceRun({ ...legacy, status: "running" }, legacy.version),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /bindingRevision/.test(error.message),
      );
      const cancelled = await store.cancelRun(legacy.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(readSnapshotSchemaVersion(databasePath, legacy.id), 2);
    } finally {
      store.close();
    }
  });
});

test("v1 waiting_user 可读但批准被拒绝，取消后仍保持旧快照版本", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const created = await store.createRun(createInput({ beforeRounds: [1] }));
    const waiting = await store.replaceRun(
      {
        ...created,
        status: "waiting_user",
        pendingGateId: "before_round:1",
      },
      created.version,
    );
    convertRunToV1(databasePath, waiting.id, "deepseek", "other");

    const legacy = await store.getRun(waiting.id);
    assert.equal(legacy.plan[0]?.actorId, "deepseek");
    try {
      await assert.rejects(
        store.approveGate({
          runId: legacy.id,
          expectedGateId: "before_round:1",
          expectedVersion: legacy.version,
          approvalId: "approval_v1_deepseek",
          approvedByActorId: "human",
        }),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /只允许读取或取消/.test(error.message),
      );
      const cancelled = await store.cancelRun(legacy.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.plan[0]?.actorId, "deepseek");
      assert.equal(readSnapshotSchemaVersion(databasePath, legacy.id), 1);
    } finally {
      store.close();
    }
  });
});

test("v1 failed 可读但恢复状态被拒绝且终态取消为幂等读取", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const created = await store.createRun(createInput());
    const failed = await store.replaceRun(
      {
        ...created,
        status: "failed",
        failure: {
          code: "agent_failed",
          message: "测试失败。",
          retryable: true,
        },
      },
      created.version,
    );
    convertRunToV1(databasePath, failed.id, "kimi", "other");

    const legacy = await store.getRun(failed.id);
    assert.equal(legacy.plan[0]?.actorId, "kimi");
    try {
      const { failure: _failure, ...recovering } = legacy;
      await assert.rejects(
        store.replaceRun(
          { ...recovering, status: "running" },
          legacy.version,
        ),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /bindingRevision/.test(error.message),
      );
      const unchanged = await store.cancelRun(legacy.id);
      assert.equal(unchanged.status, "failed");
      assert.equal(readSnapshotSchemaVersion(databasePath, legacy.id), 1);
    } finally {
      store.close();
    }
  });
});

test("v1 waiting_agent 可读但 claim/commit 被拒绝，取消不写公开消息", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const created = await store.createRun(createInput());
    const waiting = await moveToWaitingAgent(store, created);
    convertRunToV1(databasePath, waiting.id, "unknown-legacy-adapter", "other");
    const legacy = await store.getRun(waiting.id);
    assert.equal(legacy.plan[0]?.actorId, "legacy-unknown");
    try {
      await assert.rejects(
        store.claimRunLease({
          runId: legacy.id,
          ownerId: "legacy-worker",
          ttlMs: 2_000,
        }),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /只允许读取或取消/.test(error.message),
      );
      const cancelled = await store.cancelRun(legacy.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(readSnapshotSchemaVersion(databasePath, legacy.id), 1);
      assert.equal((await store.getTopicContext(TOPIC_ID)).messages.length, 0);
    } finally {
      store.close();
    }
  });
});

test("两个 Store 连接用 version CAS 拒绝重复状态提交", async () => {
  await withDatabase(async (databasePath) => {
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await first.createRun(createInput());
      const stale = await second.getRun(created.id);
      const saved = await first.replaceRun({ ...created, status: "running" }, created.version);
      assert.equal(saved.version, created.version + 1);
      await assert.rejects(
        second.replaceRun({ ...stale, status: "running" }, stale.version),
        StoreConflictError,
      );
      assert.deepEqual(await second.getRun(created.id), saved);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("approvalId 重放幂等且不会跨过后续确认门", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const replayStore = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput({ rounds: 2, beforeRounds: [1, 2] }));
      const waitingFirst = await store.replaceRun(
        { ...created, status: "waiting_user", pendingGateId: "before_round:1" },
        created.version,
      );
      const approval = {
        runId: created.id,
        expectedGateId: "before_round:1",
        expectedVersion: waitingFirst.version,
        approvalId: "approval_first",
        approvedByActorId: "human" as const,
      };
      const revisionBeforeApproval = getRevision(databasePath);
      const first = await store.approveGate(approval);
      assert.equal(first.applied, true);
      assert.ok(getRevision(databasePath) > revisionBeforeApproval);

      const waitingSecond = await store.replaceRun(
        {
          ...first.run,
          status: "waiting_user",
          nextRoundIndex: 1,
          pendingGateId: "before_round:2",
        },
        first.run.version,
      );
      const replay = await replayStore.approveGate(approval);
      assert.equal(replay.applied, false);
      assert.equal(replay.run.pendingGateId, "before_round:2");
      assert.equal(replay.run.version, waitingSecond.version);
      assert.equal(countRows(databasePath, "orchestration_approvals"), 1);

      await assert.rejects(
        store.approveGate({
          ...approval,
          expectedGateId: "before_round:2",
          expectedVersion: waitingSecond.version,
        }),
        StoreConflictError,
      );
    } finally {
      replayStore.close();
      store.close();
    }
  });
});

test("取消先提交后迟到轮次不能写入公开消息", async () => {
  await withDatabase(async (databasePath) => {
    const cancelling = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const committing = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await cancelling.createRun(createInput());
      const waiting = await moveToWaitingAgent(cancelling, created);
      const lease = await cancelling.claimRunLease({
        runId: waiting.id,
        ownerId: "cancel-test",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(cancelling, waiting);
      const staleCommit = nextRoundCommit(waiting, lease, bindingLease);
      const revisionBeforeCancel = getRevision(databasePath);
      const cancelled = await cancelling.cancelRun(created.id);
      assert.equal(cancelled.status, "cancelled");
      assert.ok(getRevision(databasePath) > revisionBeforeCancel);
      await assert.rejects(committing.commitRound(staleCommit), StoreConflictError);
      assert.equal(countRows(databasePath, "messages"), 0);
    } finally {
      committing.close();
      cancelling.close();
    }
  });
});

test("跨连接取消原子失效 lease，续租失败且只推进 orchestration revision", async () => {
  await withDatabase(async (databasePath) => {
    const holder = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const canceller = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await holder.createRun(createInput());
      const waiting = await moveToWaitingAgent(holder, created);
      const lease = await holder.claimRunLease({
        runId: waiting.id,
        ownerId: "remote-holder",
        ttlMs: 60_000,
      });
      const before = getRevisions(databasePath);

      const cancelled = await canceller.cancelRun(waiting.id);

      assert.equal(cancelled.status, "cancelled");
      await assert.rejects(
        holder.renewRunLease({ lease, ttlMs: 60_000 }),
        LeaseLostError,
      );
      const after = getRevisions(databasePath);
      assert.ok(after.total > before.total);
      assert.equal(after.content, before.content);
      assert.ok(after.orchestration > before.orchestration);
    } finally {
      canceller.close();
      holder.close();
    }
  });
});

test("Store 拒绝超长 Agent 消息且运行和消息保持原子不变", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "oversize-message",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting);
      const commit = nextRoundCommit(waiting, lease, bindingLease);
      commit.message.content = "x".repeat(30_001);

      await assert.rejects(store.commitRound(commit), InvalidRunStateError);

      assert.deepEqual(await store.getRun(waiting.id), waiting);
      assert.equal(countRows(databasePath, "messages"), 0);
    } finally {
      store.close();
    }
  });
});

test("双连接竞争轮次时只有一个原子提交消息和运行", async () => {
  await withDatabase(async (databasePath) => {
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await first.createRun(createInput());
      const waiting = await moveToWaitingAgent(first, created);
      const lease = await first.claimRunLease({
        runId: waiting.id,
        ownerId: "commit-test",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(first, waiting);
      const commit = nextRoundCommit(waiting, lease, bindingLease);
      const revisionBeforeCommit = getRevision(databasePath);
      const results = await Promise.allSettled([
        first.commitRound(commit),
        second.commitRound(commit),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      assert.equal(countRows(databasePath, "messages"), 1);
      const saved = await first.getRun(created.id);
      assert.equal(saved.nextRoundIndex, 1);
      assert.equal(saved.version, waiting.version + 1);
      const context = await second.getTopicContext(TOPIC_ID);
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0]?.actorId, "claude");
      assert.ok(getRevision(databasePath) > revisionBeforeCommit);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("未注册 Actor 在进入 SQLite 前被拒绝", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "author-test",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting);
      const commit = nextRoundCommit(waiting, lease, bindingLease);
      const invalidActorId: unknown = "custom-runtime";
      commit.message.actorId = invalidActorId as ActorId;
      await assert.rejects(store.commitRound(commit), StoreConflictError);
      assert.equal(countRows(databasePath, "messages"), 0);
    } finally {
      store.close();
    }
  });
});

test("损坏 JSON 快照明确失败而不是回退默认状态", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const raw = new DatabaseSync(databasePath);
      try {
        raw.prepare("UPDATE orchestration_runs SET snapshot_json = ? WHERE id = ?")
          .run("{broken", created.id);
      } finally {
        raw.close();
      }
      await assert.rejects(
        store.getRun(created.id),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /不是有效 JSON/.test(error.message),
      );

      const invalidProtocolSnapshot = {
        ...created,
        plan: [{ ...created.plan[0], actorId: "custom-runtime" }],
      };
      const rawProtocol = new DatabaseSync(databasePath);
      try {
        rawProtocol.prepare("UPDATE orchestration_runs SET snapshot_json = ? WHERE id = ?")
          .run(JSON.stringify(invalidProtocolSnapshot), created.id);
      } finally {
        rawProtocol.close();
      }
      await assert.rejects(
        store.getRun(created.id),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /Actor custom-runtime 不存在/.test(error.message),
      );
    } finally {
      store.close();
    }
  });
});

test("消息插入失败会回滚同一事务内的运行 CAS", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "rollback-test",
        ttlMs: 60_000,
      });
      const raw = new DatabaseSync(databasePath);
      try {
        raw.exec(`
          CREATE TRIGGER reject_test_message
          BEFORE INSERT ON messages BEGIN
            SELECT RAISE(ABORT, 'test message rejection');
          END;
        `);
      } finally {
        raw.close();
      }

      const bindingLease = await prepareBindingLease(store, waiting);
      await assert.rejects(
        store.commitRound(nextRoundCommit(waiting, lease, bindingLease)),
      );
      const persisted = await store.getRun(created.id);
      assert.equal(persisted.status, "waiting_agent");
      assert.equal(persisted.version, waiting.version);
      assert.equal(persisted.nextRoundIndex, 0);
      assert.equal(countRows(databasePath, "messages"), 0);
      const binding = await store.getRuntimeBinding(bindingLease.bindingId);
      assert.equal(binding.status, "thinking");
      assert.equal(binding.cursor, undefined);
      const renewed = await store.renewRuntimeBindingLease({
        lease: bindingLease,
        ttlMs: 60_000,
      });
      assert.equal(renewed.epoch, bindingLease.epoch);
    } finally {
      store.close();
    }
  });
});

test("双连接 lease 竞争、续租和释放都不推进 Council revision", async () => {
  await withDatabase(async (databasePath) => {
    let nowMs = 1_000_000;
    const now = (): number => nowMs;
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    try {
      const created = await first.createRun(createInput());
      const running = await first.replaceRun({ ...created, status: "running" }, created.version);
      const revisionBeforeLease = getRevision(databasePath);
      const lease = await first.claimRunLease({
        runId: running.id,
        ownerId: "runner-first",
        ttlMs: 1_000,
      });
      await assert.rejects(
        second.claimRunLease({
          runId: running.id,
          ownerId: "runner-second",
          ttlMs: 1_000,
        }),
        LeaseConflictError,
      );
      nowMs += 100;
      const renewed = await first.renewRunLease({ lease, ttlMs: 2_000 });
      assert.ok(renewed.expiresAtMs > lease.expiresAtMs);
      assert.equal(await first.releaseRunLease(renewed), true);
      assert.equal(await second.releaseRunLease(lease), false);
      assert.equal(getRevision(databasePath), revisionBeforeLease);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("过期 lease 接管递增 epoch 并拒绝旧 token 的迟到提交", async () => {
  await withDatabase(async (databasePath) => {
    let nowMs = 2_000_000;
    const now = (): number => nowMs;
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    try {
      const created = await first.createRun(createInput());
      const waiting = await moveToWaitingAgent(first, created);
      const oldLease = await first.claimRunLease({
        runId: waiting.id,
        ownerId: "runner-old",
        ttlMs: 100,
      });
      nowMs += 101;
      const currentLease = await second.claimRunLease({
        runId: waiting.id,
        ownerId: "runner-new",
        ttlMs: 1_000,
      });
      assert.equal(currentLease.epoch, oldLease.epoch + 1);
      assert.notEqual(currentLease.token, oldLease.token);
      const bindingLease = await prepareBindingLease(second, waiting);
      await assert.rejects(
        first.commitRound(nextRoundCommit(waiting, oldLease, bindingLease)),
        LeaseLostError,
      );
      const committed = await second.commitRound(
        nextRoundCommit(waiting, currentLease, bindingLease),
      );
      assert.equal(committed.run.nextRoundIndex, 1);
      assert.equal(countRows(databasePath, "messages"), 1);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("同一 topic 只允许一个活动 run，failed 可让路但恢复仍受唯一约束", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const first = await store.createRun(createInput());
      await assert.rejects(store.createRun(createInput()), StoreConflictError);
      await store.cancelRun(first.id);

      const failedCandidate = await store.createRun(createInput());
      const running = await store.replaceRun(
        { ...failedCandidate, status: "running" },
        failedCandidate.version,
      );
      const failed = await store.replaceRun(
        {
          ...running,
          status: "failed",
          failure: {
            code: "agent_failed",
            message: "测试失败。",
            retryable: true,
          },
        },
        running.version,
      );
      const active = await store.createRun(createInput());
      const { failure: _failure, ...recovering } = failed;
      await assert.rejects(
        store.replaceRun({ ...recovering, status: "running" }, failed.version),
        StoreConflictError,
      );

      const page = await store.listRunsForTopic({ topicId: TOPIC_ID, limit: 2, offset: 0 });
      assert.equal(page.total, 3);
      assert.equal(page.count, 2);
      assert.equal(page.hasMore, true);
      assert.ok(page.runs.some((run) => run.id === active.id));
      const context = await store.getTopicContext(TOPIC_ID);
      assert.equal(context.projectPath, path.dirname(databasePath));
    } finally {
      store.close();
    }
  });
});

test("Agent 上下文只读取按配置限制的最新公开消息", async () => {
  await withDatabase(async (databasePath) => {
    const database = new DatabaseSync(databasePath);
    try {
      const insert = database.prepare(`
        INSERT INTO messages (
          id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
          kind, content, parent_message_id, created_at
        ) VALUES (?, ?, 'human', ?, NULL, 'note', ?, NULL, ?)
      `);
      for (let index = 1; index <= 5; index += 1) {
        insert.run(
          `message_context_${String(index)}`,
          TOPIC_ID,
          JSON.stringify({
            schemaVersion: 1,
            actorId: "human",
            slug: "human",
            displayName: "User",
            shortName: "U",
            role: "决策者",
          }),
          `公开消息 ${String(index)}`,
          new Date(Date.UTC(2026, 0, index)).toISOString(),
        );
      }
    } finally {
      database.close();
    }

    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, Date.now, 3);
    try {
      const context = await store.getTopicContext(TOPIC_ID);
      assert.deepEqual(
        context.messages.map((message) => message.content),
        ["公开消息 3", "公开消息 4", "公开消息 5"],
      );
    } finally {
      store.close();
    }
  });
});

test("commitRound 绑定当前计划作者和类型并拒绝偷改运行字段", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "strict-commit",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting);
      const base = nextRoundCommit(waiting, lease, bindingLease);
      await assert.rejects(
        store.commitRound({ ...base, message: { ...base.message, actorId: "codex" } }),
        StoreConflictError,
      );
      await assert.rejects(
        store.commitRound({ ...base, message: { ...base.message, kind: "critique" } }),
        StoreConflictError,
      );
      await assert.rejects(
        store.commitRound({
          ...base,
          run: { ...base.run, currentAttempt: 1 },
        }),
      );
      await assert.rejects(
        store.commitRound({
          ...base,
          run: { ...base.run, manualRecoveriesUsed: 1 },
        }),
      );
      await assert.rejects(
        store.commitRound({
          ...base,
          run: { ...base.run, confirmedGates: ["before_completion"] },
        }),
      );
      assert.equal(countRows(databasePath, "messages"), 0);
      assert.deepEqual(await store.getRun(waiting.id), waiting);
    } finally {
      store.close();
    }
  });
});

test("accepted INSERT 会关闭议题全部 RuntimeBinding 并删除 lease", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const binding = await store.getRuntimeBinding("binding_alpha");
      const lease = await store.claimRuntimeBindingLease({
        bindingId: binding.id,
        ownerId: "accepted-insert",
        ttlMs: 60_000,
        processInstanceId: "test-process",
      });
      const now = new Date().toISOString();
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare(`
          INSERT INTO decisions (
            id, topic_id, title, decision, rationale, alternatives_json,
            status, created_by_actor_id, created_by_snapshot_json,
            created_by_legacy, created_at, updated_at
          ) VALUES (
            'decision_accepted_insert', ?, '结束议题', '接受方案', '测试触发器',
            '[]', 'accepted', 'human', ?, NULL, ?, ?
          )
        `).run(
          TOPIC_ID,
          JSON.stringify({ schemaVersion: 1, actorId: "human" }),
          now,
          now,
        );
      } finally {
        database.close();
      }

      const closing = await store.getRuntimeBinding(binding.id);
      assert.equal(closing.status, "closing");
      assert.equal(closing.closeReason, "decision-accepted");
      assert.equal(closing.epoch, lease.epoch + 1);
      await assert.rejects(
        store.renewRuntimeBindingLease({ lease, ttlMs: 60_000 }),
        LeaseLostError,
      );
      assert.equal(await store.closeIdleRuntimeBindings(now), 1);
      assert.equal((await store.getRuntimeBinding(binding.id)).status, "closed");
    } finally {
      store.close();
    }
  });
});

test("空闲超时只原子关闭到期的 idle RuntimeBinding", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const closedCount = await store.closeIdleRuntimeBindings(
        new Date(Date.now() + 60_000).toISOString(),
      );
      assert.equal(closedCount, 1);
      const binding = await store.getRuntimeBinding("binding_alpha");
      assert.equal(binding.status, "closed");
      assert.equal(binding.closeReason, "idle-timeout");
      assert.ok(binding.closedAt);
      assert.equal(await store.closeIdleRuntimeBindings(
        new Date(Date.now() + 120_000).toISOString(),
      ), 0);
    } finally {
      store.close();
    }
  });
});

test("accepted UPDATE 会 fencing 活动调用且迟到回复零写", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const runLease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "accepted-update",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting);
      const now = new Date().toISOString();
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare(`
          INSERT INTO decisions (
            id, topic_id, title, decision, rationale, alternatives_json,
            status, created_by_actor_id, created_by_snapshot_json,
            created_by_legacy, created_at, updated_at
          ) VALUES (
            'decision_accepted_update', ?, '候选决策', '待确认', '测试触发器',
            '[]', 'proposed', 'human', ?, NULL, ?, ?
          )
        `).run(
          TOPIC_ID,
          JSON.stringify({ schemaVersion: 1, actorId: "human" }),
          now,
          now,
        );
        database.prepare(`
          UPDATE decisions
          SET status = 'accepted', updated_at = ?
          WHERE id = 'decision_accepted_update'
        `).run(new Date(Date.parse(now) + 1).toISOString());
      } finally {
        database.close();
      }

      const closing = await store.getRuntimeBinding(bindingLease.bindingId);
      assert.equal(closing.status, "closing");
      assert.equal(closing.closeReason, "decision-accepted");
      await assert.rejects(
        store.commitRound(nextRoundCommit(waiting, runLease, bindingLease)),
        LeaseLostError,
      );
      assert.equal(countRows(databasePath, "messages"), 0);
      assert.deepEqual(await store.getRun(waiting.id), waiting);
    } finally {
      store.close();
    }
  });
});

test("RuntimeBinding 首轮全上下文，后续只读取稳定游标增量和当前 human 请求", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const database = new DatabaseSync(databasePath);
      const humanSnapshot = JSON.stringify({
        schemaVersion: 1,
        actorId: "human",
        slug: "human",
        displayName: "User",
        shortName: "U",
        role: "决策者",
      });
      try {
        database.prepare(`
          UPDATE runtime_bindings
          SET transport_kind = 'claude-resume'
          WHERE id = 'binding_alpha'
        `).run();
        database.prepare(`
          INSERT INTO messages (
            id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
            kind, content, parent_message_id, created_at
          ) VALUES (
            'message_initial_request', ?, 'human', ?, NULL,
            'note', '首轮请求', NULL, ?
          )
        `).run(TOPIC_ID, humanSnapshot, new Date(Date.now() - 10_000).toISOString());
      } finally {
        database.close();
      }
      const initial = await store.getRuntimeBindingInvocationContext(
        "binding_alpha",
        "message_initial_request",
      );
      assert.equal(initial.firstTurn, true);
      assert.ok(initial.topic.messages.some((message) =>
        message.id === "message_initial_request"
      ));
      assert.ok(initial.consumedCursor);

      const duringCall = new Date(Date.parse(initial.consumedCursor.createdAt) + 1).toISOString();
      const duringCallDatabase = new DatabaseSync(databasePath);
      try {
        duringCallDatabase.prepare(`
          INSERT INTO messages (
            id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
            kind, content, parent_message_id, created_at
          ) VALUES ('message_during_call', ?, 'human', ?, NULL, 'note', ?, NULL, ?)
        `).run(TOPIC_ID, humanSnapshot, "调用执行期间到达的新请求", duringCall);
      } finally {
        duringCallDatabase.close();
      }

      const runInput = createInput();
      runInput.plan = runInput.plan.map((round) => ({
        ...round,
        requestMessageId: "message_initial_request",
      }));
      const created = await store.createRun(runInput);
      const waiting = await moveToWaitingAgent(store, created);
      const runLease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "cursor-test",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting, "claude-resume");
      const committed = await store.commitRound(
        {
          ...nextRoundCommit(waiting, runLease, bindingLease, initial.consumedCursor),
          bindingSessionId: "session_cursor_test",
        },
      );
      const committedBinding = await store.getRuntimeBinding(bindingLease.bindingId);
      assert.deepEqual(committedBinding.cursor, initial.consumedCursor);

      const later = new Date(Date.parse(committed.message.createdAt) + 1).toISOString();
      const laterDatabase = new DatabaseSync(databasePath);
      try {
        const insert = laterDatabase.prepare(`
          INSERT INTO messages (
            id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
            kind, content, parent_message_id, created_at
          ) VALUES (?, ?, 'human', ?, NULL, 'note', ?, NULL, ?)
        `);
        insert.run("message_delta_a", TOPIC_ID, humanSnapshot, "增量 A", later);
        insert.run("message_delta_b", TOPIC_ID, humanSnapshot, "增量 B", later);
      } finally {
        laterDatabase.close();
      }

      const delta = await store.getRuntimeBindingInvocationContext(
        bindingLease.bindingId,
        "message_delta_b",
      );
      assert.equal(delta.firstTurn, false);
      assert.ok(delta.topic.messages.some((message) => message.id === "message_during_call"));
      assert.ok(delta.topic.messages.some((message) => message.id === "message_delta_b"));
      await assert.rejects(
        store.getRuntimeBindingInvocationContext(
          bindingLease.bindingId,
          "message_initial_request",
        ),
        InvalidRunStateError,
      );

      const crashedLease = await store.claimRuntimeBindingLease({
        bindingId: bindingLease.bindingId,
        ownerId: "crashed-worker",
        ttlMs: 60_000,
        processInstanceId: "crashed-process",
      });
      const beforeCrash = await store.getRuntimeBinding(bindingLease.bindingId);
      await store.transitionRuntimeBinding({
        lease: crashedLease,
        expectedStateVersion: beforeCrash.stateVersion,
        status: "thinking",
        processInstanceId: "crashed-process",
      });
      assert.equal(await store.markRuntimeBindingsInterrupted("restarted-process"), 1);
      const afterRestart = await store.getRuntimeBinding(bindingLease.bindingId);
      assert.equal(afterRestart.status, "interrupted");
      assert.equal(afterRestart.sessionId, "session_cursor_test");
      assert.deepEqual(afterRestart.cursor, initial.consumedCursor);
      const restartContext = await store.getRuntimeBindingInvocationContext(
        bindingLease.bindingId,
        "message_delta_b",
      );
      assert.equal(restartContext.firstTurn, false);

      const resetLease = await store.claimRuntimeBindingLease({
        bindingId: bindingLease.bindingId,
        ownerId: "session-reset-test",
        ttlMs: 60_000,
        processInstanceId: "test-process",
      });
      const beforeReset = await store.getRuntimeBinding(bindingLease.bindingId);
      const reset = await store.transitionRuntimeBinding({
        lease: resetLease,
        expectedStateVersion: beforeReset.stateVersion,
        status: "interrupted",
        clearSession: true,
        processInstanceId: "test-process",
      });
      assert.equal(reset.sessionId, undefined);
      assert.equal(reset.cursor, undefined);
      const afterReset = await store.getRuntimeBindingInvocationContext(
        bindingLease.bindingId,
        "message_delta_b",
      );
      assert.equal(afterReset.firstTurn, true);
    } finally {
      store.close();
    }
  });
});

test("逻辑请求账本跨 RuntimeBinding 关闭、删除和配置变更仍拒绝重复 human 请求", async () => {
  await withDatabase(async (databasePath) => {
    const database = new DatabaseSync(databasePath);
    const humanSnapshot = JSON.stringify({
      schemaVersion: 1,
      actorId: "human",
      slug: "human",
      displayName: "User",
      shortName: "U",
      role: "决策者",
    });
    try {
      database.prepare(`
        INSERT INTO messages (
          id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
          kind, content, parent_message_id, created_at
        ) VALUES ('message_sessionless_request', ?, 'human', ?, NULL, 'note', ?, NULL, ?)
      `).run(TOPIC_ID, humanSnapshot, "只允许成功消费一次", new Date().toISOString());
    } finally {
      database.close();
    }

    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const context = await store.getRuntimeBindingInvocationContext(
        "binding_alpha",
        "message_sessionless_request",
      );
      const input = createInput();
      input.plan = input.plan.map((round) => ({
        ...round,
        requestMessageId: "message_sessionless_request",
      }));
      const waiting = await moveToWaitingAgent(store, await store.createRun(input));
      const runLease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "sessionless-idempotency",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting);
      await store.commitRound(
        nextRoundCommit(waiting, runLease, bindingLease, context.consumedCursor),
      );

      await assert.rejects(
        store.getRuntimeBindingInvocationContext(
          bindingLease.bindingId,
          "message_sessionless_request",
        ),
        InvalidRunStateError,
      );
      const closing = await store.requestRuntimeBindingClose(
        bindingLease.bindingId,
        "test-logical-ledger",
      );
      await store.finalizeRuntimeBindingClose({
        bindingId: closing.id,
        expectedStateVersion: closing.stateVersion,
        closeReason: "test-logical-ledger",
      });
      const inspection = new DatabaseSync(databasePath);
      try {
        inspection.prepare("DELETE FROM runtime_bindings WHERE id = ?")
          .run(bindingLease.bindingId);
        const ledger = inspection.prepare(`
          SELECT topic_id, agent_id, request_message_id
          FROM runtime_binding_requests
          WHERE topic_id = ? AND agent_id = ? AND request_message_id = ?
        `).get(TOPIC_ID, "alpha", "message_sessionless_request") as unknown as
          | { topic_id: unknown; agent_id: unknown; request_message_id: unknown }
          | undefined;
        assert.deepEqual({ ...ledger }, {
          topic_id: TOPIC_ID,
          agent_id: "alpha",
          request_message_id: "message_sessionless_request",
        });
      } finally {
        inspection.close();
      }
      const replacement = await store.ensureRuntimeBinding({
        topicId: TOPIC_ID,
        agentId: "alpha",
        actorId: "claude",
        providerId: "provider_test",
        bindingRevision: "test-binding:alpha:v2",
        agentConfigRevision: 2,
        providerConfigRevision: 1,
        transportKind: "openai-sessionless",
        processInstanceId: "replacement-process",
      });
      assert.notEqual(replacement.id, bindingLease.bindingId);
      await assert.rejects(
        store.getRuntimeBindingInvocationContext(
          replacement.id,
          "message_sessionless_request",
        ),
        InvalidRunStateError,
      );
    } finally {
      store.close();
    }
  });
});

test("已决议题拒绝新 Run 与 RuntimeBinding 创建或重开", async () => {
  await withDatabase(async (databasePath) => {
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        UPDATE runtime_bindings
        SET status = 'closed', closed_at = updated_at
        WHERE id = 'binding_alpha'
      `).run();
      database.prepare("UPDATE topics SET status = 'decided' WHERE id = ?").run(TOPIC_ID);
    } finally {
      database.close();
    }
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      await assert.rejects(store.createRun(createInput()), StoreConflictError);
      await assert.rejects(
        store.ensureRuntimeBinding({
          topicId: TOPIC_ID,
          agentId: "alpha",
          actorId: "claude",
          providerId: "provider_test",
          bindingRevision: "test-binding:alpha:v1",
          agentConfigRevision: 1,
          providerConfigRevision: 1,
          transportKind: "claude-resume",
          processInstanceId: "test-process",
        }),
        StoreConflictError,
      );
    } finally {
      store.close();
    }
  });
});

test("Store close 幂等且迁移失败会释放数据库连接", async () => {
  await withDatabase(async (databasePath, directory) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    store.close();
    store.close();

    const invalidPath = path.join(directory, "invalid.sqlite3");
    const invalid = new DatabaseSync(invalidPath);
    invalid.close();
    assert.throws(() => new SQLiteCouncilStore(invalidPath, BUSY_TIMEOUT_MS));
    const reopened = new DatabaseSync(invalidPath);
    reopened.exec("CREATE TABLE connection_released (id INTEGER PRIMARY KEY);");
    reopened.close();
  });
});

test("议题正等待某 Agent 时，轮次提交把发言与公开消息写在同一个事务里", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const database = new DatabaseSync(databasePath);
    try {
      const opened = startDiscussionCycle(database, {
        topicId: TOPIC_ID,
        // 名册用计划里的 adapterId：提交时按它判断这一轮是不是 cycle 在等的人。
        participants: ["alpha", "beta"],
        ...cycleStartInput(["alpha", "beta"]),
        roundBudget: 2,
        now: new Date().toISOString(),
      });
      assert.equal(opened.action.kind, "invoke");

      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "cycle-commit-test",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting);
      const base = nextRoundCommit(waiting, lease, bindingLease);
      const committed = await store.commitRound({
        ...base,
        message: {
          ...base.message,
          content: [
            "方案正文。",
            "",
            "```council-verdict",
            '{"stance":"agree","summary":"证据充分"}',
            "```",
          ].join("\n"),
        },
      });

      const view = readActiveDiscussionCycle(database, TOPIC_ID);
      assert.equal(view?.cycle.turns.length, 1, "公开消息落库即意味着发言已记上");
      assert.equal(view?.cycle.turns[0]?.messageId, committed.message.id);
      assert.equal(view?.cycle.turns[0]?.stance, "agree");
      assert.equal(view?.cycle.stage, "critique", "cycle 应已交接给下一位");
      assert.deepEqual(view?.action, {
        kind: "invoke",
        agentId: "beta",
        stage: "critique",
        messageKind: "critique",
        round: 1,
      });
    } finally {
      database.close();
      store.close();
    }
  });
});

test("同一条回复里的提问会挂起 cycle，并回到发言推进后的阶段", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const database = new DatabaseSync(databasePath);
    try {
      startDiscussionCycle(database, {
        topicId: TOPIC_ID,
        participants: ["alpha", "beta"],
        ...cycleStartInput(["alpha", "beta"]),
        roundBudget: 2,
        now: new Date().toISOString(),
      });
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "cycle-question-test",
        ttlMs: 60_000,
      });
      const bindingLease = await prepareBindingLease(store, waiting);
      const base = nextRoundCommit(waiting, lease, bindingLease);
      await store.commitRound({
        ...base,
        message: {
          ...base.message,
          content: [
            "方案正文，但定价口径我判断不了。",
            "",
            "```council-verdict",
            '{"stance":"agree","summary":"技术路径清楚"}',
            "```",
            "",
            "```council-question",
            '{"question":"按订阅还是按次？","rationale":"存储层实现不可逆","options":["订阅","按次"]}',
            "```",
          ].join("\n"),
        },
      });

      const view = readActiveDiscussionCycle(database, TOPIC_ID);
      assert.equal(view?.cycle.stage, "awaiting_user");
      assert.equal(
        view?.cycle.resumeStage,
        "critique",
        "提问发生在 proposal，但发言已推进到 critique，回答后必须回到 critique",
      );
      assert.equal(view?.openQuestion?.question, "按订阅还是按次？");
      assert.deepEqual(view?.action, { kind: "await_user" });
      assert.equal(view?.cycle.turns.length, 1, "提问不影响该次发言已被记录");
    } finally {
      database.close();
      store.close();
    }
  });
});
