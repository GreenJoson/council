/** @input canonical v16 委派；@output 持久执行检查点；@pos 追加私有状态列，旧记录和审计保持不变。 */
import type { DatabaseSync } from "node:sqlite";
export function migrateVersionSeventeen(database: DatabaseSync, recordVersion = true): void {
  database.exec(`ALTER TABLE work_item_delegations ADD COLUMN execution_state_json TEXT
    CHECK (execution_state_json IS NULL OR (json_valid(execution_state_json) AND json_type(execution_state_json) = 'object'));`);
  if (recordVersion) {
    database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(17, "delegation-runtime-checkpoints", new Date().toISOString());
    database.exec("PRAGMA user_version = 17;");
  }
}
