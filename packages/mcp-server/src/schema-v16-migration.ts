/**
 * @input  依赖：canonical v15 委派与议题
 * @output 导出：逐次运行审计、失败分类和恢复来源迁移
 * @pos    审计记录独立追加；恢复建立新委派并保留旧记录
 */
import type { DatabaseSync } from "node:sqlite";

export function migrateVersionSixteen(database: DatabaseSync, recordVersion = true): void {
  database.exec(`
    ALTER TABLE work_item_delegations ADD COLUMN resumed_from_id TEXT
      REFERENCES work_item_delegations(id) ON DELETE SET NULL;
    ALTER TABLE work_item_delegations ADD COLUMN failure_code TEXT;
    CREATE TABLE runtime_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('run', 'delegation')),
      source_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_runtime_audit_source
      ON runtime_audit_events(topic_id, source_kind, source_id, id);
    CREATE TRIGGER trg_runtime_audit_revision_insert AFTER INSERT ON runtime_audit_events BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key IN ('revision', 'orchestration_revision');
    END;
    CREATE TRIGGER trg_runtime_audit_immutable BEFORE UPDATE ON runtime_audit_events BEGIN
      SELECT RAISE(ABORT, '运行审计记录不可覆盖。');
    END;
  `);
  if (recordVersion) {
    database.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
      .run(16, "runtime-audit-and-recovery", new Date().toISOString());
    database.exec("PRAGMA user_version = 16;");
  }
}
