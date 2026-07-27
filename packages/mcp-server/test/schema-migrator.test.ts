/**
 * @input  依赖：临时 v1/v2/v4/v5/fresh SQLite、Node online backup 与 schema 迁移故障注入
 * @output 验证：动态 Actor、Provider/Agent 路由、v5→v6 RuntimeBinding、备份、回滚和 revision
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
import {
  LEGACY_ORCHESTRATION_SCHEMA_V2_SQL,
  RUNTIME_BINDING_SCHEMA_SQL,
  SQLiteCouncilStore,
} from "council-orchestrator";
import {
  COUNCIL_SCHEMA_VERSION,
  FROZEN_LEGACY_V1_SCHEMA_SQL,
  assertCouncilSchema,
  migrateCouncilSchema,
} from "../src/schema-migrator.js";
import { migrateVersionNine } from "../src/schema-v9-migration.js";

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

async function createCanonicalV2Database(databasePath: string): Promise<void> {
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      DROP TRIGGER trg_decisions_cycle_close_update;
      DROP TRIGGER trg_decisions_cycle_close_insert;
      DROP TABLE blocking_questions;
      DROP TABLE discussion_cycles;
      DROP TRIGGER IF EXISTS trg_decisions_runtime_close_insert;
      DROP TRIGGER IF EXISTS trg_decisions_runtime_close_update;
      DROP TABLE runtime_binding_requests;
      DROP TABLE runtime_binding_leases;
      DROP TABLE runtime_bindings;
      DROP TABLE agent_definitions;
      DROP TABLE provider_profiles;
      DROP TABLE brand_assets;
      DROP TABLE orchestration_run_leases;
      DROP TABLE orchestration_approvals;
      DROP TABLE orchestration_runs;
      CREATE TABLE agent_settings (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('claude-cli', 'codex-cli', 'openai-compatible')),
        model TEXT NOT NULL,
        base_url TEXT,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      DELETE FROM schema_migrations WHERE version >= 3;
      UPDATE council_meta SET value = 2 WHERE key = 'orchestration_schema_version';
      PRAGMA user_version = 2;
    `);
    database.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
    const insert = database.prepare(`
      INSERT INTO agent_settings (
        id, label, kind, model, base_url, enabled, requires_api_key, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "claude",
      "Claude Code",
      "claude-cli",
      "claude-model",
      null,
      1,
      0,
      "2026-01-01T00:00:00.000Z",
    );
    insert.run(
      "codex",
      "Codex CLI",
      "codex-cli",
      "",
      null,
      1,
      0,
      "2026-01-01T00:00:00.000Z",
    );
    insert.run(
      "deepseek",
      "DeepSeek",
      "openai-compatible",
      "deepseek-model",
      "https://api.example.com/v1",
      1,
      1,
      "2026-01-01T00:00:00.000Z",
    );
    insert.run(
      "kimi",
      "Kimi",
      "openai-compatible",
      "",
      null,
      0,
      1,
      "2026-01-01T00:00:00.000Z",
    );
  } finally {
    database.close();
  }
}

async function createCanonicalV4Database(databasePath: string): Promise<{
  historicalRows: Record<string, unknown[]>;
}> {
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const database = new DatabaseSync(databasePath);
  try {
    const now = "2026-01-01T00:00:00.000Z";
    const insertActor = database.prepare(`
      INSERT INTO actor_identities (
        id, slug, display_name, short_name, role,
        actor_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '模型顾问', 'agent', 'active', ?, ?)
    `);
    const insertAlias = database.prepare(`
      INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
      VALUES (?, ?, 'canonical', ?)
    `);
    const insertProvider = database.prepare(`
      INSERT INTO provider_profiles (
        id, slug, display_name, protocol, base_url, requires_api_key,
        credential_ref, brand_asset_id, status, config_revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'openai-compatible', ?, 1, ?, ?, 'active', 4, ?, ?)
    `);
    const insertAgent = database.prepare(`
      INSERT INTO agent_definitions (
        id, actor_id, provider_id, slug, display_name, model,
        mention_alias, enabled, config_revision, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 7, NULL, ?, ?)
    `);
    for (const actor of [
      {
        id: "kimi",
        displayName: "Kimi",
        shortName: "KI",
        baseUrl: "https://api.example.com/kimi",
        brandAssetId: "brand-kimi",
      },
      {
        id: "deepseek",
        displayName: "DeepSeek",
        shortName: "DS",
        baseUrl: "https://api.example.com/deepseek",
        brandAssetId: "brand-deepseek",
      },
    ]) {
      insertActor.run(actor.id, actor.id, actor.displayName, actor.shortName, now, now);
      insertAlias.run(actor.id, actor.id, now);
      insertProvider.run(
        `provider-${actor.id}`,
        actor.id,
        actor.displayName,
        actor.baseUrl,
        `credential-${actor.id}`,
        actor.brandAssetId,
        now,
        now,
      );
      insertAgent.run(
        `agent-${actor.id}`,
        actor.id,
        `provider-${actor.id}`,
        actor.id,
        actor.displayName,
        `${actor.id}-model`,
        actor.id,
        now,
        now,
      );
    }
    const kimiSnapshot = JSON.stringify({
      schemaVersion: 1,
      actorId: "kimi",
      slug: "kimi",
      displayName: "Kimi",
      shortName: "KI",
      role: "模型顾问",
    });
    database.prepare(`
      INSERT INTO topics (
        id, title, question, constraints_json, project_path,
        status, created_by_actor_id, created_by_snapshot_json,
        created_by_legacy, created_at, updated_at
      ) VALUES (
        'topic_v4_kimi', 'v4 Kimi', '保留历史身份', '[]', NULL,
        'open', 'kimi', ?, 'other', ?, ?
      )
    `).run(kimiSnapshot, now, now);
    database.prepare(`
      INSERT INTO orchestration_runs (
        id, topic_id, status, snapshot_schema_version, snapshot_json,
        version, created_at, updated_at
      ) VALUES (
        'run_v4_kimi', 'topic_v4_kimi', 'completed', 1, ?,
        9, '2026-01-01T00:04:00.000Z', '2026-01-01T00:05:00.000Z'
      )
    `).run(JSON.stringify(legacyRunSnapshot({
      id: "run_v4_kimi",
      topicId: "topic_v4_kimi",
      adapterId: "kimi",
      publicAuthor: "other",
      status: "completed",
    })));
    database.prepare(`
      INSERT INTO messages (
        id, topic_id, author_actor_id, author_snapshot_json,
        author_legacy, kind, content, parent_message_id, created_at
      ) VALUES (
        'message_v4_kimi', 'topic_v4_kimi', 'kimi', ?, 'other',
        'proposal', 'v4 历史消息', NULL, ?
      )
    `).run(kimiSnapshot, now);
    database.prepare(`
      INSERT INTO decisions (
        id, topic_id, title, decision, rationale, alternatives_json,
        status, created_by_actor_id, created_by_snapshot_json,
        created_by_legacy, created_at, updated_at
      ) VALUES (
        'decision_v4_kimi', 'topic_v4_kimi', 'v4 历史决策',
        '保持快照', '迁移不得改写', '[]', 'proposed',
        'kimi', ?, 'other', ?, ?
      )
    `).run(kimiSnapshot, now, now);
    database.exec(`
      DELETE FROM actor_aliases
      WHERE actor_id IN ('claude', 'codex');
      INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
      VALUES
        ('claude-v4-custom', 'claude', 'adapter', '${now}'),
        ('codex-v4-custom', 'codex', 'adapter', '${now}');
      UPDATE agent_definitions
      SET display_name = 'Claude Code', mention_alias = 'claude-v4-custom'
      WHERE actor_id = 'claude';
      UPDATE agent_definitions
      SET display_name = 'Codex CLI', mention_alias = 'codex-v4-custom'
      WHERE actor_id = 'codex';
      DROP TRIGGER trg_decisions_cycle_close_update;
      DROP TRIGGER trg_decisions_cycle_close_insert;
      DROP TABLE blocking_questions;
      DROP TABLE discussion_cycles;
      DROP TRIGGER IF EXISTS trg_decisions_runtime_close_insert;
      DROP TRIGGER IF EXISTS trg_decisions_runtime_close_update;
      DROP TABLE runtime_binding_requests;
      DROP TABLE runtime_binding_leases;
      DROP TABLE runtime_bindings;
      DELETE FROM schema_migrations WHERE version >= 5;
      PRAGMA user_version = 4;
    `);
    downgradeProviderProfilesBeforeVersionTen(database);
    return {
      historicalRows: {
        topics: plainSqlValue(database.prepare(`
          SELECT id, created_by_actor_id, created_by_snapshot_json, created_by_legacy
          FROM topics WHERE id = 'topic_v4_kimi'
        `).all()),
        messages: plainSqlValue(database.prepare(`
          SELECT id, author_actor_id, author_snapshot_json, author_legacy, content
          FROM messages WHERE id = 'message_v4_kimi'
        `).all()),
        decisions: plainSqlValue(database.prepare(`
          SELECT id, created_by_actor_id, created_by_snapshot_json,
                 created_by_legacy, decision
          FROM decisions WHERE id = 'decision_v4_kimi'
        `).all()),
        orchestrationRuns: plainSqlValue(database.prepare(`
          SELECT *
          FROM orchestration_runs
          WHERE id = 'run_v4_kimi'
        `).all()),
      },
    };
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

/**
 * 部分迁移测试从当前库机械回退到 v4/v5，用来证明整条升级链可重放。
 * v10 为 Provider 增加了 RuntimeDefinition 绑定；回退 fixture 必须真实移除该列，
 * 不能只改 user_version，否则得到的不是历史 schema。
 */
function downgradeProviderProfilesBeforeVersionTen(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec(`
      CREATE TEMP TABLE provider_profiles_pre_v10_backup AS
        SELECT * FROM provider_profiles;
      DROP TABLE provider_profiles;
      CREATE TABLE provider_profiles (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (
          protocol IN ('claude-cli', 'codex-cli', 'openai-compatible')
        ),
        base_url TEXT,
        requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1)),
        credential_ref TEXT UNIQUE,
        brand_asset_id TEXT NOT NULL REFERENCES brand_assets(id),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0)
      );
      CREATE INDEX idx_provider_profiles_status_slug
        ON provider_profiles(status, slug);
      INSERT INTO provider_profiles (
        id, slug, display_name, protocol, base_url, requires_api_key,
        credential_ref, brand_asset_id, status, created_at, updated_at, config_revision
      )
      SELECT
        id, slug, display_name, protocol, base_url, requires_api_key,
        credential_ref, brand_asset_id, status, created_at, updated_at, config_revision
      FROM provider_profiles_pre_v10_backup;
      DROP TABLE provider_profiles_pre_v10_backup;
    `);
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

function recreateVersionEightRuntimeTables(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER trg_decisions_runtime_close_update;
    DROP TRIGGER trg_decisions_runtime_close_insert;
    DROP TABLE runtime_binding_requests;
    DROP TABLE runtime_binding_leases;
    DROP TABLE runtime_bindings;
  `);
  database.exec(RUNTIME_BINDING_SCHEMA_SQL);
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

test("v9→v10 将 Kimi 专用协议归一为 ACP 且无损保留 session、lease 与请求账本", async () => {
  const fixture = temporaryDatabase();
  try {
    await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    const versionNine = new DatabaseSync(fixture.databasePath);
    try {
      recreateVersionEightRuntimeTables(versionNine);
      downgradeProviderProfilesBeforeVersionTen(versionNine);
      versionNine.exec(`
        DELETE FROM schema_migrations WHERE version >= 9;
        PRAGMA user_version = 8;
      `);
      migrateVersionNine(versionNine);
      const now = "2026-01-10T00:00:00.000Z";
      versionNine.exec(`
        INSERT INTO actor_identities (
          id, slug, display_name, short_name, role,
          actor_type, status, created_at, updated_at
        ) VALUES (
          'actor-kimi-v9', 'kimi-v9', 'Kimi Agent', 'KI', '模型顾问',
          'agent', 'active', '${now}', '${now}'
        );
        INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
        VALUES ('kimi-v9', 'actor-kimi-v9', 'adapter', '${now}');
        INSERT INTO provider_profiles (
          id, slug, display_name, protocol, base_url, requires_api_key,
          credential_ref, brand_asset_id, status, created_at, updated_at, config_revision
        ) VALUES (
          'provider-kimi-v9', 'kimi', 'Kimi', 'kimi-acp', NULL, 0,
          NULL, 'brand-kimi', 'active', '${now}', '${now}', 3
        );
        INSERT INTO agent_definitions (
          id, actor_id, provider_id, slug, display_name, model,
          mention_alias, enabled, deleted_at, created_at, updated_at, config_revision
        ) VALUES (
          'agent-kimi-v9', 'actor-kimi-v9', 'provider-kimi-v9', 'kimi-agent-v9',
          'Kimi Agent', 'k3', 'kimi-v9', 1, NULL, '${now}', '${now}', 4
        );
        INSERT INTO topics (
          id, title, question, constraints_json, project_path,
          status, created_by_actor_id, created_by_snapshot_json, created_by_legacy,
          created_at, updated_at
        ) VALUES (
          'topic-kimi-v9', 'ACP 迁移', 'session 必须无损', '[]', NULL, 'open',
          'human', '${HUMAN_SNAPSHOT_JSON.replaceAll("'", "''")}', NULL, '${now}', '${now}'
        );
        INSERT INTO messages (
          id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
          kind, content, parent_message_id, created_at
        ) VALUES (
          'message-kimi-v9', 'topic-kimi-v9', 'human',
          '${HUMAN_SNAPSHOT_JSON.replaceAll("'", "''")}', NULL,
          'proposal', '继续同一个 ACP session。', NULL, '${now}'
        );
        INSERT INTO runtime_bindings (
          id, topic_id, agent_id, actor_id, provider_id, binding_revision,
          agent_config_revision, provider_config_revision, project_path,
          transport_kind, session_id, cursor_created_at, cursor_message_id,
          status, state_version, epoch, process_instance_id, last_activity_at,
          close_reason, created_at, updated_at, closed_at
        ) VALUES (
          'binding-kimi-v9', 'topic-kimi-v9', 'agent-kimi-v9', 'actor-kimi-v9',
          'provider-kimi-v9', 'binding-revision-v9', 4, 3, NULL,
          'kimi-acp', 'session-kimi-v9', '${now}', 'message-kimi-v9',
          'idle', 7, 2, 'process-v9', '${now}', NULL, '${now}', '${now}', NULL
        );
        INSERT INTO runtime_binding_leases (
          binding_id, owner_id, lease_token, epoch, expires_at_ms, updated_at
        ) VALUES (
          'binding-kimi-v9', 'worker-v9', 'lease-v9', 2, 4102444800000, '${now}'
        );
        INSERT INTO runtime_binding_requests (
          topic_id, agent_id, request_message_id, consumed_at
        ) VALUES (
          'topic-kimi-v9', 'agent-kimi-v9', 'message-kimi-v9', '${now}'
        );
      `);
    } finally {
      versionNine.close();
    }

    const result = await migrateCouncilSchema(
      fixture.databasePath,
      5_000,
      { maxAttempts: 3 },
    );
    assert.equal(result.version, 10);
    const migrated = new DatabaseSync(fixture.databasePath);
    try {
      assert.deepEqual(
        plainSqlValue(migrated.prepare(`
          SELECT protocol, runtime_definition_id, config_revision
          FROM provider_profiles WHERE id = 'provider-kimi-v9'
        `).get()),
        {
          protocol: "acp",
          runtime_definition_id: "kimi-code",
          config_revision: 3,
        },
      );
      assert.deepEqual(
        plainSqlValue(migrated.prepare(`
          SELECT transport_kind, session_id, state_version, epoch, process_instance_id
          FROM runtime_bindings WHERE id = 'binding-kimi-v9'
        `).get()),
        {
          transport_kind: "acp",
          session_id: "session-kimi-v9",
          state_version: 7,
          epoch: 2,
          process_instance_id: "process-v9",
        },
      );
      assert.equal(
        (migrated.prepare(`
          SELECT COUNT(*) AS count FROM runtime_binding_leases
          WHERE binding_id = 'binding-kimi-v9' AND lease_token = 'lease-v9'
        `).get() as { count: number }).count,
        1,
      );
      assert.equal(
        (migrated.prepare(`
          SELECT COUNT(*) AS count FROM runtime_binding_requests
          WHERE topic_id = 'topic-kimi-v9'
            AND agent_id = 'agent-kimi-v9'
            AND request_message_id = 'message-kimi-v9'
        `).get() as { count: number }).count,
        1,
      );
      assertCouncilSchema(migrated);
    } finally {
      migrated.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("canonical v5→v6 故障原子回滚，重试迁移并重复打开稳定", async () => {
  const fixture = temporaryDatabase();
  try {
    await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    const downgrade = new DatabaseSync(fixture.databasePath);
    try {
      downgrade.exec(`
        DROP TRIGGER trg_decisions_cycle_close_update;
        DROP TRIGGER trg_decisions_cycle_close_insert;
        DROP TABLE blocking_questions;
        DROP TABLE discussion_cycles;
        DROP TRIGGER trg_decisions_runtime_close_update;
        DROP TRIGGER trg_decisions_runtime_close_insert;
        DROP TABLE runtime_binding_requests;
        DROP TABLE runtime_binding_leases;
        DROP TABLE runtime_bindings;
        DELETE FROM schema_migrations WHERE version >= 6;
        PRAGMA user_version = 5;
      `);
      downgradeProviderProfilesBeforeVersionTen(downgrade);
    } finally {
      downgrade.close();
    }

    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, {
        maxAttempts: 3,
        faultPoint: "before-commit",
      }),
      /故障注入/,
    );
    const rolledBack = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(pragmaInteger(rolledBack, "user_version"), 5);
      const bindingTables = rolledBack.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'runtime_binding%'
      `).get() as unknown as { count: number };
      assert.equal(bindingTables.count, 0);
      // 回滚必须整链原子：v7 的圆桌收敛表也不能残留，否则重试会撞上"提前出现"守卫。
      const cycleTables = rolledBack.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('discussion_cycles', 'blocking_questions')
      `).get() as unknown as { count: number };
      assert.equal(cycleTables.count, 0);
    } finally {
      rolledBack.close();
    }

    const migrated = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.equal(migrated.version, COUNCIL_SCHEMA_VERSION);
    const reopened = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.equal(reopened.migrated, false);
    const current = new DatabaseSync(fixture.databasePath);
    try {
      assertCouncilSchema(current);
    } finally {
      current.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("canonical v4 迁移为动态远程 Actor，冻结快照与重启均保持稳定", async () => {
  const fixture = temporaryDatabase();
  try {
    const before = await createCanonicalV4Database(fixture.databasePath);
    const migrated = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.version, COUNCIL_SCHEMA_VERSION);

    const database = new DatabaseSync(fixture.databasePath);
    let currentActors: Array<{
      id: string;
      actor_id: string;
      mention_alias: string;
      config_revision: number;
    }> = [];
    try {
      assertCouncilSchema(database);
      currentActors = plainSqlValue(database.prepare(`
        SELECT id, actor_id, mention_alias, config_revision
        FROM agent_definitions
        WHERE id IN ('agent-kimi', 'agent-deepseek')
        ORDER BY id
      `).all()) as unknown as typeof currentActors;
      assert.equal(currentActors.length, 2);
      for (const agent of currentActors) {
        assert.match(agent.actor_id, /^actor-[0-9a-f-]{36}$/u);
        assert.notEqual(agent.actor_id, agent.id.replace(/^agent-/u, ""));
        assert.equal(agent.config_revision, 8);
        assert.equal(
          (
            database.prepare(`
              SELECT actor_id
              FROM actor_aliases
              WHERE alias = ? COLLATE NOCASE
            `).get(agent.mention_alias) as { actor_id: string }
          ).actor_id,
          agent.actor_id,
        );
      }
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT id, status
          FROM actor_identities
          WHERE id IN ('deepseek', 'kimi')
          ORDER BY id
        `).all()),
        [
          { id: "deepseek", status: "inactive" },
          { id: "kimi", status: "inactive" },
        ],
      );
      assert.equal(
        (
          database.prepare(`
            SELECT COUNT(*) AS count
            FROM actor_aliases
            WHERE actor_id IN ('deepseek', 'kimi')
          `).get() as { count: number }
        ).count,
        0,
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT id, display_name, mention_alias
          FROM agent_definitions
          WHERE actor_id IN ('claude', 'codex')
          ORDER BY id
        `).all()),
        [
          { id: "claude", display_name: "Claude", mention_alias: "claude" },
          { id: "codex", display_name: "Codex", mention_alias: "codex" },
        ],
      );
      assert.deepEqual(
        {
          topics: plainSqlValue(database.prepare(`
            SELECT id, created_by_actor_id, created_by_snapshot_json, created_by_legacy
            FROM topics WHERE id = 'topic_v4_kimi'
          `).all()),
          messages: plainSqlValue(database.prepare(`
            SELECT id, author_actor_id, author_snapshot_json, author_legacy, content
            FROM messages WHERE id = 'message_v4_kimi'
          `).all()),
          decisions: plainSqlValue(database.prepare(`
            SELECT id, created_by_actor_id, created_by_snapshot_json,
                   created_by_legacy, decision
            FROM decisions WHERE id = 'decision_v4_kimi'
          `).all()),
          orchestrationRuns: plainSqlValue(database.prepare(`
            SELECT *
            FROM orchestration_runs
            WHERE id = 'run_v4_kimi'
          `).all()),
        },
        before.historicalRows,
      );
      assert.deepEqual(
        Object.fromEntries(Object.entries(before.historicalRows).map(
          ([table, rows]) => [table, rows.length],
        )),
        { topics: 1, messages: 1, decisions: 1, orchestrationRuns: 1 },
      );
    } finally {
      database.close();
    }

    assert.deepEqual(
      await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 }),
      { migrated: false, version: COUNCIL_SCHEMA_VERSION },
    );
    const reopened = new DatabaseSync(fixture.databasePath);
    try {
      assert.deepEqual(
        plainSqlValue(reopened.prepare(`
          SELECT id, actor_id, mention_alias, config_revision
          FROM agent_definitions
          WHERE id IN ('agent-kimi', 'agent-deepseek')
          ORDER BY id
        `).all()),
        currentActors,
      );
      assert.equal(
        (
          reopened.prepare(`
            SELECT COUNT(*) AS count
            FROM actor_aliases
            WHERE actor_id IN ('deepseek', 'kimi')
          `).get() as { count: number }
        ).count,
        0,
      );
      assert.deepEqual(
        plainSqlValue(reopened.prepare(`
          SELECT *
          FROM orchestration_runs
          WHERE id = 'run_v4_kimi'
        `).all()),
        before.historicalRows.orchestrationRuns,
      );
    } finally {
      reopened.close();
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

test("完整生产 v1 fixture 值级迁移、旧运行冻结与重复打开均无损", async () => {
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
      const migratedDeepSeek = plainSqlValue(database.prepare(`
          SELECT
            agent.id,
            agent.actor_id,
            agent.display_name,
            agent.model,
            agent.mention_alias,
            agent.enabled,
            provider.display_name AS provider_name,
            provider.credential_ref,
            brand.glyph_id
          FROM agent_definitions AS agent
          JOIN provider_profiles AS provider ON provider.id = agent.provider_id
          JOIN brand_assets AS brand ON brand.id = provider.brand_asset_id
          WHERE agent.id = 'deepseek'
        `).get()) as {
          id: string;
          actor_id: string;
          display_name: string;
          model: string;
          mention_alias: string;
          enabled: number;
          provider_name: string;
          credential_ref: string;
          glyph_id: string;
        };
      assert.match(migratedDeepSeek.actor_id, /^actor-[0-9a-f-]{36}$/u);
      assert.deepEqual(
        { ...migratedDeepSeek, actor_id: "<dynamic>" },
        {
          id: "deepseek",
          actor_id: "<dynamic>",
          display_name: "DeepSeek",
          model: "model-v1",
          mention_alias: "deepseek",
          enabled: 1,
          provider_name: "DeepSeek",
          credential_ref: "deepseek",
          glyph_id: "simple-icons-deepseek",
        },
      );
      assert.throws(
        () => database.prepare("SELECT * FROM agent_settings").all(),
        /no such table/u,
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
    await assert.rejects(
      store.replaceRun(
        {
          ...kimi,
          status: "running",
          currentAttempt: 0,
          failure: undefined,
        },
        kimi.version,
      ),
      /bindingRevision/u,
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
        1,
      );
    } finally {
      inspection.close();
    }

    const reopenedStore = new SQLiteCouncilStore(fixture.databasePath, 5_000);
    try {
      assert.deepEqual(await reopenedStore.getRun("run_v1_kimi"), kimi);
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

test("canonical v2 直迁当前版本：按证据迁移远程配置、故障回滚且重复打开稳定", async () => {
  const fixture = temporaryDatabase();
  try {
    await createCanonicalV2Database(fixture.databasePath);
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, {
        maxAttempts: 1,
        faultPoint: "before-commit",
      }),
      /故障注入/u,
    );
    const rolledBack = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(pragmaInteger(rolledBack, "user_version"), 2);
      assert.equal(
        (rolledBack.prepare("SELECT COUNT(*) AS count FROM agent_settings").get() as { count: number }).count,
        4,
      );
      assert.throws(
        () => rolledBack.prepare("SELECT * FROM provider_profiles").all(),
        /no such table/u,
      );
    } finally {
      rolledBack.close();
    }

    const migrated = await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    assert.equal(migrated.version, COUNCIL_SCHEMA_VERSION);
    const database = new DatabaseSync(fixture.databasePath);
    try {
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT id, display_name, credential_ref
          FROM provider_profiles ORDER BY id
        `).all()),
        [
          { id: "provider-claude", display_name: "Claude", credential_ref: null },
          { id: "provider-codex", display_name: "OpenAI Codex", credential_ref: null },
          { id: "provider-deepseek", display_name: "DeepSeek", credential_ref: "deepseek" },
        ],
      );
      const migratedAgents = plainSqlValue(database.prepare(`
          SELECT id, actor_id, mention_alias FROM agent_definitions ORDER BY id
        `).all()) as Array<{
          id: string;
          actor_id: string;
          mention_alias: string;
        }>;
      assert.deepEqual(migratedAgents.slice(0, 2), [
        { id: "claude", actor_id: "claude", mention_alias: "claude" },
        { id: "codex", actor_id: "codex", mention_alias: "codex" },
      ]);
      assert.equal(migratedAgents[2]?.id, "deepseek");
      assert.match(migratedAgents[2]?.actor_id ?? "", /^actor-[0-9a-f-]{36}$/u);
      assert.equal(migratedAgents[2]?.mention_alias, "deepseek");
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM provider_profiles WHERE slug = 'kimi'").get() as { count: number }).count,
        0,
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT
            MIN(config_revision) AS minimum,
            MAX(config_revision) AS maximum
          FROM provider_profiles
        `).get()),
        { minimum: 1, maximum: 1 },
      );
      assert.deepEqual(
        plainSqlValue(database.prepare(`
          SELECT
            MIN(config_revision) AS minimum,
            MAX(config_revision) AS maximum
          FROM agent_definitions
        `).get()),
        { minimum: 2, maximum: 2 },
      );
    } finally {
      database.close();
    }
    assert.deepEqual(
      await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 }),
      { migrated: false, version: COUNCIL_SCHEMA_VERSION },
    );
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
        (3, 'provider-agent-model-router', '2026-01-03T00:00:00.000Z'),
        (4, 'frozen-run-bindings', '2026-01-04T00:00:00.000Z'),
        (5, 'dynamic-provider-actors', '2026-01-05T00:00:00.000Z'),
        (6, 'topic-runtime-bindings', '2026-01-06T00:00:00.000Z'),
        (7, 'discussion-cycles', '2026-01-07T00:00:00.000Z'),
        (8, 'cycle-runtime-capabilities', '2026-01-08T00:00:00.000Z'),
        (9, 'runtime-protocols', '2026-01-09T00:00:00.000Z'),
        (10, 'generic-acp-runtime', '2026-01-10T00:00:00.000Z'),
        (11, 'future', '2026-01-11T00:00:00.000Z');
      PRAGMA user_version = 11;
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
        (6, 'gap', '2026-01-06T00:00:00.000Z');
      PRAGMA user_version = 6;
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
