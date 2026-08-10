/**
 * @input  依赖：canonical v10 内容表与实施项 DDL
 * @output 导出：migrateVersionEleven 与 v10 迁移源验证
 * @pos    v10→v11 原子引入与 Accepted 决策绑定的实施进度清单
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import { WORK_ITEM_SCHEMA_SQL } from "./schema-definitions.js";

interface ScalarRow {
  value: unknown;
}

function hasTable(database: DatabaseSync, name: string): boolean {
  const row = database.prepare(`
    SELECT name AS value
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(name) as unknown as ScalarRow | undefined;
  return row?.value === name;
}

export function assertVersionTenMigrationSource(database: DatabaseSync): void {
  if (!hasTable(database, "discussion_cycles") || !hasTable(database, "runtime_bindings")) {
    throw new Error("Council v10 数据库缺少实施项迁移所需的 canonical 表。");
  }
  if (hasTable(database, "work_items")) {
    throw new Error("Council v10 数据库包含提前出现的实施项表。");
  }
}

export function migrateVersionEleven(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionTenMigrationSource(database);
  database.exec(WORK_ITEM_SCHEMA_SQL);
  if (recordVersion) {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(11, "decision-work-items", now);
    database.exec("PRAGMA user_version = 11;");
  }
}
