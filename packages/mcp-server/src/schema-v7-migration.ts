/**
 * @input  依赖：canonical v6 内容/RuntimeBinding/Run v4 容器与圆桌收敛 DDL 正本
 * @output 导出：migrateVersionSeven 与 v6 迁移源验证
 * @pos    v6→v7 原子引入 DiscussionCycle 与 BlockingQuestion，仅新增表不重建旧表
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import { DISCUSSION_CYCLE_SCHEMA_SQL } from "./schema-definitions.js";

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

export function assertVersionSixMigrationSource(database: DatabaseSync): void {
  if (
    hasTable(database, "discussion_cycles")
    || hasTable(database, "blocking_questions")
  ) {
    throw new Error("Council v6 数据库包含提前出现的圆桌收敛表。");
  }
  // 两张新表的外键指向 messages / decisions / actor_identities / topics，
  // 缺任何一张都说明这不是一个真正的 v6 库，宁可拒绝迁移也不要建出悬空引用。
  for (const required of [
    "topics",
    "messages",
    "decisions",
    "actor_identities",
    "runtime_bindings",
  ]) {
    if (!hasTable(database, required)) {
      throw new Error(`Council v6 数据库缺少前置表：${required}。`);
    }
  }
  const revisionKeys = database.prepare(`
    SELECT COUNT(*) AS value
    FROM council_meta
    WHERE key IN ('revision', 'orchestration_revision')
  `).get() as unknown as ScalarRow | undefined;
  // 新触发器自增这两个计数器；键不存在时 UPDATE 静默无效，UI 将永远刷不出新状态。
  if (revisionKeys?.value !== 2) {
    throw new Error("Council v6 数据库缺少 revision 计数器。");
  }
}

export function migrateVersionSeven(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionSixMigrationSource(database);
  database.exec(DISCUSSION_CYCLE_SCHEMA_SQL);
  if (recordVersion) {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(7, "discussion-cycles", now);
    database.exec("PRAGMA user_version = 7;");
  }
}
