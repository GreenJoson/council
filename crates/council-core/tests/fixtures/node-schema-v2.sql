PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE council_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
INSERT INTO council_meta VALUES('revision',0);
INSERT INTO council_meta VALUES('content_revision',0);
INSERT INTO council_meta VALUES('orchestration_revision',0);
INSERT INTO council_meta VALUES('orchestration_schema_version',2);
CREATE TABLE agent_settings (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('claude-cli', 'codex-cli', 'openai-compatible')),
    model TEXT NOT NULL,
    base_url TEXT,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1)),
    updated_at TEXT NOT NULL
  );
CREATE TABLE actor_identities (
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
INSERT INTO actor_identities VALUES('human','human','User','U','决策者','human','active','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
INSERT INTO actor_identities VALUES('council','council','Council','CO','综合协调','system','active','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
INSERT INTO actor_identities VALUES('claude','claude','Claude','CL','方案顾问','agent','active','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
INSERT INTO actor_identities VALUES('codex','codex','Codex','CX','代码审查','agent','active','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
INSERT INTO actor_identities VALUES('deepseek','deepseek','DeepSeek','DS','模型顾问','agent','active','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
INSERT INTO actor_identities VALUES('kimi','kimi','Kimi','KI','模型顾问','agent','active','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
INSERT INTO actor_identities VALUES('legacy-unknown','legacy-unknown','Legacy unknown','?','待人工识别的历史参与者','legacy','needs_review','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
CREATE TABLE actor_aliases (
    alias TEXT PRIMARY KEY COLLATE NOCASE,
    actor_id TEXT NOT NULL REFERENCES actor_identities(id) ON DELETE CASCADE,
    alias_kind TEXT NOT NULL CHECK (alias_kind IN ('canonical', 'legacy', 'adapter')),
    created_at TEXT NOT NULL
  );
INSERT INTO actor_aliases VALUES('human','human','canonical','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('user','human','legacy','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('council','council','canonical','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('chair','council','legacy','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('claude','claude','canonical','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('claude-code','claude','adapter','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('codex','codex','canonical','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('codex-cli','codex','adapter','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('deepseek','deepseek','canonical','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('kimi','kimi','canonical','2000-01-01T00:00:00.000Z');
INSERT INTO actor_aliases VALUES('other','legacy-unknown','legacy','2000-01-01T00:00:00.000Z');
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  );
INSERT INTO schema_migrations VALUES(1,'initial-unified-schema','2000-01-01T00:00:00.000Z');
INSERT INTO schema_migrations VALUES(2,'dynamic-actor-identities','2000-01-01T00:00:00.000Z');
CREATE TABLE council_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    instance_id TEXT NOT NULL UNIQUE
  );
INSERT INTO council_identity VALUES(1,'00000000-0000-4000-8000-000000000001');
CREATE TABLE IF NOT EXISTS "topics" (
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
CREATE TABLE IF NOT EXISTS "messages" (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES "topics"(id) ON DELETE CASCADE,
    author_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    author_snapshot_json TEXT NOT NULL,
    author_legacy TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('brief', 'proposal', 'critique', 'rebuttal', 'synthesis', 'note')),
    content TEXT NOT NULL,
    parent_message_id TEXT REFERENCES "messages"(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
CREATE TABLE IF NOT EXISTS "decisions" (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES "topics"(id) ON DELETE CASCADE,
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
CREATE TABLE IF NOT EXISTS "agent_sessions" (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES "topics"(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    session_id TEXT NOT NULL,
    legacy_agent TEXT,
    is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
    updated_at TEXT NOT NULL
  );
CREATE TABLE IF NOT EXISTS "orchestration_runs" (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES "topics"(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (
        status IN ('idle', 'running', 'waiting_agent', 'waiting_user', 'completed', 'failed', 'cancelled')
      ),
      snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version IN (1, 2)),
      snapshot_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE IF NOT EXISTS "orchestration_approvals" (
      run_id TEXT NOT NULL REFERENCES "orchestration_runs"(id) ON DELETE CASCADE,
      approval_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version > 0),
      approved_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
      approved_by_legacy TEXT,
      applied_run_version INTEGER NOT NULL CHECK (applied_run_version > expected_version),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, approval_id)
    );
CREATE TABLE IF NOT EXISTS "orchestration_run_leases" (
      run_id TEXT PRIMARY KEY REFERENCES "orchestration_runs"(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
      updated_at TEXT NOT NULL
    );
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
CREATE INDEX idx_actor_identities_status_slug
    ON actor_identities(status, slug);
CREATE INDEX idx_actor_aliases_actor
    ON actor_aliases(actor_id);
CREATE UNIQUE INDEX idx_agent_sessions_current
    ON agent_sessions(topic_id, actor_id)
    WHERE is_current = 1;
CREATE INDEX idx_topics_project_updated
    ON topics(project_path, updated_at DESC);
CREATE INDEX idx_messages_topic_created
    ON messages(topic_id, created_at ASC);
CREATE INDEX idx_decisions_topic_created
    ON decisions(topic_id, created_at ASC);
CREATE INDEX idx_orchestration_runs_topic_updated
    ON orchestration_runs(topic_id, updated_at DESC);
CREATE INDEX idx_orchestration_runs_status_updated
    ON orchestration_runs(status, updated_at DESC);
CREATE UNIQUE INDEX idx_orchestration_runs_one_active_topic
    ON orchestration_runs(topic_id)
    WHERE status IN ('idle', 'running', 'waiting_agent', 'waiting_user');
CREATE INDEX idx_orchestration_run_leases_expiry
    ON orchestration_run_leases(expires_at_ms);
PRAGMA user_version = 2;
COMMIT;
