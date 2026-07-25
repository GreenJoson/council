/**
 * @input  依赖：无
 * @output 导出：Council v1-v3 required objects、冻结 DDL 与 canonical schema 常量
 * @pos    SQLite schema 的纯定义层；不得包含备份、数据迁移或事务编排
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const REQUIRED_TABLES = [
  "topics",
  "messages",
  "decisions",
  "agent_sessions",
  "council_meta",
  "council_identity",
  "actor_identities",
  "actor_aliases",
  "brand_assets",
  "provider_profiles",
  "agent_definitions",
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
  "schema_migrations",
] as const;

export const REQUIRED_INDEXES = [
  "idx_topics_project_updated",
  "idx_messages_topic_created",
  "idx_decisions_topic_created",
  "idx_actor_identities_status_slug",
  "idx_actor_aliases_actor",
  "idx_provider_profiles_status_slug",
  "idx_agent_definitions_provider",
  "idx_agent_definitions_enabled_alias",
  "idx_agent_sessions_current",
  "idx_orchestration_runs_topic_updated",
  "idx_orchestration_runs_status_updated",
  "idx_orchestration_runs_one_active_topic",
  "idx_orchestration_run_leases_expiry",
] as const;

export const LEGACY_V1_TABLES = [
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

export const LEGACY_V1_INDEXES = [
  "idx_topics_project_updated",
  "idx_messages_topic_created",
  "idx_decisions_topic_created",
  "idx_orchestration_runs_topic_updated",
  "idx_orchestration_runs_status_updated",
  "idx_orchestration_runs_one_active_topic",
  "idx_orchestration_run_leases_expiry",
] as const;

export const LEGACY_V2_TABLES = [
  "topics",
  "messages",
  "decisions",
  "agent_sessions",
  "council_meta",
  "council_identity",
  "actor_identities",
  "actor_aliases",
  "agent_settings",
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
  "schema_migrations",
] as const;

export const LEGACY_V2_INDEXES = [
  "idx_topics_project_updated",
  "idx_messages_topic_created",
  "idx_decisions_topic_created",
  "idx_actor_identities_status_slug",
  "idx_actor_aliases_actor",
  "idx_agent_sessions_current",
  "idx_orchestration_runs_topic_updated",
  "idx_orchestration_runs_status_updated",
  "idx_orchestration_runs_one_active_topic",
  "idx_orchestration_run_leases_expiry",
] as const;

export const FROZEN_LEGACY_V1_SCHEMA_SHA256 =
  "58ca9009ad42908be3d17391134f30650681d06d39b471a0921c08f57f409228";

export const REQUIRED_REVISION_TRIGGERS = [
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

export const COUNTED_LEGACY_TABLES = [
  "topics",
  "messages",
  "decisions",
  "agent_sessions",
  "agent_settings",
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
] as const;

export const LEGACY_BASE_SCHEMA_SQL = `
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

export const LEGACY_V1_ORCHESTRATION_SCHEMA_SQL = `
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('content_revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('orchestration_revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('orchestration_schema_version', 1);

  CREATE TABLE IF NOT EXISTS orchestration_runs (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
      status IN ('idle', 'running', 'waiting_agent', 'waiting_user', 'completed', 'failed', 'cancelled')
    ),
    snapshot_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_schema_version = 1),
    snapshot_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orchestration_approvals (
    run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
    approval_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version > 0),
    approved_by TEXT NOT NULL CHECK (
      approved_by IN ('human', 'claude', 'codex', 'chair', 'other')
    ),
    applied_run_version INTEGER NOT NULL CHECK (applied_run_version > expected_version),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, approval_id)
  );

  CREATE TABLE IF NOT EXISTS orchestration_run_leases (
    run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orchestration_runs_topic_updated
    ON orchestration_runs(topic_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_updated
    ON orchestration_runs(status, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_runs_one_active_topic
    ON orchestration_runs(topic_id)
    WHERE status IN ('idle', 'running', 'waiting_agent', 'waiting_user');
  CREATE INDEX IF NOT EXISTS idx_orchestration_run_leases_expiry
    ON orchestration_run_leases(expires_at_ms);

  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_insert;
  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_update;
  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_delete;

  CREATE TRIGGER trg_orchestration_runs_revision_insert
    AFTER INSERT ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_orchestration_runs_revision_update
    AFTER UPDATE ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_orchestration_runs_revision_delete
    AFTER DELETE ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
`;

export const ACTOR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS actor_identities (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    role TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'system', 'agent', 'legacy')),
    status TEXT NOT NULL CHECK (status IN ('active', 'needs_review', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_aliases (
    alias TEXT PRIMARY KEY COLLATE NOCASE,
    actor_id TEXT NOT NULL REFERENCES actor_identities(id) ON DELETE CASCADE,
    alias_kind TEXT NOT NULL CHECK (alias_kind IN ('canonical', 'legacy', 'adapter')),
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_actor_identities_status_slug
    ON actor_identities(status, slug);
  CREATE INDEX IF NOT EXISTS idx_actor_aliases_actor
    ON actor_aliases(actor_id);
`;

export const MODEL_ROUTER_SCHEMA_SQL = `
  CREATE TABLE brand_assets (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    glyph_id TEXT NOT NULL,
    color_token TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('project-curated', 'user-custom')),
    source_label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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
    updated_at TEXT NOT NULL
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
    CHECK (
      (deleted_at IS NULL) OR (enabled = 0)
    )
  );

  CREATE INDEX idx_provider_profiles_status_slug
    ON provider_profiles(status, slug);
  CREATE INDEX idx_agent_definitions_provider
    ON agent_definitions(provider_id, deleted_at);
  CREATE INDEX idx_agent_definitions_enabled_alias
    ON agent_definitions(enabled, mention_alias);
`;

export const FINAL_CONTENT_SCHEMA_SQL = `
  CREATE TABLE topics_v2 (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    project_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'closed')),
    created_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    created_by_snapshot_json TEXT NOT NULL,
    created_by_legacy TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE messages_v2 (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE CASCADE,
    author_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    author_snapshot_json TEXT NOT NULL,
    author_legacy TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('brief', 'proposal', 'critique', 'rebuttal', 'synthesis', 'note')),
    content TEXT NOT NULL,
    parent_message_id TEXT REFERENCES messages_v2(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE decisions_v2 (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    alternatives_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
    created_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    created_by_snapshot_json TEXT NOT NULL,
    created_by_legacy TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE agent_sessions_v2 (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    session_id TEXT NOT NULL,
    legacy_agent TEXT,
    is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
    updated_at TEXT NOT NULL
  );
`;

export const FINAL_CONTENT_REVISION_SQL = `
  CREATE INDEX idx_topics_project_updated
    ON topics(project_path, updated_at DESC);
  CREATE INDEX idx_messages_topic_created
    ON messages(topic_id, created_at ASC);
  CREATE INDEX idx_decisions_topic_created
    ON decisions(topic_id, created_at ASC);
  CREATE UNIQUE INDEX idx_agent_sessions_current
    ON agent_sessions(topic_id, actor_id)
    WHERE is_current = 1;

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
`;

export const MIGRATION_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  );
`;

export const COUNCIL_IDENTITY_SQL = `
  CREATE TABLE IF NOT EXISTS council_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    instance_id TEXT NOT NULL UNIQUE
  );
`;

export const FROZEN_LEGACY_V1_SCHEMA_SQL = [
  LEGACY_BASE_SCHEMA_SQL,
  LEGACY_V1_ORCHESTRATION_SCHEMA_SQL,
  MIGRATION_LEDGER_SQL,
  COUNCIL_IDENTITY_SQL,
].join("\n");
