/**
 * @input  依赖：已构建的 Node schema migrator、目标 SQLite 路径与 fresh/v2/v3 模式
 * @output 导出：由 Node canonical 迁移器真实创建的 v5 测试数据库
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
    mode !== "v3-migrated"
  ) ||
  !databaseArgument
) {
  throw new Error(
    "用法：create-rust-test-database.mjs <fresh|v2-migrated|v3-migrated> <database-path>",
  );
}
const databasePath = resolve(databaseArgument);

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
} else {
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      DROP TABLE orchestration_approvals;
      DROP TABLE orchestration_run_leases;
      DROP TABLE orchestration_runs;
    `);
    database.exec(LEGACY_ORCHESTRATION_SCHEMA_V2_SQL);
    database.exec(`
      UPDATE council_meta
      SET value = 2
      WHERE key = 'orchestration_schema_version';
      ALTER TABLE provider_profiles DROP COLUMN config_revision;
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
}
