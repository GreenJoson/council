/**
 * @input  依赖：canonical v14 实施项委派表
 * @output 导出：v15 完成条件快照与跨客户端验收约束迁移
 * @pos    保留历史完成语义；新委派由服务显式写入验收策略
 */
import type { DatabaseSync } from "node:sqlite";

export function migrateVersionFifteen(database: DatabaseSync, recordVersion = true): void {
  database.exec(`
    ALTER TABLE work_item_delegations ADD COLUMN completion_policy TEXT NOT NULL
      DEFAULT 'review' CHECK (completion_policy IN ('review', 'human'));
    ALTER TABLE work_item_delegations ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '';

    CREATE TRIGGER trg_work_items_delegation_acceptance
    BEFORE UPDATE OF status ON work_items
    WHEN NEW.status = 'completed' AND NOT EXISTS (
      SELECT 1 FROM work_items child WHERE child.parent_id = NEW.id
    ) AND EXISTS (
      SELECT 1 FROM work_item_delegations d
      WHERE d.rowid = (
        SELECT rowid FROM work_item_delegations WHERE work_item_id = NEW.id
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      ) AND d.completion_policy = 'human'
      AND (NEW.updated_by_actor_id <> 'human'
        OR NEW.status_note IS NULL OR length(trim(NEW.status_note)) = 0)
    ) BEGIN
      SELECT RAISE(ABORT, '实施项需要人工填写验收证据后才能完成。');
    END;
  `);
  if (recordVersion) {
    database.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
      .run(15, "delegation-acceptance", new Date().toISOString());
    database.exec("PRAGMA user_version = 15;");
  }
}
