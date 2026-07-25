/**
 * @input  依赖：已由 Council Node 迁移器准备的 SQLite 与 node:sqlite
 * @output 导出：编排 schema SQL 和只读兼容性验证
 * @pos    Node 唯一迁移器与 SQLiteCouncilStore 共享的编排结构契约
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { DatabaseSync } from "node:sqlite";

interface RequiredTableRow {
  name: unknown;
}

interface SchemaVersionRow {
  value: unknown;
}

const REQUIRED_COUNCIL_TABLES = [
  "topics",
  "messages",
  "council_meta",
  "actor_identities",
  "actor_aliases",
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
] as const;

const REQUIRED_ORCHESTRATION_TABLES = [
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
] as const;

const REQUIRED_ORCHESTRATION_INDEXES = [
  "idx_orchestration_runs_topic_updated",
  "idx_orchestration_runs_status_updated",
  "idx_orchestration_runs_one_active_topic",
  "idx_orchestration_run_leases_expiry",
] as const;

const REQUIRED_ORCHESTRATION_TRIGGERS = [
  "trg_orchestration_runs_revision_insert",
  "trg_orchestration_runs_revision_update",
  "trg_orchestration_runs_revision_delete",
] as const;

export const ORCHESTRATION_SCHEMA_VERSION = 3;

function orchestrationSchemaSql(
  schemaVersion: number,
  snapshotVersions: string,
): string {
  return `
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value)
    VALUES ('content_revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value)
    VALUES ('orchestration_revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value)
    VALUES ('orchestration_schema_version', ${String(schemaVersion)});

  CREATE TABLE IF NOT EXISTS orchestration_runs (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
      status IN ('idle', 'running', 'waiting_agent', 'waiting_user', 'completed', 'failed', 'cancelled')
    ),
    snapshot_schema_version INTEGER NOT NULL CHECK (
      snapshot_schema_version IN (${snapshotVersions})
    ),
    snapshot_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orchestration_approvals (
    run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
    approval_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version > 0),
    approved_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    approved_by_legacy TEXT,
    applied_run_version INTEGER NOT NULL CHECK (applied_run_version > expected_version),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, approval_id)
  );

  CREATE TABLE IF NOT EXISTS orchestration_run_leases (
    run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orchestration_runs_topic_updated
    ON orchestration_runs(topic_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_updated
    ON orchestration_runs(status, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_runs_one_active_topic
    ON orchestration_runs(topic_id)
    WHERE status IN ('idle', 'running', 'waiting_agent', 'waiting_user');
  CREATE INDEX IF NOT EXISTS idx_orchestration_run_leases_expiry
    ON orchestration_run_leases(expires_at_ms);

  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_insert;
  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_update;
  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_delete;

  CREATE TRIGGER trg_orchestration_runs_revision_insert
    AFTER INSERT ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_orchestration_runs_revision_update
    AFTER UPDATE ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_orchestration_runs_revision_delete
    AFTER DELETE ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
`;
}

/** 只用于构造/验证历史 Council v2/v3 数据库，禁止新 Run 写入。 */
export const LEGACY_ORCHESTRATION_SCHEMA_V2_SQL = orchestrationSchemaSql(2, "1, 2");
export const ORCHESTRATION_SCHEMA_SQL = orchestrationSchemaSql(
  ORCHESTRATION_SCHEMA_VERSION,
  "1, 2, 3",
);

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  sql: unknown;
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function orchestrationSchemaObjects(database: DatabaseSync): Map<string, string> {
  const requiredByType: Readonly<Record<string, readonly string[]>> = {
    table: REQUIRED_ORCHESTRATION_TABLES,
    index: REQUIRED_ORCHESTRATION_INDEXES,
    trigger: REQUIRED_ORCHESTRATION_TRIGGERS,
  };
  const rows = database
    .prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all() as unknown as SchemaObjectRow[];
  const objects = new Map<string, string>();
  for (const row of rows) {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new Error("Council 编排 schema 元数据无效。");
    }
    if (requiredByType[row.type]?.includes(row.name)) {
      objects.set(`${row.type}:${row.name}`, normalizeSchemaSql(row.sql));
    }
  }
  return objects;
}

let canonicalObjects: ReadonlyMap<string, string> | undefined;

function canonicalOrchestrationSchemaObjects(): ReadonlyMap<string, string> {
  if (canonicalObjects) {
    return canonicalObjects;
  }
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE topics (id TEXT PRIMARY KEY);
      CREATE TABLE council_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE actor_identities (id TEXT PRIMARY KEY);
      CREATE TABLE actor_aliases (
        alias TEXT PRIMARY KEY COLLATE NOCASE,
        actor_id TEXT NOT NULL REFERENCES actor_identities(id)
      );
    `);
    database.exec(ORCHESTRATION_SCHEMA_SQL);
    canonicalObjects = orchestrationSchemaObjects(database);
    return canonicalObjects;
  } finally {
    database.close();
  }
}

export function assertOrchestrationSchema(database: DatabaseSync): void {
  const rows = database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
    `)
    .all() as unknown as RequiredTableRow[];
  const existing = new Set(
    rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
  const missing = REQUIRED_COUNCIL_TABLES.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`Council SQLite 缺少已迁移表：${missing.join(", ")}。`);
  }
  const expected = canonicalOrchestrationSchemaObjects();
  const actual = orchestrationSchemaObjects(database);
  for (const [key, expectedSql] of expected) {
    if (actual.get(key) !== expectedSql) {
      throw new Error(`Council 编排 schema 定义不兼容：${key}。`);
    }
  }
  if (actual.size !== expected.size) {
    throw new Error("Council 编排 schema 必需对象集合不兼容。");
  }
  const versionRow = database
    .prepare("SELECT value FROM council_meta WHERE key = 'orchestration_schema_version'")
    .get() as unknown as SchemaVersionRow | undefined;
  if (!versionRow || versionRow.value !== ORCHESTRATION_SCHEMA_VERSION) {
    throw new Error("不支持的 Council 编排数据库结构版本。");
  }
}
