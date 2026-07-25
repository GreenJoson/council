/**
 * @input  依赖：canonical v3 Provider/Agent 与编排表、v3 编排 schema
 * @output 导出：migrateVersionFour 原子升级 Run snapshot 容器与单调配置版本
 * @pos    schema-migrator 调用的 v3→v4 专用模块；只改结构，不猜补历史 Run 绑定
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import {
  ORCHESTRATION_SCHEMA_SQL,
  ORCHESTRATION_SCHEMA_VERSION,
} from "council-orchestrator";

interface ScalarRow {
  value: unknown;
}

export function assertVersionThreeMigrationSource(database: DatabaseSync): void {
  const providerColumns = database.prepare("PRAGMA table_info(provider_profiles)")
    .all() as unknown as Array<{ name?: unknown }>;
  const agentColumns = database.prepare("PRAGMA table_info(agent_definitions)")
    .all() as unknown as Array<{ name?: unknown }>;
  if (
    providerColumns.some((column) => column.name === "config_revision") ||
    agentColumns.some((column) => column.name === "config_revision")
  ) {
    throw new Error("Council v3 模型路由表包含提前出现的配置版本字段。");
  }
  const runSql = database.prepare(`
    SELECT sql AS value
    FROM sqlite_master
    WHERE type = 'table' AND name = 'orchestration_runs'
  `).get() as unknown as ScalarRow | undefined;
  const normalizedRunSql = typeof runSql?.value === "string"
    ? runSql.value.replace(/\s+/gu, " ")
    : "";
  if (
    !normalizedRunSql.includes("snapshot_schema_version IN (1, 2)") ||
    normalizedRunSql.includes("snapshot_schema_version IN (1, 2, 3)")
  ) {
    throw new Error("Council v3 运行快照容器定义不兼容。");
  }
  const orchestrationVersion = database.prepare(`
    SELECT value
    FROM council_meta
    WHERE key = 'orchestration_schema_version'
  `).get() as unknown as ScalarRow | undefined;
  if (orchestrationVersion?.value !== 2) {
    throw new Error("Council v3 编排 schema 版本无效。");
  }
}

function rebuildOrchestrationTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE orchestration_runs_v3 (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (
        status IN ('idle', 'running', 'waiting_agent', 'waiting_user', 'completed', 'failed', 'cancelled')
      ),
      snapshot_schema_version INTEGER NOT NULL CHECK (
        snapshot_schema_version IN (1, 2, 3)
      ),
      snapshot_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO orchestration_runs_v3
      SELECT id, topic_id, status, snapshot_schema_version, snapshot_json,
             version, created_at, updated_at
      FROM orchestration_runs;

    CREATE TABLE orchestration_approvals_v3 (
      run_id TEXT NOT NULL REFERENCES orchestration_runs_v3(id) ON DELETE CASCADE,
      approval_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version > 0),
      approved_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
      approved_by_legacy TEXT,
      applied_run_version INTEGER NOT NULL CHECK (applied_run_version > expected_version),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, approval_id)
    );
    INSERT INTO orchestration_approvals_v3
      SELECT run_id, approval_id, gate_id, expected_version,
             approved_by_actor_id, approved_by_legacy,
             applied_run_version, created_at
      FROM orchestration_approvals;

    CREATE TABLE orchestration_run_leases_v3 (
      run_id TEXT PRIMARY KEY REFERENCES orchestration_runs_v3(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
      updated_at TEXT NOT NULL
    );
    INSERT INTO orchestration_run_leases_v3
      SELECT run_id, owner_id, lease_token, epoch, expires_at_ms, updated_at
      FROM orchestration_run_leases;

    DROP TABLE orchestration_approvals;
    DROP TABLE orchestration_run_leases;
    DROP TABLE orchestration_runs;
    ALTER TABLE orchestration_runs_v3 RENAME TO orchestration_runs;
    ALTER TABLE orchestration_approvals_v3 RENAME TO orchestration_approvals;
    ALTER TABLE orchestration_run_leases_v3 RENAME TO orchestration_run_leases;
  `);
  database.exec(ORCHESTRATION_SCHEMA_SQL);
  database.prepare(`
    UPDATE council_meta
    SET value = ?
    WHERE key = 'orchestration_schema_version'
  `).run(ORCHESTRATION_SCHEMA_VERSION);
}

export function migrateVersionFour(
  database: DatabaseSync,
  recordVersion = true,
): void {
  database.exec(`
    ALTER TABLE provider_profiles
      ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1
      CHECK (config_revision > 0);
    ALTER TABLE agent_definitions
      ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1
      CHECK (config_revision > 0);
  `);
  rebuildOrchestrationTables(database);
  if (recordVersion) {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(4, "frozen-run-bindings", now);
    database.exec("PRAGMA user_version = 4;");
  }
}
