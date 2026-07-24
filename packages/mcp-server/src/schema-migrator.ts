/**
 * @input  依赖：SQLite 文件、Node 官方 online backup 与编排 schema 契约
 * @output 导出：唯一生产迁移入口、canonical schema/版本/实例身份验证
 * @pos    所有 Council Store 打开数据库前必须经过的备份、身份与迁移安全边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  ORCHESTRATION_SCHEMA_SQL,
  ORCHESTRATION_SCHEMA_VERSION,
  assertOrchestrationSchema,
} from "council-orchestrator";

export const COUNCIL_SCHEMA_VERSION = 1;

const REQUIRED_TABLES = [
  "topics",
  "messages",
  "decisions",
  "agent_sessions",
  "council_meta",
  "council_identity",
  "agent_settings",
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
  "schema_migrations",
] as const;

const REQUIRED_INDEXES = [
  "idx_topics_project_updated",
  "idx_messages_topic_created",
  "idx_decisions_topic_created",
  "idx_orchestration_runs_topic_updated",
  "idx_orchestration_runs_status_updated",
  "idx_orchestration_runs_one_active_topic",
  "idx_orchestration_run_leases_expiry",
] as const;

const REQUIRED_REVISION_TRIGGERS = [
  "trg_topics_revision_insert",
  "trg_topics_revision_update",
  "trg_topics_revision_delete",
  "trg_messages_revision_insert",
  "trg_messages_revision_update",
  "trg_messages_revision_delete",
  "trg_decisions_revision_insert",
  "trg_decisions_revision_update",
  "trg_decisions_revision_delete",
  "trg_orchestration_runs_revision_insert",
  "trg_orchestration_runs_revision_update",
  "trg_orchestration_runs_revision_delete",
] as const;

const COUNTED_LEGACY_TABLES = [
  "topics",
  "messages",
  "decisions",
  "agent_sessions",
  "agent_settings",
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    project_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'closed')),
    created_by TEXT NOT NULL CHECK (created_by IN ('human', 'claude', 'codex', 'chair', 'other')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    author TEXT NOT NULL CHECK (author IN ('human', 'claude', 'codex', 'chair', 'other')),
    kind TEXT NOT NULL CHECK (kind IN ('brief', 'proposal', 'critique', 'rebuttal', 'synthesis', 'note')),
    content TEXT NOT NULL,
    parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    alternatives_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
    created_by TEXT NOT NULL CHECK (created_by IN ('human', 'claude', 'codex', 'chair', 'other')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_sessions (
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (topic_id, agent)
  );

  CREATE TABLE IF NOT EXISTS council_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_settings (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('claude-cli', 'codex-cli', 'openai-compatible')),
    model TEXT NOT NULL,
    base_url TEXT,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1)),
    updated_at TEXT NOT NULL
  );

  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('content_revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('orchestration_revision', 0);

  DROP TRIGGER IF EXISTS trg_topics_revision_insert;
  DROP TRIGGER IF EXISTS trg_topics_revision_update;
  DROP TRIGGER IF EXISTS trg_topics_revision_delete;
  DROP TRIGGER IF EXISTS trg_messages_revision_insert;
  DROP TRIGGER IF EXISTS trg_messages_revision_update;
  DROP TRIGGER IF EXISTS trg_messages_revision_delete;
  DROP TRIGGER IF EXISTS trg_decisions_revision_insert;
  DROP TRIGGER IF EXISTS trg_decisions_revision_update;
  DROP TRIGGER IF EXISTS trg_decisions_revision_delete;

  CREATE TRIGGER trg_topics_revision_insert
    AFTER INSERT ON topics BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_topics_revision_update
    AFTER UPDATE ON topics BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_topics_revision_delete
    AFTER DELETE ON topics BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_messages_revision_insert
    AFTER INSERT ON messages BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_messages_revision_update
    AFTER UPDATE ON messages BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_messages_revision_delete
    AFTER DELETE ON messages BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_decisions_revision_insert
    AFTER INSERT ON decisions BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_decisions_revision_update
    AFTER UPDATE ON decisions BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_decisions_revision_delete
    AFTER DELETE ON decisions BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;

  CREATE INDEX IF NOT EXISTS idx_topics_project_updated
    ON topics(project_path, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_topic_created
    ON messages(topic_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_decisions_topic_created
    ON decisions(topic_id, created_at ASC);
`;

const MIGRATION_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  );
`;

const COUNCIL_IDENTITY_SQL = `
  CREATE TABLE IF NOT EXISTS council_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    instance_id TEXT NOT NULL UNIQUE
  );
`;

interface ScalarRow {
  value: unknown;
}

interface NameRow {
  name: unknown;
}

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  sql: unknown;
}

export type MigrationFaultPoint = "before-commit";

export interface CouncilMigrationOptions {
  maxAttempts: number;
  /** 仅供故障回归测试；生产入口不得传入。 */
  faultPoint?: MigrationFaultPoint;
  /** 仅供并发回归测试，在本轮快照及可选 backup 准备后制造外部提交。 */
  testAfterSnapshotPrepared?: () => void;
}

export interface CouncilMigrationResult {
  migrated: boolean;
  version: number;
  backupPath?: string;
}

function openDatabase(databasePath: string, busyTimeoutMs: number): DatabaseSync {
  const database = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
  return database;
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

function integerPragma(database: DatabaseSync, name: "data_version" | "user_version"): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  try {
    return singleIntegerRow(row, name);
  } catch {
    throw new Error(`Council SQLite ${name} 无效。`);
  }
}

function hasTable(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as unknown as NameRow | undefined;
  return typeof row?.name === "string";
}

function ledgerVersion(database: DatabaseSync): number {
  if (!hasTable(database, "schema_migrations")) {
    return 0;
  }
  const rows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as unknown[];
  const versions = rows.map((row) => singleIntegerRow(row, "schema_migrations version"));
  let expectedVersion = 1;
  for (const version of versions) {
    if (version !== expectedVersion) {
      throw new Error("Council schema_migrations 账本不连续。");
    }
    expectedVersion += 1;
  }
  return expectedVersion - 1;
}

function assertVersionMirror(database: DatabaseSync): number {
  const ledger = ledgerVersion(database);
  const userVersion = integerPragma(database, "user_version");
  if (ledger !== userVersion) {
    throw new Error("Council schema_migrations 与 user_version 不一致。");
  }
  if (ledger > COUNCIL_SCHEMA_VERSION) {
    throw new Error("Council 数据库由更高版本创建，请升级应用后重试。");
  }
  return ledger;
}

function existingCounts(database: DatabaseSync): Map<string, number> {
  const counts = new Map<string, number>();
  for (const table of COUNTED_LEGACY_TABLES) {
    if (!hasTable(database, table)) {
      continue;
    }
    const row = database
      .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
      .get() as unknown as ScalarRow;
    if (typeof row.value !== "number" || !Number.isSafeInteger(row.value) || row.value < 0) {
      throw new Error(`Council ${table} 行数无效。`);
    }
    counts.set(table, row.value);
  }
  return counts;
}

function assertNames(
  database: DatabaseSync,
  type: "table" | "index" | "trigger",
  required: readonly string[],
): void {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = ?")
    .all(type) as unknown as NameRow[];
  const existing = new Set(
    rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
  const missing = required.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`Council SQLite 缺少 ${type}：${missing.join(", ")}。`);
  }
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

function requiredSchemaObjects(database: DatabaseSync): Map<string, string> {
  const requiredByType: Readonly<Record<string, readonly string[]>> = {
    table: REQUIRED_TABLES,
    index: REQUIRED_INDEXES,
    trigger: REQUIRED_REVISION_TRIGGERS,
  };
  const rows = database
    .prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger')
        AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all() as unknown as SchemaObjectRow[];
  const objects = new Map<string, string>();
  for (const row of rows) {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new Error("Council SQLite schema 元数据无效。");
    }
    const requiredNames = requiredByType[row.type];
    if (requiredNames?.includes(row.name)) {
      objects.set(`${row.type}:${row.name}`, normalizeSchemaSql(row.sql));
    }
  }
  return objects;
}

let canonicalSchemaObjects: ReadonlyMap<string, string> | undefined;

function canonicalRequiredSchemaObjects(): ReadonlyMap<string, string> {
  if (canonicalSchemaObjects) {
    return canonicalSchemaObjects;
  }
  const canonical = new DatabaseSync(":memory:");
  try {
    canonical.exec(BASE_SCHEMA_SQL);
    canonical.exec(ORCHESTRATION_SCHEMA_SQL);
    canonical.exec(MIGRATION_LEDGER_SQL);
    canonical.exec(COUNCIL_IDENTITY_SQL);
    canonicalSchemaObjects = requiredSchemaObjects(canonical);
    return canonicalSchemaObjects;
  } finally {
    canonical.close();
  }
}

function assertCanonicalSchema(database: DatabaseSync): void {
  const expected = canonicalRequiredSchemaObjects();
  const actual = requiredSchemaObjects(database);
  for (const [key, expectedSql] of expected) {
    const actualSql = actual.get(key);
    if (actualSql !== expectedSql) {
      throw new Error(`Council SQLite schema 定义不兼容：${key}。`);
    }
  }
  if (actual.size !== expected.size) {
    throw new Error("Council SQLite schema 必需对象集合不兼容。");
  }
}

function revisionValue(database: DatabaseSync, key: string): number {
  const row = database
    .prepare("SELECT value FROM council_meta WHERE key = ?")
    .get(key) as unknown as ScalarRow | undefined;
  if (typeof row?.value !== "number" || !Number.isSafeInteger(row.value) || row.value < 0) {
    throw new Error(`Council revision ${key} 无效。`);
  }
  return row.value;
}

export function readCouncilDatabaseInstanceId(database: DatabaseSync): string {
  const row = database
    .prepare("SELECT instance_id AS value FROM council_identity WHERE singleton = 1")
    .get() as unknown as ScalarRow | undefined;
  if (typeof row?.value !== "string" || !UUID_PATTERN.test(row.value)) {
    throw new Error("Council SQLite 数据库实例身份无效。");
  }
  const count = database
    .prepare("SELECT COUNT(*) AS value FROM council_identity")
    .get() as unknown as ScalarRow;
  if (count.value !== 1) {
    throw new Error("Council SQLite 数据库实例身份必须且只能有一条。");
  }
  return row.value;
}

function assertRevisionBehavior(database: DatabaseSync): void {
  const topicId = `topic_schema_probe_${randomUUID()}`;
  const runId = `run_schema_probe_${randomUUID()}`;
  const now = new Date().toISOString();
  const beforeTotal = revisionValue(database, "revision");
  const beforeContent = revisionValue(database, "content_revision");
  const beforeOrchestration = revisionValue(database, "orchestration_revision");
  database.exec("SAVEPOINT council_revision_probe;");
  try {
    database.prepare(`
      INSERT INTO topics (
        id, title, question, constraints_json, project_path,
        status, created_by, created_at, updated_at
      ) VALUES (?, 'schema probe', 'schema probe', '[]', NULL, 'open', 'human', ?, ?)
    `).run(topicId, now, now);
    if (
      revisionValue(database, "revision") !== beforeTotal + 1 ||
      revisionValue(database, "content_revision") !== beforeContent + 1 ||
      revisionValue(database, "orchestration_revision") !== beforeOrchestration
    ) {
      throw new Error("Council 内容 revision trigger 行为验证失败。");
    }
    database.prepare(`
      INSERT INTO orchestration_runs (
        id, topic_id, status, snapshot_schema_version, snapshot_json,
        version, created_at, updated_at
      ) VALUES (?, ?, 'idle', 1, '{}', 1, ?, ?)
    `).run(runId, topicId, now, now);
    if (
      revisionValue(database, "revision") !== beforeTotal + 2 ||
      revisionValue(database, "content_revision") !== beforeContent + 1 ||
      revisionValue(database, "orchestration_revision") !== beforeOrchestration + 1
    ) {
      throw new Error("Council 编排 revision trigger 行为验证失败。");
    }
  } finally {
    database.exec("ROLLBACK TO council_revision_probe; RELEASE council_revision_probe;");
  }
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
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

export function assertCouncilSchema(database: DatabaseSync): void {
  const version = assertVersionMirror(database);
  if (version !== COUNCIL_SCHEMA_VERSION) {
    throw new Error("Council SQLite 尚未由 Node 迁移器升级到受支持版本。");
  }
  assertNames(database, "table", REQUIRED_TABLES);
  assertNames(database, "index", REQUIRED_INDEXES);
  assertNames(database, "trigger", REQUIRED_REVISION_TRIGGERS);
  assertCanonicalSchema(database);
  assertOrchestrationSchema(database);
  readCouncilDatabaseInstanceId(database);
  assertDatabaseIntegrity(database);
  assertRevisionBehavior(database);
}

function migrateVersionOne(database: DatabaseSync): void {
  database.exec(BASE_SCHEMA_SQL);
  database.exec(ORCHESTRATION_SCHEMA_SQL);
  database.exec(MIGRATION_LEDGER_SQL);
  database.exec(COUNCIL_IDENTITY_SQL);
  database.prepare(`
    INSERT INTO council_identity (singleton, instance_id)
    VALUES (1, ?)
  `).run(randomUUID());
  database.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
  `).run(COUNCIL_SCHEMA_VERSION, "initial-unified-schema", new Date().toISOString());
  database.exec(`PRAGMA user_version = ${String(COUNCIL_SCHEMA_VERSION)};`);
}

function assertCountsPreserved(database: DatabaseSync, before: ReadonlyMap<string, number>): void {
  for (const [table, expected] of before) {
    const row = database
      .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
      .get() as unknown as ScalarRow;
    if (row.value !== expected) {
      throw new Error(`Council ${table} 行数在迁移中发生变化。`);
    }
  }
}

function backupPathFor(databasePath: string, sourceVersion: number): string {
  const parsed = path.parse(databasePath);
  return path.join(
    parsed.dir,
    `${parsed.name}.schema-v${sourceVersion.toString()}-${Date.now().toString()}-${randomUUID()}${parsed.ext}.backup`,
  );
}

function schemaObjects(database: DatabaseSync): SchemaObjectRow[] {
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
    const actualSchema = schemaObjects(database);
    if (!sameSchemaObjects(actualSchema, expectedSchema)) {
      throw new Error("Council schema 备份表结构与源库不一致。");
    }
    assertCountsPreserved(database, expectedCounts);
  } finally {
    database.close();
  }
}

function protectFile(filePath: string): void {
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o600);
  }
}

/**
 * 迁移前 backup 与 BEGIN EXCLUSIVE 之间若有外部提交，data_version 会变化，
 * 当前备份立即作废并重试，绝不拿较旧备份覆盖更新后的活库。
 */
export async function migrateCouncilSchema(
  databasePath: string,
  busyTimeoutMs: number,
  options: CouncilMigrationOptions,
): Promise<CouncilMigrationResult> {
  if (!databasePath.trim()) {
    throw new Error("SQLite 数据库路径不能为空。");
  }
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
    throw new Error("SQLite busy timeout 必须是正整数。");
  }
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0) {
    throw new Error("Council schema 迁移最大尝试次数必须是正整数。");
  }
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const database = openDatabase(databasePath, busyTimeoutMs);
    let backupPath: string | undefined;
    let backupVerified = false;
    let transactionOpen = false;
    try {
      const initialVersion = ledgerVersion(database);
      const initialUserVersion = integerPragma(database, "user_version");
      if (initialVersion !== initialUserVersion && (initialVersion !== 0 || initialUserVersion !== 0)) {
        throw new Error("Council schema_migrations 与 user_version 不一致。");
      }
      if (initialVersion > COUNCIL_SCHEMA_VERSION) {
        throw new Error("Council 数据库由更高版本创建，请升级应用后重试。");
      }
      if (initialVersion === COUNCIL_SCHEMA_VERSION) {
        assertCouncilSchema(database);
        return { migrated: false, version: initialVersion };
      }

      const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const checkpointValues = typeof checkpoint === "object" && checkpoint !== null
        ? Object.values(checkpoint)
        : [];
      const [busy, logFrames, checkpointedFrames] = checkpointValues;
      if (
        checkpointValues.length !== 3 ||
        busy !== 0 ||
        typeof logFrames !== "number" ||
        !Number.isSafeInteger(logFrames) ||
        logFrames < 0 ||
        typeof checkpointedFrames !== "number" ||
        !Number.isSafeInteger(checkpointedFrames) ||
        checkpointedFrames < 0 ||
        logFrames !== checkpointedFrames
      ) {
        throw new Error("Council SQLite WAL checkpoint 未完成，迁移已停止。");
      }

      const dataVersionBeforeSnapshot = integerPragma(database, "data_version");
      const counts = existingCounts(database);
      const sourceSchema = schemaObjects(database);
      const backedUpDataVersion = integerPragma(database, "data_version");
      if (dataVersionBeforeSnapshot !== backedUpDataVersion) {
        if (attempt === options.maxAttempts) {
          throw new Error("Council SQLite 在迁移快照采集期间持续变化，已安全停止。");
        }
        continue;
      }
      if (sourceSchema.length > 0) {
        backupPath = backupPathFor(databasePath, initialVersion);
        try {
          await backup(database, backupPath);
          protectFile(backupPath);
          assertBackup(backupPath, sourceSchema, counts, initialUserVersion);
          backupVerified = true;
        } catch (error) {
          const changed = integerPragma(database, "data_version") !== backedUpDataVersion;
          rmSync(backupPath, { force: true });
          backupPath = undefined;
          if (changed && attempt < options.maxAttempts) {
            continue;
          }
          if (changed) {
            throw new Error("Council SQLite 在迁移备份期间持续变化，已安全停止。", {
              cause: error,
            });
          }
          throw error;
        }
      }
      options.testAfterSnapshotPrepared?.();

      database.exec("BEGIN EXCLUSIVE;");
      transactionOpen = true;
      if (integerPragma(database, "data_version") !== backedUpDataVersion) {
        database.exec("ROLLBACK;");
        transactionOpen = false;
        if (backupPath) {
          rmSync(backupPath, { force: true });
          backupVerified = false;
        }
        if (attempt === options.maxAttempts) {
          throw new Error("Council SQLite 在迁移准备期间持续变化，已安全停止。");
        }
        continue;
      }
      const versionAfterLock = ledgerVersion(database);
      const userVersionAfterLock = integerPragma(database, "user_version");
      if (
        versionAfterLock !== userVersionAfterLock &&
        (versionAfterLock !== 0 || userVersionAfterLock !== 0)
      ) {
        throw new Error("Council schema_migrations 与 user_version 不一致。");
      }
      if (versionAfterLock === COUNCIL_SCHEMA_VERSION) {
        database.exec("ROLLBACK;");
        transactionOpen = false;
        if (backupPath) {
          rmSync(backupPath, { force: true });
          backupVerified = false;
        }
        assertCouncilSchema(database);
        return { migrated: false, version: versionAfterLock };
      }
      if (versionAfterLock !== 0) {
        throw new Error("Council 数据库迁移版本链不连续。");
      }

      migrateVersionOne(database);
      assertCountsPreserved(database, counts);
      assertCouncilSchema(database);
      if (options.faultPoint === "before-commit") {
        throw new Error("Council schema 迁移故障注入。");
      }
      database.exec("COMMIT;");
      transactionOpen = false;
      assertCouncilSchema(database);
      protectFile(databasePath);
      return {
        migrated: true,
        version: COUNCIL_SCHEMA_VERSION,
        ...(backupPath ? { backupPath } : {}),
      };
    } catch (error) {
      if (backupPath && !backupVerified) {
        rmSync(backupPath, { force: true });
        backupPath = undefined;
      }
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK;");
          transactionOpen = false;
        } catch {
          // 后续完整性检查决定是否能继续自动运行。
        }
      }
      let rollbackHealthy = false;
      try {
        assertDatabaseIntegrity(database);
        rollbackHealthy = true;
      } catch {
        rollbackHealthy = false;
      }
      if (!rollbackHealthy) {
        const suffix = backupPath && backupVerified
          ? "已保留验证过的同目录备份，禁止自动覆盖可能包含更新写入的活库。"
          : "没有可验证备份，禁止继续打开数据库。";
        throw new Error(`Council schema 迁移回滚后完整性异常；${suffix}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      database.close();
    }
  }
  throw new Error("Council schema 迁移尝试次数耗尽。");
}
