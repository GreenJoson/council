/**
 * @input  依赖：已构建的 Node schema migrator、目标 SQLite 路径与 fresh/v2/v3/v5 模式
 * @output 导出：由 Node canonical 迁移器真实创建的 v14 测试数据库
 * @pos    Rust 跨语言兼容测试的唯一数据库生成入口；禁止手抄 Node DDL
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEGACY_ORCHESTRATION_SCHEMA_V2_SQL } from "council-orchestrator";
import { migrateCouncilSchema } from "../dist/src/schema-migrator.js";

const [mode, databaseArgument] = process.argv.slice(2);
if (
  (
    mode !== "fresh" &&
    mode !== "v2-migrated" &&
    mode !== "v3-migrated" &&
    mode !== "v5-migrated"
  ) ||
  !databaseArgument
) {
  throw new Error(
    "用法：create-rust-test-database.mjs <fresh|v2-migrated|v3-migrated|v5-migrated> <database-path>",
  );
}
const databasePath = resolve(databaseArgument);

function removeVersionTenProviderBinding(database) {
  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec(`
      CREATE TEMP TABLE provider_profiles_pre_v10_backup AS
        SELECT * FROM provider_profiles;
      DROP TABLE provider_profiles;
      CREATE TABLE provider_profiles (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (
          protocol IN ('claude-cli', 'codex-cli', 'openai-compatible')
        ),
        base_url TEXT,
        requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1)),
        credential_ref TEXT UNIQUE,
        brand_asset_id TEXT NOT NULL REFERENCES brand_assets(id),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0)
      );
      CREATE INDEX idx_provider_profiles_status_slug
        ON provider_profiles(status, slug);
      INSERT INTO provider_profiles (
        id, slug, display_name, protocol, base_url, requires_api_key,
        credential_ref, brand_asset_id, status, created_at, updated_at, config_revision
      )
      SELECT
        id, slug, display_name, protocol, base_url, requires_api_key,
        credential_ref, brand_asset_id, status, created_at, updated_at, config_revision
      FROM provider_profiles_pre_v10_backup;
      DROP TABLE provider_profiles_pre_v10_backup;
    `);
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

if (mode === "fresh") {
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
} else if (mode === "v2-migrated") {
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const legacyV2Sql = readFileSync(
    resolve(workspaceRoot, "crates/council-core/tests/fixtures/node-schema-v2.sql"),
    "utf8",
  );
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(legacyV2Sql);
    database.exec(`
      INSERT INTO agent_settings (
        id, label, kind, model, base_url, enabled, requires_api_key, updated_at
      ) VALUES (
        'deepseek', 'DeepSeek', 'openai-compatible', 'fixture-model',
        'https://example.com/v1', 1, 1, '2000-01-01T00:00:00.000Z'
      );
    `);
  } finally {
    database.close();
  }
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
} else if (mode === "v3-migrated") {
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS trg_work_items_delegation_acceptance;
      DROP TABLE IF EXISTS runtime_audit_events;
      DROP TABLE work_item_delegations;
      DROP TABLE work_items;
      DROP TRIGGER trg_decisions_cycle_close_update;
      DROP TRIGGER trg_decisions_cycle_close_insert;
      DROP TABLE blocking_questions;
      DROP TABLE discussion_cycles;
      DROP TRIGGER trg_decisions_runtime_close_update;
      DROP TRIGGER trg_decisions_runtime_close_insert;
      DROP TRIGGER trg_runtime_bindings_revision_delete;
      DROP TRIGGER trg_runtime_bindings_revision_update;
      DROP TRIGGER trg_runtime_bindings_revision_insert;
      DROP TABLE runtime_binding_requests;
      DROP TABLE runtime_binding_leases;
      DROP TABLE runtime_bindings;
      DROP TABLE orchestration_approvals;
      DROP TABLE orchestration_run_leases;
      DROP TABLE orchestration_runs;
    `);
    database.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
    removeVersionTenProviderBinding(database);
    database.exec(`
      UPDATE council_meta
      SET value = 2
      WHERE key = 'orchestration_schema_version';
      ALTER TABLE provider_profiles DROP COLUMN config_revision;
      ALTER TABLE agent_definitions DROP COLUMN permission_profile;
      ALTER TABLE agent_definitions DROP COLUMN execution_role;
      ALTER TABLE agent_definitions DROP COLUMN config_revision;
      DELETE FROM schema_migrations WHERE version >= 4;
      PRAGMA user_version = 3;
    `);
    const now = "2000-01-01T00:00:00.000Z";
    database.prepare(`
      INSERT INTO actor_identities (
        id, slug, display_name, short_name, role,
        actor_type, status, created_at, updated_at
      ) VALUES (
        'kimi', 'kimi', 'Kimi', 'KI', '模型顾问',
        'agent', 'active', ?, ?
      )
    `).run(now, now);
    database.prepare(`
      INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
      VALUES ('kimi', 'kimi', 'canonical', ?)
    `).run(now);
    database.prepare(`
      INSERT INTO provider_profiles (
        id, slug, display_name, protocol, base_url, requires_api_key,
        credential_ref, brand_asset_id, status, created_at, updated_at
      ) VALUES (
        'provider-kimi-v3', 'kimi', 'Kimi', 'openai-compatible',
        'https://example.com/v1', 1, 'credential-kimi-v3',
        'brand-kimi', 'active', ?, ?
      )
    `).run(now, now);
    database.prepare(`
      INSERT INTO agent_definitions (
        id, actor_id, provider_id, slug, display_name, model,
        mention_alias, enabled, deleted_at, created_at, updated_at
      ) VALUES (
        'agent-kimi-v3', 'kimi', 'provider-kimi-v3', 'kimi',
        'Kimi', 'fixture-model', 'kimi', 1, NULL, ?, ?
      )
    `).run(now, now);
  } finally {
    database.close();
  }
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
} else {
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS trg_work_items_delegation_acceptance;
      DROP TABLE IF EXISTS runtime_audit_events;
      DROP TABLE work_item_delegations;
      DROP TABLE work_items;
      DROP TRIGGER trg_decisions_cycle_close_update;
      DROP TRIGGER trg_decisions_cycle_close_insert;
      DROP TABLE blocking_questions;
      DROP TABLE discussion_cycles;
      DROP TRIGGER trg_decisions_runtime_close_update;
      DROP TRIGGER trg_decisions_runtime_close_insert;
      DROP TABLE runtime_binding_requests;
      DROP TABLE runtime_binding_leases;
      DROP TABLE runtime_bindings;
      DELETE FROM schema_migrations WHERE version >= 6;
      PRAGMA user_version = 5;
    `);
    database.exec(`
      ALTER TABLE agent_definitions DROP COLUMN permission_profile;
      ALTER TABLE agent_definitions DROP COLUMN execution_role;
    `);
    removeVersionTenProviderBinding(database);
  } finally {
    database.close();
  }
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
}
