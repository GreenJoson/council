/**
 * @input  依赖：临时 v1/fresh SQLite、Node online backup 与 schema 迁移故障注入
 * @output 验证：动态 Actor 映射、Session 无损归并、连续账本、canonical schema、备份、回滚和 revision
 * @pos    Node 唯一生产迁移器的安全主验收
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLiteCouncilStore } from "council-orchestrator";
import {
  COUNCIL_SCHEMA_VERSION,
  FROZEN_LEGACY_V1_SCHEMA_SQL,
  assertCouncilSchema,
  migrateCouncilSchema,
} from "../src/schema-migrator.js";

const LEGACY_SCHEMA_SQL = `
  CREATE TABLE topics (
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
`;

const HUMAN_SNAPSHOT_JSON = JSON.stringify({
  schemaVersion: 1,
  actorId: "human",
  slug: "human",
  displayName: "User",
  shortName: "U",
  role: "决策者",
});

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "council-schema-migration-"));
  return {
    directory,
    databasePath: path.join(directory, "council.sqlite3"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function createLegacyDatabase(
  databasePath: string,
  topicId = "topic_legacy",
  createdBy = "human",
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(LEGACY_SCHEMA_SQL);
    database.prepare(`
      INSERT INTO topics (
        id, title, question, constraints_json, project_path,
        status, created_by, created_at, updated_at
      ) VALUES (?, 'legacy', 'legacy', '[]', NULL, 'open', ?, ?, ?)
    `).run(topicId, createdBy, new Date().toISOString(), new Date().toISOString());
  } finally {
    database.close();
  }
}

function addLegacySessions(
  databasePath: string,
  topicId: string,
  sessions: ReadonlyArray<{
    agent: string;
    sessionId: string;
    updatedAt: string;
  }>,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE agent_sessions (
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (topic_id, agent)
      );
    `);
    const insert = database.prepare(`
      INSERT INTO agent_sessions (topic_id, agent, session_id, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const session of sessions) {
      insert.run(topicId, session.agent, session.sessionId, session.updatedAt);
    }
  } finally {
    database.close();
  }
}

function legacyRunSnapshot(input: {
  id: string;
  topicId: string;
  adapterId: string;
  publicAuthor: "other";
  status: "completed" | "failed" | "waiting_user";
}): Readonly<Record<string, unknown>> {
  const base = {
    id: input.id,
    topicId: input.topicId,
    status: input.status,
    plan: [{
      adapterId: input.adapterId,
      publicAuthor: input.publicAuthor,
      messageKind: "proposal",
      instruction: `评审 ${input.adapterId}`,
    }],
    policy: {
      maxRounds: 1,
      allowedAgents: [input.adapterId],
      agentTimeoutMs: 60_000,
      maxAttemptsPerRound: 2,
      maxManualRecoveries: 1,
      confirmation: {
        beforeRounds: input.status === "waiting_user" ? [1] : [],
        beforeCompletion: false,
      },
    },
    nextRoundIndex: input.status === "completed" ? 1 : 0,
    currentAttempt: input.status === "failed" ? 1 : 0,
    manualRecoveriesUsed: 0,
    confirmedGates: [],
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
  if (input.status === "completed") {
    return { ...base, stopReason: "plan_completed" };
  }
  if (input.status === "failed") {
    return {
      ...base,
      failure: {
        code: "agent_failed",
        message: "安全失败",
        retryable: true,
      },
    };
  }
  return { ...base, pendingGateId: "before_round:1" };
}

function createProductionV1Database(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(FROZEN_LEGACY_V1_SCHEMA_SQL);
    database.exec(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'initial-unified-schema', '2026-01-01T00:00:00.000Z');
      INSERT INTO council_identity (singleton, instance_id)
      VALUES (1, '11111111-1111-4111-8111-111111111111');
      PRAGMA user_version = 1;
    `);
    const insertTopic = database.prepare(`
      INSERT INTO topics (
        id, title, question, constraints_json, project_path,
        status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `);
    for (const [id, author] of [
      ["topic_v1_deepseek", "human"],
      ["topic_v1_kimi", "claude"],
      ["topic_v1_unknown", "other"],
    ] as const) {
      insertTopic.run(
        id,
        `标题 ${id}`,
        `问题 ${id}`,
        JSON.stringify([`约束 ${id}`]),
        null,
        author,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:01:00.000Z",
      );
    }
    database.prepare(`
      INSERT INTO messages (
        id, topic_id, author, kind, content, parent_message_id, created_at
      ) VALUES (
        'message_v1', 'topic_v1_deepseek', 'codex', 'critique',
        '保留消息正文', NULL, '2026-01-01T00:02:00.000Z'
      )
    `).run();
    database.prepare(`
      INSERT INTO decisions (
        id, topic_id, title, decision, rationale, alternatives_json,
        status, created_by, created_at, updated_at
      ) VALUES (
        'decision_v1', 'topic_v1_deepseek', '保留决策', '保留方案',
        '保留理由', '["保留替代方案"]', 'proposed', 'claude',
        '2026-01-01T00:03:00.000Z', '2026-01-01T00:03:00.000Z'
      )
    `).run();
    const insertSession = database.prepare(`
      INSERT INTO agent_sessions (topic_id, agent, session_id, updated_at)
      VALUES ('topic_v1_deepseek', ?, ?, ?)
    `);
    insertSession.run("claude", "session-v1-old", "2026-01-01T00:01:00.000Z");
    insertSession.run("claude-code", "session-v1-current", "2026-01-01T00:02:00.000Z");
    database.prepare(`
      INSERT INTO agent_settings (
        id, label, kind, model, base_url, enabled, requires_api_key, updated_at
      ) VALUES (
        'deepseek', 'DeepSeek', 'openai-compatible', 'model-v1',
        NULL, 1, 1, '2026-01-01T00:04:00.000Z'
      )
    `).run();
    const insertRun = database.prepare(`
      INSERT INTO orchestration_runs (
        id, topic_id, status, snapshot_schema_version, snapshot_json,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 3, ?, ?)
    `);
    for (const run of [
      {
        id: "run_v1_deepseek",
        topicId: "topic_v1_deepseek",
        adapterId: "deepseek",
        publicAuthor: "other" as const,
        status: "completed" as const,
      },
      {
        id: "run_v1_kimi",
        topicId: "topic_v1_kimi",
        adapterId: "kimi",
        publicAuthor: "other" as const,
        status: "failed" as const,
      },
      {
        id: "run_v1_unknown",
        topicId: "topic_v1_unknown",
        adapterId: "provider-unknown",
        publicAuthor: "other" as const,
        status: "waiting_user" as const,
      },
    ]) {
      insertRun.run(
        run.id,
        run.topicId,
        run.status,
        JSON.stringify(legacyRunSnapshot(run)),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:01:00.000Z",
      );
    }
    database.prepare(`
      INSERT INTO orchestration_approvals (
        run_id, approval_id, gate_id, expected_version,
        approved_by, applied_run_version, created_at
      ) VALUES (
        'run_v1_deepseek', 'approval_v1', 'before_round:1', 1,
        'human', 2, '2026-01-01T00:00:30.000Z'
      )
    `).run();
    database.prepare(`
      INSERT INTO orchestration_run_leases (
        run_id, owner_id, lease_token, epoch, expires_at_ms, updated_at
      ) VALUES (
        'run_v1_unknown', 'worker-v1', 'lease-v1', 2, 4102444800000,
        '2026-01-01T00:00:30.000Z'
      )
    `).run();
  } finally {
    database.close();
  }
}

function pragmaInteger(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  assert.ok(row && typeof row === "object");
  const values = Object.values(row);
  assert.equal(values.length, 1);
  assert.equal(typeof values[0], "number");
  return values[0] as number;
}

function plainSqlValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("fresh DB 由 Node 创建版本账本且 revision trigger 可工作", async () => {
  const fixture = temporaryDatabase();
  try {
    const result = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.equal(result.migrated, true);
    assert.equal(result.version, COUNCIL_SCHEMA_VERSION);
    assert.equal(result.backupPath, undefined);

    const database = new DatabaseSync(fixture.databasePath);
    try {
      assertCouncilSchema(database);
      assert.equal(pragmaInteger(database, "user_version"), COUNCIL_SCHEMA_VERSION);
      const ledger = database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as unknown as { version: number };
      assert.equal(ledger.version, COUNCIL_SCHEMA_VERSION);
      const identity = database
        .prepare("SELECT instance_id FROM council_identity WHERE singleton = 1")
        .get() as unknown as { instance_id: string };
      assert.match(identity.instance_id, /^[0-9a-f-]{36}$/u);
      const before = database
        .prepare("SELECT value FROM council_meta WHERE key = 'content_revision'")
        .get() as unknown as { value: number };
      database.prepare(`
        INSERT INTO topics (
          id, title, question, constraints_json, project_path,
          status, created_by_actor_id, created_by_snapshot_json, created_by_legacy,
          created_at, updated_at
        ) VALUES (
          'topic_trigger_probe', 'probe', 'probe', '[]', NULL, 'open',
          'human', ?, NULL, ?, ?
        )
      `).run(HUMAN_SNAPSHOT_JSON, new Date().toISOString(), new Date().toISOString());
      const after = database
        .prepare("SELECT value FROM council_meta WHERE key = 'content_revision'")
        .get() as unknown as { value: number };
      assert.equal(after.value, before.value + 1);
    } finally {
      database.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("legacy DB 保留行数并生成已验证同目录 backup，重复打开只验证", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  try {
    const migrated = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.equal(migrated.migrated, true);
    assert.ok(migrated.backupPath);
    assert.equal(path.dirname(migrated.backupPath as string), fixture.directory);
    assert.equal(existsSync(migrated.backupPath as string), true);

    const database = new DatabaseSync(fixture.databasePath);
    const backup = new DatabaseSync(migrated.backupPath as string, { readOnly: true });
    try {
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count,
        1,
      );
      assert.equal(
        (backup.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count,
        1,
      );
      assert.equal(pragmaInteger(backup, "user_version"), 0);
    } finally {
      backup.close();
      database.close();
    }

    const beforeReopen = new DatabaseSync(fixture.databasePath);
    const revisionBefore = beforeReopen
      .prepare("SELECT key, value FROM council_meta ORDER BY key")
      .all();
    beforeReopen.close();
    const reopened = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.deepEqual(reopened, {
      migrated: false,
      version: COUNCIL_SCHEMA_VERSION,
    });
    const afterReopen = new DatabaseSync(fixture.databasePath);
    try {
      assert.deepEqual(
        afterReopen.prepare("SELECT key, value FROM council_meta ORDER BY key").all(),
        revisionBefore,
      );
    } finally {
      afterReopen.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("legacy other 迁移为待审计身份并保留原始枚举", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath, "topic_legacy_other", "other");
  try {
    await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    const database = new DatabaseSync(fixture.databasePath);
    try {
      const topic = database.prepare(`
        SELECT created_by_actor_id, created_by_snapshot_json, created_by_legacy
        FROM topics WHERE id = 'topic_legacy_other'
      `).get() as unknown as {
        created_by_actor_id: string;
        created_by_snapshot_json: string;
        created_by_legacy: string;
      };
      assert.equal(topic.created_by_actor_id, "legacy-unknown");
      assert.equal(topic.created_by_legacy, "other");
      assert.equal(
        (JSON.parse(topic.created_by_snapshot_json) as { actorId: string }).actorId,
        "legacy-unknown",
      );
      const identity = database.prepare(`
        SELECT status FROM actor_identities WHERE id = 'legacy-unknown'
      `).get() as unknown as { status: string };
      assert.equal(identity.status, "needs_review");
      const alias = database.prepare(`
        SELECT actor_id FROM actor_aliases WHERE alias = 'OTHER' COLLATE NOCASE
      `).get() as unknown as { actor_id: string };
      assert.equal(alias.actor_id, "legacy-unknown");
      assert.throws(
        () => database.prepare(`
          INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
          VALUES ('Other', 'human', 'legacy', ?)
        `).run(new Date().toISOString()),
        /UNIQUE constraint failed/u,
      );
    } finally {
      database.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("legacy Session 多别名归并不丢行且只选择一个 current", async () => {
  const fixture = temporaryDatabase();
  const topicId = "topic_legacy_sessions";
  createLegacyDatabase(fixture.databasePath, topicId);
  addLegacySessions(fixture.databasePath, topicId, [
    {
      agent: "claude",
      sessionId: "session-claude-old",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      agent: "claude-code",
      sessionId: "session-claude-current",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      agent: "provider-alpha",
      sessionId: "session-unknown-old",
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
    {
      agent: "provider-beta",
      sessionId: "session-unknown-current",
      updatedAt: "2026-01-04T00:00:00.000Z",
    },
  ]);
  try {
    await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    const database = new DatabaseSync(fixture.databasePath);
    try {
      const rows = database.prepare(`
        SELECT actor_id, legacy_agent, session_id, is_current, updated_at
        FROM agent_sessions
        ORDER BY actor_id, updated_at, legacy_agent
      `).all();
      assert.equal(rows.length, 4);
      assert.deepEqual(
        plainSqlValue(
          rows.filter((row) => (row as { actor_id: string }).actor_id === "claude"),
        ),
        [
          {
            actor_id: "claude",
            legacy_agent: "claude",
            session_id: "session-claude-old",
            is_current: 0,
            updated_at: "2026-01-01T00:00:00.000Z",
          },
          {
            actor_id: "claude",
            legacy_agent: "claude-code",
            session_id: "session-claude-current",
            is_current: 1,
            updated_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      );
      assert.deepEqual(
        plainSqlValue(
          rows.filter((row) => (row as { actor_id: string }).actor_id === "legacy-unknown"),
        ),
        [
          {
            actor_id: "legacy-unknown",
            legacy_agent: "provider-alpha",
            session_id: "session-unknown-old",
            is_current: 0,
            updated_at: "2026-01-03T00:00:00.000Z",
          },
          {
            actor_id: "legacy-unknown",
            legacy_agent: "provider-beta",
            session_id: "session-unknown-current",
            is_current: 1,
            updated_at: "2026-01-04T00:00:00.000Z",
          },
        ],
      );
    } finally {
      database.close();
    }

    const reopened = await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    assert.equal(reopened.migrated, false);
    const after = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(
        (after.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as { count: number })
          .count,
        4,
      );
      assert.equal(
        (
          after.prepare(`
            SELECT COUNT(*) AS count
            FROM agent_sessions
            WHERE is_current = 1
          `).get() as { count: number }
        ).count,
        2,
      );
    } finally {
      after.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("完整生产 v1 fixture 值级迁移、运行升级与重复打开均无损", async () => {
  const fixture = temporaryDatabase();
  createProductionV1Database(fixture.databasePath);
  try {
    const migrated = await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    assert.equal(migrated.migrated, true);
    assert.ok(migrated.backupPath);

    const database = new DatabaseSync(fixture.databasePath);
    try {
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT id, created_by_actor_id, created_by_legacy
          FROM topics ORDER BY id
        `).all()),
        [
          {
            id: "topic_v1_deepseek",
            created_by_actor_id: "human",
            created_by_legacy: "human",
          },
          {
            id: "topic_v1_kimi",
            created_by_actor_id: "claude",
            created_by_legacy: "claude",
          },
          {
            id: "topic_v1_unknown",
            created_by_actor_id: "legacy-unknown",
            created_by_legacy: "other",
          },
        ],
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT author_actor_id, author_legacy, content
          FROM messages WHERE id = 'message_v1'
        `).get()),
        {
          author_actor_id: "codex",
          author_legacy: "codex",
          content: "保留消息正文",
        },
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT created_by_actor_id, created_by_legacy, decision, alternatives_json
          FROM decisions WHERE id = 'decision_v1'
        `).get()),
        {
          created_by_actor_id: "claude",
          created_by_legacy: "claude",
          decision: "保留方案",
          alternatives_json: '["保留替代方案"]',
        },
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT id, label, model, enabled, requires_api_key
          FROM agent_settings WHERE id = 'deepseek'
        `).get()),
        {
          id: "deepseek",
          label: "DeepSeek",
          model: "model-v1",
          enabled: 1,
          requires_api_key: 1,
        },
      );
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as { count: number })
          .count,
        2,
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT legacy_agent, session_id, is_current
          FROM agent_sessions ORDER BY legacy_agent
        `).all()),
        [
          { legacy_agent: "claude", session_id: "session-v1-old", is_current: 0 },
          { legacy_agent: "claude-code", session_id: "session-v1-current", is_current: 1 },
        ],
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT approved_by_actor_id, approved_by_legacy, applied_run_version
          FROM orchestration_approvals WHERE approval_id = 'approval_v1'
        `).get()),
        {
          approved_by_actor_id: "human",
          approved_by_legacy: "human",
          applied_run_version: 2,
        },
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT owner_id, lease_token, epoch, expires_at_ms
          FROM orchestration_run_leases WHERE run_id = 'run_v1_unknown'
        `).get()),
        {
          owner_id: "worker-v1",
          lease_token: "lease-v1",
          epoch: 2,
          expires_at_ms: 4_102_444_800_000,
        },
      );
    } finally {
      database.close();
    }

    const store = new SQLiteCouncilStore(fixture.databasePath, 5_000);
    const deepseek = await store.getRun("run_v1_deepseek");
    const kimi = await store.getRun("run_v1_kimi");
    const unknown = await store.getRun("run_v1_unknown");
    assert.equal(deepseek.plan[0]?.actorId, "deepseek");
    assert.equal(kimi.plan[0]?.actorId, "kimi");
    assert.equal(unknown.plan[0]?.actorId, "legacy-unknown");
    const recoveredKimi = await store.replaceRun(
      {
        ...kimi,
        status: "running",
        currentAttempt: 0,
        failure: undefined,
      },
      kimi.version,
    );
    store.close();

    const inspection = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(
        (
          inspection.prepare(`
            SELECT snapshot_schema_version
            FROM orchestration_runs WHERE id = 'run_v1_kimi'
          `).get() as { snapshot_schema_version: number }
        ).snapshot_schema_version,
        2,
      );
    } finally {
      inspection.close();
    }

    const reopenedStore = new SQLiteCouncilStore(fixture.databasePath, 5_000);
    try {
      assert.deepEqual(await reopenedStore.getRun("run_v1_kimi"), recoveredKimi);
    } finally {
      reopenedStore.close();
    }
    const reopenedMigration = await migrateCouncilSchema(
      fixture.databasePath,
      5_000,
      { maxAttempts: 3 },
    );
    assert.deepEqual(reopenedMigration, {
      migrated: false,
      version: COUNCIL_SCHEMA_VERSION,
    });
  } finally {
    fixture.cleanup();
  }
});

test("v1 schema 漂移、未知对象、预占 Actor 表与当前保留 alias 冲突均 fail closed", async () => {
  const drifted = temporaryDatabase();
  const extraObject = temporaryDatabase();
  const reserved = temporaryDatabase();
  const currentCollision = temporaryDatabase();
  try {
    createProductionV1Database(drifted.databasePath);
    const driftedDatabase = new DatabaseSync(drifted.databasePath);
    driftedDatabase.exec(`
      DROP INDEX idx_messages_topic_created;
      CREATE INDEX idx_messages_topic_created ON messages(created_at, topic_id);
    `);
    driftedDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(drifted.databasePath, 5_000, { maxAttempts: 3 }),
      /v1 schema 定义不兼容/,
    );

    createProductionV1Database(extraObject.databasePath);
    const extraObjectDatabase = new DatabaseSync(extraObject.databasePath);
    extraObjectDatabase.exec("CREATE TABLE unsupported_extension (id TEXT PRIMARY KEY);");
    extraObjectDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(extraObject.databasePath, 5_000, { maxAttempts: 3 }),
      /v1 schema 必需对象集合不兼容/,
    );

    createProductionV1Database(reserved.databasePath);
    const reservedDatabase = new DatabaseSync(reserved.databasePath);
    reservedDatabase.exec("CREATE TABLE actor_identities (id TEXT PRIMARY KEY);");
    reservedDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(reserved.databasePath, 5_000, { maxAttempts: 3 }),
      /保留 Actor 表/,
    );

    await migrateCouncilSchema(currentCollision.databasePath, 5_000, { maxAttempts: 3 });
    const current = new DatabaseSync(currentCollision.databasePath);
    current.exec(`
      DELETE FROM actor_aliases WHERE alias = 'claude-code';
      INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
      VALUES ('claude-code', 'codex', 'adapter', '2026-01-01T00:00:00.000Z');
    `);
    current.close();
    await assert.rejects(
      migrateCouncilSchema(currentCollision.databasePath, 5_000, { maxAttempts: 3 }),
      /保留 Actor alias/,
    );
  } finally {
    drifted.cleanup();
    extraObject.cleanup();
    reserved.cleanup();
    currentCollision.cleanup();
  }
});

test("事务内故障优先 rollback，不用较旧 backup 覆盖健康活库", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  try {
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, {
        maxAttempts: 3,
        faultPoint: "before-commit",
      }),
      /故障注入/,
    );
    const database = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(pragmaInteger(database, "user_version"), 0);
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count,
        1,
      );
      const migrationTables = database
        .prepare(`
          SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type = 'table' AND name = 'schema_migrations'
        `)
        .get() as unknown as { count: number };
      assert.equal(migrationTables.count, 0);
    } finally {
      database.close();
    }
    assert.ok(readdirSync(fixture.directory).some((name) => name.endsWith(".backup")));
  } finally {
    fixture.cleanup();
  }
});

test("账本/user_version 不一致及未来版本均 fail closed", async () => {
  const mismatch = temporaryDatabase();
  const future = temporaryDatabase();
  const gap = temporaryDatabase();
  try {
    const mismatchDatabase = new DatabaseSync(mismatch.databasePath);
    mismatchDatabase.exec("PRAGMA user_version = 1;");
    mismatchDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(mismatch.databasePath, 5_000, { maxAttempts: 3 }),
      /不一致/,
    );

    const futureDatabase = new DatabaseSync(future.databasePath);
    futureDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES
        (1, 'initial', '2026-01-01T00:00:00.000Z'),
        (2, 'dynamic-actors', '2026-01-02T00:00:00.000Z'),
        (3, 'future', '2026-01-03T00:00:00.000Z');
      PRAGMA user_version = 3;
    `);
    futureDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(future.databasePath, 5_000, { maxAttempts: 3 }),
      /更高版本/,
    );

    const gapDatabase = new DatabaseSync(gap.databasePath);
    gapDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES
        (1, 'initial', '2026-01-01T00:00:00.000Z'),
        (4, 'gap', '2026-01-04T00:00:00.000Z');
      PRAGMA user_version = 4;
    `);
    gapDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(gap.databasePath, 5_000, { maxAttempts: 3 }),
      /账本不连续/,
    );
  } finally {
    mismatch.cleanup();
    future.cleanup();
    gap.cleanup();
  }
});

test("backup 后持续外部提交会按配置耗尽尝试且不丢写", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  let writes = 0;
  try {
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, {
        maxAttempts: 2,
        testAfterSnapshotPrepared: () => {
          writes += 1;
          const external = new DatabaseSync(fixture.databasePath);
          try {
            external.prepare(`
              INSERT INTO topics (
                id, title, question, constraints_json, project_path,
                status, created_by, created_at, updated_at
              ) VALUES (?, 'external', 'external', '[]', NULL, 'open', 'human', ?, ?)
            `).run(
              `topic_external_${String(writes)}`,
              new Date().toISOString(),
              new Date().toISOString(),
            );
          } finally {
            external.close();
          }
        },
      }),
      /持续变化/,
    );
    const database = new DatabaseSync(fixture.databasePath);
    try {
      const count = database
        .prepare("SELECT COUNT(*) AS count FROM topics")
        .get() as unknown as { count: number };
      assert.equal(count.count, 3);
      assert.equal(pragmaInteger(database, "user_version"), 0);
    } finally {
      database.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("当前版本 trigger 定义为空时按 canonical schema fail closed", async () => {
  const fixture = temporaryDatabase();
  try {
    await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.exec(`
        DROP TRIGGER trg_messages_revision_insert;
        CREATE TRIGGER trg_messages_revision_insert
          AFTER INSERT ON messages BEGIN
            SELECT 1;
          END;
      `);
    } finally {
      database.close();
    }
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 }),
      /schema 定义不兼容/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("首次空库在重试前被外部创建后会备份并保留新数据", async () => {
  const fixture = temporaryDatabase();
  let attempt = 0;
  try {
    const result = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
      testAfterSnapshotPrepared: () => {
        attempt += 1;
        if (attempt !== 1) {
          return;
        }
        createLegacyDatabase(fixture.databasePath, "topic_created_between_attempts");
      },
    });
    assert.equal(attempt, 2);
    assert.equal(result.migrated, true);
    assert.ok(result.backupPath);
    const database = new DatabaseSync(fixture.databasePath);
    const backup = new DatabaseSync(result.backupPath as string, { readOnly: true });
    try {
      for (const connection of [database, backup]) {
        const count = connection
          .prepare(`
            SELECT COUNT(*) AS count FROM topics
            WHERE id = 'topic_created_between_attempts'
          `)
          .get() as unknown as { count: number };
        assert.equal(count.count, 1);
      }
    } finally {
      backup.close();
      database.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("WAL checkpoint 被旧读快照阻塞时停止迁移且不生成 backup", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  const setup = new DatabaseSync(fixture.databasePath);
  setup.exec("PRAGMA journal_mode = WAL;");
  setup.close();
  const reader = new DatabaseSync(fixture.databasePath);
  reader.exec("BEGIN;");
  reader.prepare("SELECT * FROM topics").all();
  const writer = new DatabaseSync(fixture.databasePath);
  writer.prepare(`
    INSERT INTO topics (
      id, title, question, constraints_json, project_path,
      status, created_by, created_at, updated_at
    ) VALUES ('topic_after_snapshot', 'writer', 'writer', '[]', NULL, 'open', 'human', ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString());
  writer.close();
  try {
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 50, { maxAttempts: 1 }),
      /WAL checkpoint 未完成/,
    );
    assert.equal(
      readdirSync(fixture.directory).some((name) => name.endsWith(".backup")),
      false,
    );
  } finally {
    reader.exec("ROLLBACK;");
    reader.close();
    fixture.cleanup();
  }
});
