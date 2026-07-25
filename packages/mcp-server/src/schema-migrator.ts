/**
 * @input  依赖：SQLite 文件、纯 schema 定义、Node online backup 与编排 schema 契约
 * @output 导出：唯一生产迁移入口、冻结 v1/v2、canonical v6、版本/实例身份验证
 * @pos    所有 Council Store 打开数据库前必须经过的备份、身份与迁移安全边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  LEGACY_ORCHESTRATION_SCHEMA_V2_SQL,
  assertOrchestrationSchema,
} from "council-orchestrator";
import {
  ACTOR_SEEDS,
  ACTOR_SNAPSHOT_SCHEMA_VERSION,
  serializeActorSnapshot,
} from "./actor-identity.js";
import { seedReferencedLegacyDynamicActors } from "./legacy-dynamic-actors.js";
import {
  ACTOR_SCHEMA_SQL,
  COUNCIL_IDENTITY_SQL,
  COUNTED_LEGACY_TABLES,
  FINAL_CONTENT_REVISION_SQL,
  FINAL_CONTENT_SCHEMA_SQL,
  FROZEN_LEGACY_V1_SCHEMA_SHA256,
  FROZEN_LEGACY_V1_SCHEMA_SQL,
  LEGACY_BASE_SCHEMA_SQL,
  LEGACY_V1_INDEXES,
  LEGACY_V1_ORCHESTRATION_SCHEMA_SQL,
  LEGACY_V1_TABLES,
  LEGACY_V2_INDEXES,
  LEGACY_V2_TABLES,
  LEGACY_REQUIRED_REVISION_TRIGGERS,
  MIGRATION_LEDGER_SQL,
  REQUIRED_INDEXES,
  REQUIRED_REVISION_TRIGGERS,
  REQUIRED_TABLES,
} from "./schema-definitions.js";
import { migrateVersionThree } from "./schema-v3-migration.js";
import {
  legacyActorId,
  migrationInteger,
  migrationNullableString,
  migrationString,
} from "./schema-migration-values.js";
import {
  assertVersionThreeMigrationSource,
  migrateVersionFour,
} from "./schema-v4-migration.js";
import {
  assertVersionFourMigrationSource,
  migrateVersionFive,
} from "./schema-v5-migration.js";
import {
  assertVersionFiveMigrationSource,
  migrateVersionSix,
} from "./schema-v6-migration.js";
import {
  assertCountsPreserved,
  assertDatabaseIntegrity,
  createVerifiedSchemaBackup,
  integerPragma,
  protectSqliteFile,
  readCouncilSchemaObjects,
  type SchemaObjectRow,
} from "./schema-storage.js";

export { FROZEN_LEGACY_V1_SCHEMA_SQL } from "./schema-definitions.js";

export const COUNCIL_SCHEMA_VERSION = 6;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ScalarRow {
  value: unknown;
}

interface NameRow {
  name: unknown;
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
  return sql
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeLegacyV2SchemaSql(sql: string): string {
  return sql.replace(/\s*([(),])\s*/gu, "$1");
}

function selectedSchemaObjects(
  database: DatabaseSync,
  requiredByType: Readonly<Record<string, readonly string[]>>,
): Map<string, string> {
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

function requiredSchemaObjects(database: DatabaseSync): Map<string, string> {
  return selectedSchemaObjects(database, {
    table: REQUIRED_TABLES,
    index: REQUIRED_INDEXES,
    trigger: REQUIRED_REVISION_TRIGGERS,
  });
}

let canonicalSchemaObjects: ReadonlyMap<string, string> | undefined;
let canonicalLegacyV1SchemaObjects: ReadonlyMap<string, string> | undefined;
let canonicalLegacyV2SchemaObjects: ReadonlyMap<string, string> | undefined;

function legacyV1SchemaObjects(database: DatabaseSync): Map<string, string> {
  return new Map(
    readCouncilSchemaObjects(database).map((row) => [
      `${String(row.type)}:${String(row.name)}`,
      normalizeSchemaSql(String(row.sql)),
    ]),
  );
}

function canonicalLegacyV1RequiredSchemaObjects(): ReadonlyMap<string, string> {
  if (canonicalLegacyV1SchemaObjects) {
    return canonicalLegacyV1SchemaObjects;
  }
  const canonical = new DatabaseSync(":memory:");
  try {
    canonical.exec(FROZEN_LEGACY_V1_SCHEMA_SQL);
    canonicalLegacyV1SchemaObjects = legacyV1SchemaObjects(canonical);
    const digest = createHash("sha256")
      .update(JSON.stringify([...canonicalLegacyV1SchemaObjects]))
      .digest("hex");
    if (digest !== FROZEN_LEGACY_V1_SCHEMA_SHA256) {
      throw new Error("Council 冻结 v1 schema 定义已漂移，拒绝继续迁移。");
    }
    return canonicalLegacyV1SchemaObjects;
  } finally {
    canonical.close();
  }
}

function assertLegacyV1Schema(database: DatabaseSync): void {
  assertNames(database, "table", LEGACY_V1_TABLES);
  assertNames(database, "index", LEGACY_V1_INDEXES);
  assertNames(database, "trigger", LEGACY_REQUIRED_REVISION_TRIGGERS);
  const reservedTable = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'actor_identities', 'actor_aliases',
      'brand_assets', 'provider_profiles', 'agent_definitions'
    )
    LIMIT 1
  `).get() as unknown as NameRow | undefined;
  if (typeof reservedTable?.name === "string") {
    throw new Error("Council v1 数据库包含保留 Actor 表，拒绝继续迁移。");
  }
  const expected = canonicalLegacyV1RequiredSchemaObjects();
  const actual = legacyV1SchemaObjects(database);
  for (const [key, expectedSql] of expected) {
    if (actual.get(key) !== expectedSql) {
      throw new Error(`Council v1 schema 定义不兼容：${key}。`);
    }
  }
  if (actual.size !== expected.size) {
    throw new Error("Council v1 schema 必需对象集合不兼容。");
  }
  const orchestrationVersion = database.prepare(`
    SELECT value
    FROM council_meta
    WHERE key = 'orchestration_schema_version'
  `).get() as unknown as ScalarRow | undefined;
  if (orchestrationVersion?.value !== 1) {
    throw new Error("Council v1 编排 schema 版本无效。");
  }
  const migrationRows = database.prepare(`
    SELECT version, name
    FROM schema_migrations
    ORDER BY version
  `).all() as unknown as Array<{ version?: unknown; name?: unknown }>;
  if (
    migrationRows.length !== 1 ||
    migrationRows[0]?.version !== 1 ||
    migrationRows[0]?.name !== "initial-unified-schema"
  ) {
    throw new Error("Council v1 迁移账本内容无效。");
  }
  readCouncilDatabaseInstanceId(database);
  assertDatabaseIntegrity(database);
}

function legacyV2RequiredSchemaObjects(database: DatabaseSync): Map<string, string> {
  return selectedSchemaObjects(database, {
    table: LEGACY_V2_TABLES,
    index: LEGACY_V2_INDEXES,
    trigger: LEGACY_REQUIRED_REVISION_TRIGGERS,
  });
}

function canonicalLegacyV2RequiredSchemaObjects(): ReadonlyMap<string, string> {
  if (canonicalLegacyV2SchemaObjects) {
    return canonicalLegacyV2SchemaObjects;
  }
  const canonical = new DatabaseSync(":memory:");
  try {
    canonical.exec(LEGACY_BASE_SCHEMA_SQL);
    canonical.exec(ACTOR_SCHEMA_SQL);
    canonical.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
    canonical.exec(MIGRATION_LEDGER_SQL);
    canonical.exec(COUNCIL_IDENTITY_SQL);
    seedActors(canonical, new Date(0).toISOString());
    rebuildContentTablesForActors(canonical);
    rebuildOrchestrationTablesForActors(canonical);
    canonical.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
    canonicalLegacyV2SchemaObjects = legacyV2RequiredSchemaObjects(canonical);
    return canonicalLegacyV2SchemaObjects;
  } finally {
    canonical.close();
  }
}

function assertLegacyV2Schema(database: DatabaseSync): void {
  assertNames(database, "table", LEGACY_V2_TABLES);
  assertNames(database, "index", LEGACY_V2_INDEXES);
  assertNames(database, "trigger", LEGACY_REQUIRED_REVISION_TRIGGERS);
  const reserved = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('brand_assets', 'provider_profiles', 'agent_definitions')
    LIMIT 1
  `).get() as unknown as NameRow | undefined;
  if (typeof reserved?.name === "string") {
    throw new Error("Council v2 数据库包含保留模型路由表，拒绝继续迁移。");
  }
  const expected = canonicalLegacyV2RequiredSchemaObjects();
  const actual = legacyV2RequiredSchemaObjects(database);
  for (const [key, expectedSql] of expected) {
    const actualSql = actual.get(key);
    if (
      actualSql === undefined ||
      normalizeLegacyV2SchemaSql(actualSql) !== normalizeLegacyV2SchemaSql(expectedSql)
    ) {
      throw new Error(`Council v2 schema 定义不兼容：${key}。`);
    }
  }
  if (actual.size !== expected.size) {
    throw new Error("Council v2 schema 必需对象集合不兼容。");
  }
  const migrationRows = database.prepare(`
    SELECT version, name FROM schema_migrations ORDER BY version
  `).all() as unknown as Array<{ version?: unknown; name?: unknown }>;
  if (
    migrationRows.length !== 2 ||
    migrationRows[0]?.version !== 1 ||
    migrationRows[0]?.name !== "initial-unified-schema" ||
    migrationRows[1]?.version !== 2 ||
    migrationRows[1]?.name !== "dynamic-actor-identities"
  ) {
    throw new Error("Council v2 迁移账本内容无效。");
  }
  const orchestrationVersion = database.prepare(`
    SELECT value FROM council_meta WHERE key = 'orchestration_schema_version'
  `).get() as unknown as ScalarRow | undefined;
  if (orchestrationVersion?.value !== 2) {
    throw new Error("Council v2 编排 schema 版本无效。");
  }
  assertReservedActorMappings(database);
  readCouncilDatabaseInstanceId(database);
  assertDatabaseIntegrity(database);
}

function canonicalRequiredSchemaObjects(): ReadonlyMap<string, string> {
  if (canonicalSchemaObjects) {
    return canonicalSchemaObjects;
  }
  const canonical = new DatabaseSync(":memory:");
  try {
    canonical.exec(LEGACY_BASE_SCHEMA_SQL);
    canonical.exec(ACTOR_SCHEMA_SQL);
    canonical.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
    canonical.exec(MIGRATION_LEDGER_SQL);
    canonical.exec(COUNCIL_IDENTITY_SQL);
    seedActors(canonical, new Date(0).toISOString());
    rebuildContentTablesForActors(canonical);
    rebuildOrchestrationTablesForActors(canonical);
    canonical.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
    migrateVersionThree(canonical, false);
    migrateVersionFour(canonical, false);
    migrateVersionFive(canonical, false);
    migrateVersionSix(canonical, false);
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

function assertReservedActorMappings(database: DatabaseSync): void {
  const actorQuery = database.prepare(`
    SELECT id, slug, display_name, short_name, role, actor_type, status
    FROM actor_identities
    WHERE id = ?
  `);
  const aliasQuery = database.prepare(`
    SELECT actor_id, alias_kind
    FROM actor_aliases
    WHERE alias = ? COLLATE NOCASE
  `);
  for (const seed of ACTOR_SEEDS) {
    const actor = actorQuery.get(seed.id) as unknown as Readonly<{
      id?: unknown;
      slug?: unknown;
      display_name?: unknown;
      short_name?: unknown;
      role?: unknown;
      actor_type?: unknown;
      status?: unknown;
    }> | undefined;
    if (
      actor?.id !== seed.id ||
      actor.slug !== seed.slug ||
      actor.actor_type !== seed.actorType ||
      actor.status !== seed.status ||
      typeof actor.display_name !== "string" ||
      !actor.display_name ||
      typeof actor.short_name !== "string" ||
      !actor.short_name ||
      typeof actor.role !== "string" ||
      !actor.role
    ) {
      throw new Error(`Council 保留 Actor ${seed.id} 映射不兼容。`);
    }
    for (const expectedAlias of seed.aliases) {
      const alias = aliasQuery.get(expectedAlias.alias) as unknown as Readonly<{
        actor_id?: unknown;
        alias_kind?: unknown;
      }> | undefined;
      if (
        alias?.actor_id !== seed.id ||
        alias.alias_kind !== expectedAlias.kind
      ) {
        throw new Error(`Council 保留 Actor alias ${expectedAlias.alias} 映射不兼容。`);
      }
    }
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
        status, created_by_actor_id, created_by_snapshot_json,
        created_by_legacy, created_at, updated_at
      ) VALUES (?, 'schema probe', 'schema probe', '[]', NULL, 'open', 'human', ?, NULL, ?, ?)
    `).run(topicId, snapshotJsonForActor(database, "human"), now, now);
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
  assertReservedActorMappings(database);
  const migrationRows = database.prepare(`
    SELECT version, name FROM schema_migrations ORDER BY version
  `).all() as unknown as Array<{ version?: unknown; name?: unknown }>;
  const expectedMigrations = [
    [1, "initial-unified-schema"],
    [2, "dynamic-actor-identities"],
    [3, "provider-agent-model-router"],
    [4, "frozen-run-bindings"],
    [5, "dynamic-provider-actors"],
    [6, "topic-runtime-bindings"],
  ] as const;
  if (
    migrationRows.length !== expectedMigrations.length ||
    expectedMigrations.some(([versionNumber, name], index) =>
      migrationRows[index]?.version !== versionNumber ||
      migrationRows[index]?.name !== name)
  ) {
    throw new Error("Council v6 迁移账本内容无效。");
  }
  readCouncilDatabaseInstanceId(database);
  assertDatabaseIntegrity(database);
  assertRevisionBehavior(database);
}

function migrateVersionOne(database: DatabaseSync): void {
  database.exec(LEGACY_BASE_SCHEMA_SQL);
  database.exec(LEGACY_V1_ORCHESTRATION_SCHEMA_SQL);
  database.exec(MIGRATION_LEDGER_SQL);
  database.exec(COUNCIL_IDENTITY_SQL);
  database.prepare(`
    INSERT INTO council_identity (singleton, instance_id)
    VALUES (1, ?)
  `).run(randomUUID());
  database.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
  `).run(1, "initial-unified-schema", new Date().toISOString());
  database.exec("PRAGMA user_version = 1;");
}

function seedActors(database: DatabaseSync, now: string): void {
  const insertActor = database.prepare(`
    INSERT INTO actor_identities (
      id, slug, display_name, short_name, role,
      actor_type, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlias = database.prepare(`
    INSERT INTO actor_aliases (
      alias, actor_id, alias_kind, created_at
    ) VALUES (?, ?, ?, ?)
  `);
  const actorById = database.prepare(`
    SELECT id, slug, actor_type, status
    FROM actor_identities
    WHERE id = ?
  `);
  const actorBySlug = database.prepare(`
    SELECT id
    FROM actor_identities
    WHERE slug = ? COLLATE NOCASE
  `);
  const aliasByName = database.prepare(`
    SELECT actor_id, alias_kind
    FROM actor_aliases
    WHERE alias = ? COLLATE NOCASE
  `);
  for (const seed of ACTOR_SEEDS) {
    const existingActor = actorById.get(seed.id) as unknown as Readonly<{
      id?: unknown;
      slug?: unknown;
      actor_type?: unknown;
      status?: unknown;
    }> | undefined;
    const slugOwner = actorBySlug.get(seed.slug) as unknown as Readonly<{
      id?: unknown;
    }> | undefined;
    if (existingActor) {
      if (
        existingActor.id !== seed.id ||
        existingActor.slug !== seed.slug ||
        existingActor.actor_type !== seed.actorType ||
        existingActor.status !== seed.status ||
        slugOwner?.id !== seed.id
      ) {
        throw new Error(`Council 保留 Actor ${seed.id} 已被不兼容数据占用。`);
      }
    } else {
      if (slugOwner) {
        throw new Error(`Council 保留 Actor slug ${seed.slug} 已被占用。`);
      }
      insertActor.run(
        seed.id,
        seed.slug,
        seed.displayName,
        seed.shortName,
        seed.role,
        seed.actorType,
        seed.status,
        now,
        now,
      );
    }
    for (const alias of seed.aliases) {
      const existingAlias = aliasByName.get(alias.alias) as unknown as Readonly<{
        actor_id?: unknown;
        alias_kind?: unknown;
      }> | undefined;
      if (existingAlias) {
        if (
          existingAlias.actor_id !== seed.id ||
          existingAlias.alias_kind !== alias.kind
        ) {
          throw new Error(`Council 保留 Actor alias ${alias.alias} 已被占用。`);
        }
      } else {
        insertAlias.run(alias.alias, seed.id, alias.kind, now);
      }
    }
  }
  assertReservedActorMappings(database);
}

function snapshotJsonForActor(database: DatabaseSync, actorId: string): string {
  const row = database.prepare(`
    SELECT id, slug, display_name, short_name, role
    FROM actor_identities
    WHERE id = ?
  `).get(actorId) as unknown as Readonly<{
    id?: unknown;
    slug?: unknown;
    display_name?: unknown;
    short_name?: unknown;
    role?: unknown;
  }> | undefined;
  if (
    typeof row?.id !== "string" ||
    typeof row.slug !== "string" ||
    typeof row.display_name !== "string" ||
    typeof row.short_name !== "string" ||
    typeof row.role !== "string"
  ) {
    throw new Error(`Council actor ${actorId} 缺少可冻结身份。`);
  }
  return serializeActorSnapshot({
    schemaVersion: ACTOR_SNAPSHOT_SCHEMA_VERSION,
    actorId: row.id,
    slug: row.slug,
    displayName: row.display_name,
    shortName: row.short_name,
    role: row.role,
  });
}

function legacySessionStableId(topicId: string, legacyAgent: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([topicId, legacyAgent]))
    .digest("hex")
    .slice(0, 32);
  return `session_legacy_${digest}`;
}

function rebuildContentTablesForActors(database: DatabaseSync): void {
  database.exec(FINAL_CONTENT_SCHEMA_SQL);
  const topicRows = database.prepare("SELECT * FROM topics ORDER BY rowid").all() as unknown as Array<
    Readonly<Record<string, unknown>>
  >;
  const insertTopic = database.prepare(`
    INSERT INTO topics_v2 (
      id, title, question, constraints_json, project_path, status,
      created_by_actor_id, created_by_snapshot_json, created_by_legacy,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of topicRows) {
    const legacy = String(row.created_by);
    const actorId = legacyActorId(legacy);
    insertTopic.run(
      migrationString(row, "id"),
      migrationString(row, "title"),
      migrationString(row, "question"),
      migrationString(row, "constraints_json"),
      migrationNullableString(row, "project_path"),
      migrationString(row, "status"),
      actorId,
      snapshotJsonForActor(database, actorId),
      legacy,
      migrationString(row, "created_at"),
      migrationString(row, "updated_at"),
    );
  }

  const messageRows = database
    .prepare("SELECT * FROM messages ORDER BY rowid")
    .all() as unknown as Array<Readonly<Record<string, unknown>>>;
  const insertMessage = database.prepare(`
    INSERT INTO messages_v2 (
      id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
      kind, content, parent_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  for (const row of messageRows) {
    const legacy = String(row.author);
    const actorId = legacyActorId(legacy);
    insertMessage.run(
      migrationString(row, "id"),
      migrationString(row, "topic_id"),
      actorId,
      snapshotJsonForActor(database, actorId),
      legacy,
      migrationString(row, "kind"),
      migrationString(row, "content"),
      migrationString(row, "created_at"),
    );
  }
  const updateParent = database.prepare(`
    UPDATE messages_v2
    SET parent_message_id = ?
    WHERE id = ?
  `);
  for (const row of messageRows) {
    if (typeof row.parent_message_id === "string" && row.parent_message_id) {
      updateParent.run(row.parent_message_id, migrationString(row, "id"));
    }
  }

  const decisionRows = database
    .prepare("SELECT * FROM decisions ORDER BY rowid")
    .all() as unknown as Array<Readonly<Record<string, unknown>>>;
  const insertDecision = database.prepare(`
    INSERT INTO decisions_v2 (
      id, topic_id, title, decision, rationale, alternatives_json, status,
      created_by_actor_id, created_by_snapshot_json, created_by_legacy,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of decisionRows) {
    const legacy = String(row.created_by);
    const actorId = legacyActorId(legacy);
    insertDecision.run(
      migrationString(row, "id"),
      migrationString(row, "topic_id"),
      migrationString(row, "title"),
      migrationString(row, "decision"),
      migrationString(row, "rationale"),
      migrationString(row, "alternatives_json"),
      migrationString(row, "status"),
      actorId,
      snapshotJsonForActor(database, actorId),
      legacy,
      migrationString(row, "created_at"),
      migrationString(row, "updated_at"),
    );
  }

  const sessionRows = database
    .prepare("SELECT * FROM agent_sessions ORDER BY rowid")
    .all() as unknown as Array<Readonly<Record<string, unknown>>>;
  const sessionCandidates = sessionRows.map((row) => {
    const topicId = migrationString(row, "topic_id");
    const legacyAgent = migrationString(row, "agent");
    return {
      row,
      topicId,
      legacyAgent,
      actorId: legacyActorId(legacyAgent),
      updatedAt: migrationString(row, "updated_at"),
      id: legacySessionStableId(topicId, legacyAgent),
    };
  });
  const currentSessionByActor = new Map<string, typeof sessionCandidates[number]>();
  for (const candidate of sessionCandidates) {
    const key = JSON.stringify([candidate.topicId, candidate.actorId]);
    const current = currentSessionByActor.get(key);
    if (
      !current ||
      candidate.updatedAt > current.updatedAt ||
      (
        candidate.updatedAt === current.updatedAt &&
        candidate.legacyAgent.localeCompare(current.legacyAgent, "en-US") > 0
      )
    ) {
      currentSessionByActor.set(key, candidate);
    }
  }
  const insertSession = database.prepare(`
    INSERT INTO agent_sessions_v2 (
      id, topic_id, actor_id, session_id, legacy_agent, is_current, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const candidate of sessionCandidates) {
    const key = JSON.stringify([candidate.topicId, candidate.actorId]);
    insertSession.run(
      candidate.id,
      candidate.topicId,
      candidate.actorId,
      migrationString(candidate.row, "session_id"),
      candidate.legacyAgent,
      currentSessionByActor.get(key)?.id === candidate.id ? 1 : 0,
      candidate.updatedAt,
    );
  }
}

function rebuildOrchestrationTablesForActors(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE orchestration_runs_v2 (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (
        status IN ('idle', 'running', 'waiting_agent', 'waiting_user', 'completed', 'failed', 'cancelled')
      ),
      snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version IN (1, 2)),
      snapshot_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO orchestration_runs_v2
      SELECT id, topic_id, status, snapshot_schema_version, snapshot_json,
             version, created_at, updated_at
      FROM orchestration_runs;

    CREATE TABLE orchestration_approvals_v2 (
      run_id TEXT NOT NULL REFERENCES orchestration_runs_v2(id) ON DELETE CASCADE,
      approval_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version > 0),
      approved_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
      approved_by_legacy TEXT,
      applied_run_version INTEGER NOT NULL CHECK (applied_run_version > expected_version),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, approval_id)
    );
  `);
  const approvalRows = database
    .prepare("SELECT * FROM orchestration_approvals ORDER BY rowid")
    .all() as unknown as Array<Readonly<Record<string, unknown>>>;
  const insertApproval = database.prepare(`
    INSERT INTO orchestration_approvals_v2 (
      run_id, approval_id, gate_id, expected_version,
      approved_by_actor_id, approved_by_legacy,
      applied_run_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of approvalRows) {
    const legacy = String(row.approved_by);
    insertApproval.run(
      migrationString(row, "run_id"),
      migrationString(row, "approval_id"),
      migrationString(row, "gate_id"),
      migrationInteger(row, "expected_version"),
      legacyActorId(legacy),
      legacy,
      migrationInteger(row, "applied_run_version"),
      migrationString(row, "created_at"),
    );
  }
  database.exec(`
    CREATE TABLE orchestration_run_leases_v2 (
      run_id TEXT PRIMARY KEY REFERENCES orchestration_runs_v2(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
      updated_at TEXT NOT NULL
    );
    INSERT INTO orchestration_run_leases_v2
      SELECT run_id, owner_id, lease_token, epoch, expires_at_ms, updated_at
      FROM orchestration_run_leases;

    DROP TABLE orchestration_approvals;
    DROP TABLE orchestration_run_leases;
    DROP TABLE orchestration_runs;
    DROP TABLE agent_sessions;
    DROP TABLE decisions;
    DROP TABLE messages;
    DROP TABLE topics;
    ALTER TABLE topics_v2 RENAME TO topics;
    ALTER TABLE messages_v2 RENAME TO messages;
    ALTER TABLE decisions_v2 RENAME TO decisions;
    ALTER TABLE agent_sessions_v2 RENAME TO agent_sessions;
    ALTER TABLE orchestration_runs_v2 RENAME TO orchestration_runs;
    ALTER TABLE orchestration_approvals_v2 RENAME TO orchestration_approvals;
    ALTER TABLE orchestration_run_leases_v2 RENAME TO orchestration_run_leases;
  `);
  database.exec(FINAL_CONTENT_REVISION_SQL);
}

function migrateVersionTwo(database: DatabaseSync): void {
  database.exec(ACTOR_SCHEMA_SQL);
  const now = new Date().toISOString();
  seedActors(database, now);
  seedReferencedLegacyDynamicActors(database, now);
  rebuildContentTablesForActors(database);
  rebuildOrchestrationTablesForActors(database);
  database.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
  database.prepare(`
    UPDATE council_meta
    SET value = ?
    WHERE key = 'orchestration_schema_version'
  `).run(2);
  database.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
  `).run(2, "dynamic-actor-identities", new Date().toISOString());
  database.exec("PRAGMA user_version = 2;");
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
      if (initialVersion === 1) {
        assertLegacyV1Schema(database);
      } else if (initialVersion === 2) {
        assertLegacyV2Schema(database);
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
      const sourceSchema = readCouncilSchemaObjects(database);
      const backedUpDataVersion = integerPragma(database, "data_version");
      if (dataVersionBeforeSnapshot !== backedUpDataVersion) {
        if (attempt === options.maxAttempts) {
          throw new Error("Council SQLite 在迁移快照采集期间持续变化，已安全停止。");
        }
        continue;
      }
      if (sourceSchema.length > 0) {
        try {
          backupPath = await createVerifiedSchemaBackup(
            database,
            databasePath,
            initialVersion,
            sourceSchema,
            counts,
            initialUserVersion,
          );
          backupVerified = true;
        } catch (error) {
          const changed = integerPragma(database, "data_version") !== backedUpDataVersion;
          if (backupPath) {
            rmSync(backupPath, { force: true });
          }
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
      let migratingVersion = versionAfterLock;
      if (migratingVersion === 0) {
        migrateVersionOne(database);
        migratingVersion = 1;
      }
      if (migratingVersion === 1) {
        if (initialVersion === 1) {
          assertLegacyV1Schema(database);
        }
        migrateVersionTwo(database);
        migratingVersion = 2;
      }
      if (migratingVersion === 2) {
        if (initialVersion === 2) {
          assertLegacyV2Schema(database);
        }
        migrateVersionThree(database);
        migratingVersion = 3;
      }
      if (migratingVersion === 3) {
        if (initialVersion === 3) {
          assertVersionThreeMigrationSource(database);
        }
        migrateVersionFour(database);
        migratingVersion = 4;
      }
      if (migratingVersion === 4) {
        if (initialVersion === 4) {
          assertVersionFourMigrationSource(database);
        }
        migrateVersionFive(database);
        migratingVersion = 5;
      }
      if (migratingVersion === 5) {
        if (initialVersion === 5) {
          assertVersionFiveMigrationSource(database);
        }
        migrateVersionSix(database);
        migratingVersion = 6;
      }
      if (migratingVersion !== COUNCIL_SCHEMA_VERSION) {
        throw new Error("Council 数据库迁移版本链不连续。");
      }
      assertCountsPreserved(database, counts);
      assertCouncilSchema(database);
      if (options.faultPoint === "before-commit") {
        throw new Error("Council schema 迁移故障注入。");
      }
      database.exec("COMMIT;");
      transactionOpen = false;
      assertCouncilSchema(database);
      protectSqliteFile(databasePath);
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
