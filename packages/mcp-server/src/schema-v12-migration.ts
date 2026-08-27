/**
 * @input  依赖：canonical v11 实施项表与 v12 任务树 DDL 三段常量
 * @output 导出：migrateVersionTwelve 与 v11 迁移源验证
 * @pos    v11→v12 原子重建实施项表：放宽决策锚点、引入任务树与审核发现字段
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import {
  WORK_ITEM_V12_INDEX_SQL,
  WORK_ITEM_V12_TABLE_SQL,
  WORK_ITEM_V12_TRIGGER_SQL,
} from "./schema-definitions.js";

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

function columnNames(database: DatabaseSync, table: string): string[] {
  const rows = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name?: unknown }>;
  return rows.map((row) => String(row.name));
}

export function assertVersionElevenMigrationSource(database: DatabaseSync): void {
  if (!hasTable(database, "work_items")) {
    throw new Error("Council v11 数据库缺少实施项表。");
  }
  const columns = columnNames(database, "work_items");
  if (columns.includes("parent_id")) {
    throw new Error("Council v11 数据库包含提前出现的实施项树字段。");
  }
  if (!columns.includes("decision_id")) {
    throw new Error("Council v11 实施项表定义不兼容。");
  }
}

/**
 * 重建而不是 ALTER：v12 要把 `decision_id` 放宽为可空，并把唯一索引从
 * 「同决策内标题唯一」改成「同父级内标题唯一」，两者 SQLite 都无法就地修改。
 *
 * 先用最终表名建新表再复制，是为了让 sqlite_master 里的 SQL 文本与
 * canonical 完全一致——迁移器逐对象比对文本，改名残留的引号会判定为 schema 漂移。
 */
export function migrateVersionTwelve(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionElevenMigrationSource(database);
  database.exec(`
    DROP TRIGGER trg_work_items_revision_insert;
    DROP TRIGGER trg_work_items_revision_update;
    DROP TRIGGER trg_work_items_revision_delete;
    DROP INDEX idx_work_items_topic_status;
    DROP INDEX idx_work_items_decision_title;
    ALTER TABLE work_items RENAME TO work_items_v11_old;
  `);
  database.exec(WORK_ITEM_V12_TABLE_SQL);
  // 索引与触发器此时都还没挂：复制不会把 revision 计数抬高 N 次，
  // 也不会在去重之前就撞上新的唯一约束。
  database.exec(`
    INSERT INTO work_items (
      id, topic_id, decision_id, title, details, status, status_note, version,
      created_by_actor_id, created_by_snapshot_json,
      updated_by_actor_id, updated_by_snapshot_json,
      created_at, updated_at, completed_at, sort_order
    )
    SELECT
      id, topic_id, decision_id, title, details, status, status_note, version,
      created_by_actor_id, created_by_snapshot_json,
      updated_by_actor_id, updated_by_snapshot_json,
      created_at, updated_at, completed_at,
      ROW_NUMBER() OVER (PARTITION BY topic_id ORDER BY created_at, rowid) - 1
    FROM work_items_v11_old;
  `);
  // 旧约束只保证「同决策内标题唯一」，同一议题的两个决策可以各有同名条目。
  // 新约束按父级判定，这类历史数据必须先去重，否则建索引会失败。
  database.exec(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY topic_id, parent_key, title COLLATE NOCASE
          ORDER BY created_at, rowid
        ) AS seq
      FROM work_items
    )
    UPDATE work_items
    SET title = title || ' #' || (
      SELECT seq FROM ranked WHERE ranked.id = work_items.id
    )
    WHERE id IN (SELECT id FROM ranked WHERE seq > 1);
  `);
  database.exec("DROP TABLE work_items_v11_old;");
  database.exec(WORK_ITEM_V12_INDEX_SQL);
  database.exec(WORK_ITEM_V12_TRIGGER_SQL);
  if (recordVersion) {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(12, "work-item-tree-and-review-findings", now);
    database.exec("PRAGMA user_version = 12;");
  }
}
