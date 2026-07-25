/**
 * @input  依赖：SQLite 连接、源库 schema/行数快照与目标备份路径
 * @output 导出：pragma/完整性/行数校验、schema 快照、验证过的在线备份与文件保护
 * @pos    schema migrator 的存储与备份基础设施边界，不负责版本迁移决策
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

interface ScalarRow {
  value: unknown;
}

export interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  sql: unknown;
}

function singleIntegerRow(row: unknown, label: string): number {
  if (typeof row !== "object" || row === null) {
    throw new Error(`Council SQLite ${label} 无效。`);
  }
  const values = Object.values(row);
  const value = values.length === 1 ? values[0] : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Council SQLite ${label} 无效。`);
  }
  return value;
}

export function integerPragma(
  database: DatabaseSync,
  name: "data_version" | "user_version",
): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  try {
    return singleIntegerRow(row, name);
  } catch {
    throw new Error(`Council SQLite ${name} 无效。`);
  }
}

export function assertDatabaseIntegrity(database: DatabaseSync): void {
  const quickCheck = database.prepare("PRAGMA quick_check").get();
  if (
    typeof quickCheck !== "object" ||
    quickCheck === null ||
    Object.values(quickCheck).length !== 1 ||
    Object.values(quickCheck)[0] !== "ok"
  ) {
    throw new Error("Council SQLite 完整性检查失败。");
  }
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length > 0) {
    throw new Error("Council SQLite 外键检查失败。");
  }
}

export function assertCountsPreserved(
  database: DatabaseSync,
  before: ReadonlyMap<string, number>,
): void {
  for (const [table, expected] of before) {
    if (table === "agent_settings") {
      continue;
    }
    const row = database
      .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
      .get() as unknown as ScalarRow;
    if (row.value !== expected) {
      throw new Error(`Council ${table} 行数在迁移中发生变化。`);
    }
  }
}

export function readCouncilSchemaObjects(database: DatabaseSync): SchemaObjectRow[] {
  const rows = database
    .prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger')
        AND name NOT LIKE 'sqlite_%'
        AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all() as unknown as SchemaObjectRow[];
  return rows.map((row) => {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new Error("Council SQLite schema 元数据无效。");
    }
    return row;
  });
}

function sameSchemaObjects(
  left: readonly SchemaObjectRow[],
  right: readonly SchemaObjectRow[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      item.type === other.type &&
      item.name === other.name &&
      item.sql === other.sql
    );
  });
}

function assertBackup(
  backupPath: string,
  expectedSchema: readonly SchemaObjectRow[],
  expectedCounts: ReadonlyMap<string, number>,
  expectedUserVersion: number,
): void {
  const database = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assertDatabaseIntegrity(database);
    if (integerPragma(database, "user_version") !== expectedUserVersion) {
      throw new Error("Council schema 备份版本与源库不一致。");
    }
    if (!sameSchemaObjects(readCouncilSchemaObjects(database), expectedSchema)) {
      throw new Error("Council schema 备份表结构与源库不一致。");
    }
    assertCountsPreserved(database, expectedCounts);
  } finally {
    database.close();
  }
}

function backupPathFor(databasePath: string, sourceVersion: number): string {
  const parsed = path.parse(databasePath);
  return path.join(
    parsed.dir,
    `${parsed.name}.schema-v${sourceVersion.toString()}-${Date.now().toString()}-${randomUUID()}${parsed.ext}.backup`,
  );
}

export async function createVerifiedSchemaBackup(
  database: DatabaseSync,
  databasePath: string,
  sourceVersion: number,
  expectedSchema: readonly SchemaObjectRow[],
  expectedCounts: ReadonlyMap<string, number>,
  expectedUserVersion: number,
): Promise<string> {
  const backupPath = backupPathFor(databasePath, sourceVersion);
  try {
    await backup(database, backupPath);
    protectSqliteFile(backupPath);
    assertBackup(backupPath, expectedSchema, expectedCounts, expectedUserVersion);
    return backupPath;
  } catch (error) {
    rmSync(backupPath, { force: true });
    throw error;
  }
}

export function protectSqliteFile(filePath: string): void {
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o600);
  }
}
