/**
 * @input  依赖：canonical v13 Agent 路由、实施项与 revision 元数据
 * @output 导出：migrateVersionFourteen 与 v13 迁移源验证
 * @pos    v13→v14 Agent 权限/职责和跨 Agent 实施项委派账本迁移
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";

interface ScalarRow {
  value: unknown;
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name?: unknown;
  }>).map((row) => String(row.name));
}

export function assertVersionThirteenMigrationSource(database: DatabaseSync): void {
  const table = database.prepare(`
    SELECT name AS value FROM sqlite_master
    WHERE type = 'table' AND name = 'agent_definitions'
  `).get() as unknown as ScalarRow | undefined;
  if (table?.value !== "agent_definitions") {
    throw new Error("Council v13 数据库缺少 Agent 定义表。");
  }
  const columns = columnNames(database, "agent_definitions");
  if (columns.includes("permission_profile") || columns.includes("execution_role")) {
    throw new Error("Council v13 Agent 定义包含提前出现的执行权限字段。");
  }
}

export function migrateVersionFourteen(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionThirteenMigrationSource(database);
  database.exec(`
    ALTER TABLE agent_definitions ADD COLUMN permission_profile TEXT NOT NULL
      DEFAULT 'read_only'
      CHECK (permission_profile IN ('read_only', 'workspace_write', 'danger_full_access'));
    ALTER TABLE agent_definitions ADD COLUMN execution_role TEXT NOT NULL
      DEFAULT 'advisor'
      CHECK (execution_role IN ('advisor', 'executor', 'reviewer', 'hybrid'));

    UPDATE agent_definitions
    SET execution_role = 'hybrid'
    WHERE actor_id IN ('claude', 'codex');

    CREATE TABLE work_item_delegations (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      supervisor_agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
      executor_agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
      permission_profile TEXT NOT NULL CHECK (
        permission_profile IN ('workspace_write', 'danger_full_access')
      ),
      status TEXT NOT NULL CHECK (
        status IN (
          'queued', 'executing', 'reviewing', 'changes_requested',
          'approved', 'failed', 'cancelled'
        )
      ),
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      base_commit TEXT,
      head_commit TEXT,
      branch_name TEXT,
      worktree_path TEXT,
      executor_session_id TEXT,
      supervisor_session_id TEXT,
      summary TEXT,
      review TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (supervisor_agent_id <> executor_agent_id),
      CHECK (
        (status IN ('approved', 'failed', 'cancelled') AND completed_at IS NOT NULL)
        OR (status NOT IN ('approved', 'failed', 'cancelled') AND completed_at IS NULL)
      )
    );

    CREATE INDEX idx_work_item_delegations_topic_updated
      ON work_item_delegations(topic_id, updated_at DESC);
    CREATE INDEX idx_work_item_delegations_work_item
      ON work_item_delegations(work_item_id, updated_at DESC);
    CREATE UNIQUE INDEX idx_work_item_delegations_one_active
      ON work_item_delegations(work_item_id)
      WHERE status IN ('queued', 'executing', 'reviewing', 'changes_requested');

    CREATE TRIGGER trg_work_item_delegations_revision_insert
      AFTER INSERT ON work_item_delegations BEGIN
        UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
      END;
    CREATE TRIGGER trg_work_item_delegations_revision_update
      AFTER UPDATE ON work_item_delegations BEGIN
        UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
      END;
    CREATE TRIGGER trg_work_item_delegations_revision_delete
      AFTER DELETE ON work_item_delegations BEGIN
        UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
      END;
  `);
  if (recordVersion) {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(14, "agent-work-delegation", now);
    database.exec("PRAGMA user_version = 14;");
  }
}
