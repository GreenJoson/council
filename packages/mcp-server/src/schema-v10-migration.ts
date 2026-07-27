/**
 * @input  依赖：已通过 v9 指纹校验的 Provider/Agent/RuntimeBinding 表
 * @output 导出：v9→v10 原子迁移，将 Kimi 专用协议和 transport 归一为通用 ACP
 * @pos    ACP DelegatedRuntime 泛化的数据迁移边界；保留 Provider、Agent、session、lease 与请求账本
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";

interface ColumnRow {
  name: unknown;
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as ColumnRow[];
  if (rows.length === 0) {
    throw new Error(`Council v9 数据库缺少表：${table}。`);
  }
  return new Set(
    rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
}

export function assertVersionNineMigrationSource(database: DatabaseSync): void {
  const providerColumns = tableColumns(database, "provider_profiles");
  const bindingColumns = tableColumns(database, "runtime_bindings");
  if (
    !providerColumns.has("protocol")
    || !providerColumns.has("config_revision")
    || !bindingColumns.has("transport_kind")
    || !bindingColumns.has("session_id")
    || !bindingColumns.has("binding_revision")
  ) {
    throw new Error("Council v9 缺少 ACP 泛化迁移所需字段。");
  }
}

export function migrateVersionTen(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionNineMigrationSource(database);

  database.exec(`
    CREATE TEMP TABLE provider_profiles_v10_backup AS
      SELECT * FROM provider_profiles;
    CREATE TEMP TABLE agent_definitions_v10_backup AS
      SELECT * FROM agent_definitions;
    CREATE TEMP TABLE runtime_bindings_v10_backup AS
      SELECT * FROM runtime_bindings;
    CREATE TEMP TABLE runtime_binding_leases_v10_backup AS
      SELECT * FROM runtime_binding_leases;
    CREATE TEMP TABLE runtime_binding_requests_v10_backup AS
      SELECT * FROM runtime_binding_requests;

    DROP TRIGGER trg_decisions_runtime_close_insert;
    DROP TRIGGER trg_decisions_runtime_close_update;
    DROP TABLE runtime_binding_requests;
    DROP TABLE runtime_binding_leases;
    DROP TABLE runtime_bindings;
    DROP TABLE agent_definitions;
    DROP TABLE provider_profiles;

    CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK (
        protocol IN ('claude-cli', 'codex-cli', 'openai-compatible', 'acp')
      ),
      base_url TEXT,
      requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1)),
      credential_ref TEXT UNIQUE,
      brand_asset_id TEXT NOT NULL REFERENCES brand_assets(id),
      runtime_definition_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0),
      CHECK (
        (protocol = 'acp' AND runtime_definition_id IS NOT NULL)
        OR (protocol <> 'acp' AND runtime_definition_id IS NULL)
      )
    );

    CREATE TABLE agent_definitions (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL UNIQUE REFERENCES actor_identities(id),
      provider_id TEXT NOT NULL REFERENCES provider_profiles(id),
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      model TEXT NOT NULL,
      mention_alias TEXT NOT NULL COLLATE NOCASE UNIQUE,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0),
      CHECK (
        (deleted_at IS NULL) OR (enabled = 0)
      )
    );

    CREATE TABLE runtime_bindings (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL REFERENCES actor_identities(id) ON DELETE RESTRICT,
      provider_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
      binding_revision TEXT NOT NULL,
      agent_config_revision INTEGER NOT NULL CHECK (agent_config_revision > 0),
      provider_config_revision INTEGER NOT NULL CHECK (provider_config_revision > 0),
      project_path TEXT,
      transport_kind TEXT NOT NULL CHECK (
        transport_kind IN (
          'claude-resume', 'codex-resume', 'openai-sessionless',
          'openai-tool-loop', 'acp'
        )
      ),
      session_id TEXT,
      cursor_created_at TEXT,
      cursor_message_id TEXT,
      status TEXT NOT NULL CHECK (
        status IN (
          'starting', 'ready', 'thinking', 'streaming', 'idle',
          'interrupted', 'closing', 'closed'
        )
      ),
      state_version INTEGER NOT NULL CHECK (state_version > 0),
      epoch INTEGER NOT NULL CHECK (epoch >= 0),
      process_instance_id TEXT,
      last_activity_at TEXT NOT NULL,
      close_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      CHECK (
        (cursor_created_at IS NULL AND cursor_message_id IS NULL)
        OR (cursor_created_at IS NOT NULL AND cursor_message_id IS NOT NULL)
      ),
      CHECK (
        (status = 'closed' AND closed_at IS NOT NULL)
        OR (status <> 'closed' AND closed_at IS NULL)
      )
    );

    CREATE TABLE runtime_binding_leases (
      binding_id TEXT PRIMARY KEY REFERENCES runtime_bindings(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE runtime_binding_requests (
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
      request_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      consumed_at TEXT NOT NULL,
      PRIMARY KEY (topic_id, agent_id, request_message_id)
    );

    CREATE INDEX idx_provider_profiles_status_slug
      ON provider_profiles(status, slug);
    CREATE INDEX idx_agent_definitions_provider
      ON agent_definitions(provider_id, deleted_at);
    CREATE INDEX idx_agent_definitions_enabled_alias
      ON agent_definitions(enabled, mention_alias);
    CREATE INDEX idx_runtime_bindings_topic_status
      ON runtime_bindings(topic_id, status, updated_at DESC);
    CREATE INDEX idx_runtime_bindings_idle
      ON runtime_bindings(status, last_activity_at);
    CREATE UNIQUE INDEX idx_runtime_bindings_one_open_agent
      ON runtime_bindings(topic_id, agent_id)
      WHERE status <> 'closed';
    CREATE UNIQUE INDEX idx_runtime_bindings_active_session
      ON runtime_bindings(provider_id, agent_id, transport_kind, session_id)
      WHERE session_id IS NOT NULL
        AND status <> 'closed'
        AND transport_kind IN ('claude-resume', 'codex-resume', 'acp');
    CREATE INDEX idx_runtime_binding_leases_expiry
      ON runtime_binding_leases(expires_at_ms);

    INSERT INTO provider_profiles (
      id, slug, display_name, protocol, base_url, requires_api_key,
      credential_ref, brand_asset_id, runtime_definition_id, status,
      created_at, updated_at, config_revision
    )
    SELECT
      id, slug, display_name,
      CASE protocol WHEN 'kimi-acp' THEN 'acp' ELSE protocol END,
      base_url, requires_api_key, credential_ref, brand_asset_id,
      CASE protocol WHEN 'kimi-acp' THEN 'kimi-code' ELSE NULL END,
      status,
      created_at, updated_at, config_revision
    FROM provider_profiles_v10_backup;

    INSERT INTO agent_definitions
      SELECT * FROM agent_definitions_v10_backup;

    INSERT INTO runtime_bindings (
      id, topic_id, agent_id, actor_id, provider_id, binding_revision,
      agent_config_revision, provider_config_revision, project_path,
      transport_kind, session_id, cursor_created_at, cursor_message_id,
      status, state_version, epoch, process_instance_id, last_activity_at,
      close_reason, created_at, updated_at, closed_at
    )
    SELECT
      id, topic_id, agent_id, actor_id, provider_id, binding_revision,
      agent_config_revision, provider_config_revision, project_path,
      CASE transport_kind WHEN 'kimi-acp' THEN 'acp' ELSE transport_kind END,
      session_id, cursor_created_at, cursor_message_id, status, state_version,
      epoch, process_instance_id, last_activity_at, close_reason, created_at,
      updated_at, closed_at
    FROM runtime_bindings_v10_backup;

    INSERT INTO runtime_binding_leases
      SELECT * FROM runtime_binding_leases_v10_backup;
    INSERT INTO runtime_binding_requests
      SELECT * FROM runtime_binding_requests_v10_backup;

    CREATE TRIGGER trg_runtime_bindings_revision_insert
      AFTER INSERT ON runtime_bindings BEGIN
        UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
      END;
    CREATE TRIGGER trg_runtime_bindings_revision_update
      AFTER UPDATE ON runtime_bindings BEGIN
        UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
      END;
    CREATE TRIGGER trg_runtime_bindings_revision_delete
      AFTER DELETE ON runtime_bindings BEGIN
        UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
      END;

    CREATE TRIGGER trg_decisions_runtime_close_insert
      AFTER INSERT ON decisions
      WHEN NEW.status = 'accepted'
      BEGIN
        UPDATE runtime_bindings
        SET status = 'closing',
            state_version = state_version + 1,
            epoch = epoch + 1,
            close_reason = 'decision-accepted',
            updated_at = NEW.updated_at,
            last_activity_at = NEW.updated_at
        WHERE topic_id = NEW.topic_id
          AND status NOT IN ('closing', 'closed');
        DELETE FROM runtime_binding_leases
        WHERE binding_id IN (
          SELECT id FROM runtime_bindings
          WHERE topic_id = NEW.topic_id AND status = 'closing'
        );
      END;

    CREATE TRIGGER trg_decisions_runtime_close_update
      AFTER UPDATE OF status ON decisions
      WHEN OLD.status <> 'accepted' AND NEW.status = 'accepted'
      BEGIN
        UPDATE runtime_bindings
        SET status = 'closing',
            state_version = state_version + 1,
            epoch = epoch + 1,
            close_reason = 'decision-accepted',
            updated_at = NEW.updated_at,
            last_activity_at = NEW.updated_at
        WHERE topic_id = NEW.topic_id
          AND status NOT IN ('closing', 'closed');
        DELETE FROM runtime_binding_leases
        WHERE binding_id IN (
          SELECT id FROM runtime_bindings
          WHERE topic_id = NEW.topic_id AND status = 'closing'
        );
      END;

    DROP TABLE provider_profiles_v10_backup;
    DROP TABLE agent_definitions_v10_backup;
    DROP TABLE runtime_bindings_v10_backup;
    DROP TABLE runtime_binding_leases_v10_backup;
    DROP TABLE runtime_binding_requests_v10_backup;
  `);

  if (recordVersion) {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(10, "generic-acp-runtime", now);
    database.exec("PRAGMA user_version = 10;");
  }
}
