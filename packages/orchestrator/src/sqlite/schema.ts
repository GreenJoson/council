/**
 * @input  依赖：已有 Council topics/messages/council_meta 表与 node:sqlite
 * @output 导出：编排运行、批准、执行 lease、唯一活动约束及 revision 迁移
 * @pos    SQLite CouncilStore 的追加式数据库结构
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";

interface RequiredTableRow {
  name: unknown;
}

interface SchemaVersionRow {
  value: unknown;
}

const REQUIRED_COUNCIL_TABLES = ["topics", "messages", "council_meta"] as const;

function assertBaseSchema(database: DatabaseSync): void {
  const rows = database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('topics', 'messages', 'council_meta')
    `)
    .all() as unknown as RequiredTableRow[];
  const existing = new Set(
    rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
  const missing = REQUIRED_COUNCIL_TABLES.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`Council SQLite 缺少基础表：${missing.join(", ")}。`);
  }
}

export function migrateOrchestrationSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    assertBaseSchema(database);
    database.exec(`
    INSERT OR IGNORE INTO council_meta (key, value) VALUES ('revision', 0);
    INSERT OR IGNORE INTO council_meta (key, value)
      VALUES ('content_revision', 0);
    INSERT OR IGNORE INTO council_meta (key, value)
      VALUES ('orchestration_revision', 0);
    INSERT OR IGNORE INTO council_meta (key, value)
      VALUES ('orchestration_schema_version', 1);

    CREATE TABLE IF NOT EXISTS orchestration_runs (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (
        status IN ('idle', 'running', 'waiting_agent', 'waiting_user', 'completed', 'failed', 'cancelled')
      ),
      snapshot_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_schema_version = 1),
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
      approved_by TEXT NOT NULL CHECK (
        approved_by IN ('human', 'claude', 'codex', 'chair', 'other')
      ),
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
    `);
    const versionRow = database
      .prepare("SELECT value FROM council_meta WHERE key = 'orchestration_schema_version'")
      .get() as unknown as SchemaVersionRow | undefined;
    if (!versionRow || versionRow.value !== 1) {
      throw new Error("不支持的 Council 编排数据库结构版本。");
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
