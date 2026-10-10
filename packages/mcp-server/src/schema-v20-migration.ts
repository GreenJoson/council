/**
 * @input  依赖：canonical v19 数据库（work_items、work_item_delegations 与资产库已存在）
 * @output 导出：migrateVersionTwenty、TEAM_V20_SCHEMA_SQL 与 v19 迁移源验证
 * @pos    v19→v20 Worker 团队：新增 task_teams / task_workers、委派 team_worker 标记与重建的单活跃委派索引
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 设计取舍：
 * - Worker 也是一条 work_item_delegations 行（复用工作区、会话、审计与 onSettled），
 *   挂在 Lead 同一个 work_item 上；为不撞「一个实施项只能有一条进行中委派」的唯一索引，
 *   委派表新增 team_worker 列，唯一索引只约束 team_worker = 0 的行（Lead 与普通委派）。
 * - 团队、Worker 都随实施项 / 委派级联删除（ON DELETE CASCADE），与委派本身的生命周期一致。
 * - task_teams_one_active：同一实施项最多一个 active 团队；ended 团队保留作历史。
 * - 两表都带 revision / orchestration_revision 触发器，让 HTTP council.changed 推送团队变化。
 * - 契约之外的补充列：task_teams.max_parallel（创建时冻结的并行上限）、
 *   task_workers.merged_commit（合并进 Lead 分支后的提交）、task_workers.scope_paths_json（派发时声明的文件范围）。
 */
import type { DatabaseSync } from "node:sqlite";

interface ScalarRow {
  value: unknown;
}

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) as unknown as ScalarRow;
  return Number(row.value) > 0;
}

function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function assertVersionNineteenMigrationSource(database: DatabaseSync): void {
  if (!tableExists(database, "work_items") || !tableExists(database, "work_item_delegations") || !tableExists(database, "assets")) {
    throw new Error("Council v19 数据库缺少团队外键依赖的表。");
  }
  if (tableExists(database, "task_teams") || tableExists(database, "task_workers")
    || columnExists(database, "work_item_delegations", "team_worker")) {
    throw new Error("Council v19 数据库已存在团队结构，迁移源与预期不符。");
  }
}

export const TEAM_V20_SCHEMA_SQL = `
  ALTER TABLE work_item_delegations
    ADD COLUMN team_worker INTEGER NOT NULL DEFAULT 0 CHECK (team_worker IN (0, 1));
  DROP INDEX idx_work_item_delegations_one_active;
  CREATE UNIQUE INDEX idx_work_item_delegations_one_active
    ON work_item_delegations(work_item_id)
    WHERE status IN ('queued', 'executing', 'reviewing', 'changes_requested') AND team_worker = 0;

  CREATE TABLE task_teams (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    lead_delegation_id TEXT NOT NULL REFERENCES work_item_delegations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
    max_parallel INTEGER NOT NULL CHECK (max_parallel > 0),
    created_at TEXT NOT NULL,
    ended_at TEXT,
    CHECK ((status = 'ended') = (ended_at IS NOT NULL))
  );
  CREATE UNIQUE INDEX task_teams_one_active ON task_teams(work_item_id) WHERE status = 'active';
  CREATE INDEX idx_task_teams_work_item ON task_teams(work_item_id, created_at);
  CREATE TABLE task_workers (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES task_teams(id) ON DELETE CASCADE,
    delegation_id TEXT NOT NULL UNIQUE REFERENCES work_item_delegations(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    role TEXT,
    status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'done', 'error', 'archived')),
    focused INTEGER NOT NULL DEFAULT 0 CHECK (focused IN (0, 1)),
    merged_commit TEXT,
    scope_paths_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(scope_paths_json) AND json_type(scope_paths_json) = 'array'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_task_workers_team ON task_workers(team_id, created_at);

  CREATE TRIGGER trg_task_teams_revision_insert
    AFTER INSERT ON task_teams BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_task_teams_revision_update
    AFTER UPDATE ON task_teams BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_task_teams_revision_delete
    AFTER DELETE ON task_teams BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_task_workers_revision_insert
    AFTER INSERT ON task_workers BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_task_workers_revision_update
    AFTER UPDATE ON task_workers BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_task_workers_revision_delete
    AFTER DELETE ON task_workers BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
`;

export function migrateVersionTwenty(database: DatabaseSync, recordVersion = true): void {
  assertVersionNineteenMigrationSource(database);
  database.exec(TEAM_V20_SCHEMA_SQL);

  if (recordVersion) {
    database.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
      .run(20, "worker-teams", new Date().toISOString());
    database.exec("PRAGMA user_version = 20;");
  }
}
