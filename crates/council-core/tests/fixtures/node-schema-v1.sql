PRAGMA foreign_keys = ON;

CREATE TABLE topics (
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
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('human', 'claude', 'codex', 'chair', 'other')),
  kind TEXT NOT NULL CHECK (kind IN ('brief', 'proposal', 'critique', 'rebuttal', 'synthesis', 'note')),
  content TEXT NOT NULL,
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE decisions (
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
CREATE TABLE council_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE council_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL UNIQUE
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
INSERT INTO council_meta (key, value) VALUES ('revision', 0);
INSERT INTO council_meta (key, value) VALUES ('content_revision', 0);
INSERT INTO council_meta (key, value) VALUES ('orchestration_revision', 0);
INSERT INTO council_identity (singleton, instance_id)
VALUES (1, '00000000-0000-4000-8000-000000000001');
INSERT INTO schema_migrations (version, name, applied_at)
VALUES (1, 'initial-unified-schema', '2026-01-01T00:00:00.000Z');
PRAGMA user_version = 1;

CREATE INDEX idx_topics_project_updated ON topics(project_path, updated_at DESC);
CREATE INDEX idx_messages_topic_created ON messages(topic_id, created_at ASC);
CREATE INDEX idx_decisions_topic_created ON decisions(topic_id, created_at ASC);

CREATE TRIGGER trg_topics_revision_insert AFTER INSERT ON topics BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_topics_revision_update AFTER UPDATE ON topics BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_topics_revision_delete AFTER DELETE ON topics BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_messages_revision_insert AFTER INSERT ON messages BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_messages_revision_update AFTER UPDATE ON messages BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_messages_revision_delete AFTER DELETE ON messages BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_decisions_revision_insert AFTER INSERT ON decisions BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_decisions_revision_update AFTER UPDATE ON decisions BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
CREATE TRIGGER trg_decisions_revision_delete AFTER DELETE ON decisions BEGIN
  UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
  UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
END;
