//! @input 依赖：现有 Council SQLite schema、rusqlite 和内容领域类型
//! @output 导出：CouncilStore 兼容迁移、查询、写入和 revision API
//! @pos council.sqlite3 内容表与 Rust 桌面调用方之间的唯一持久化边界
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use std::path::Path;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use crate::error::{CouncilError, CouncilResult};
use crate::types::{
    Author, CouncilMessage, CouncilRevisions, CreateTopicInput, Decision, DecisionStatus,
    MessageKind, PaginatedTopics, PostMessageInput, RecordDecisionInput, Topic, TopicDetail,
    TopicStatus,
};

const MIGRATION_SQL: &str = r#"
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
"#;

#[derive(Debug)]
struct TopicRow {
    id: String,
    title: String,
    question: String,
    constraints_json: String,
    project_path: Option<String>,
    status: String,
    created_by: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug)]
struct MessageRow {
    id: String,
    topic_id: String,
    author: String,
    kind: String,
    content: String,
    parent_message_id: Option<String>,
    created_at: String,
}

#[derive(Debug)]
struct DecisionRow {
    id: String,
    topic_id: String,
    title: String,
    decision: String,
    rationale: String,
    alternatives_json: String,
    status: String,
    created_by: String,
    created_at: String,
    updated_at: String,
}

pub struct CouncilStore {
    connection: Connection,
}

impl CouncilStore {
    pub fn open(path: impl AsRef<Path>, busy_timeout_ms: u64) -> CouncilResult<Self> {
        if busy_timeout_ms == 0 {
            return Err(CouncilError::InvalidConfiguration(
                "SQLite busy timeout 必须是正整数。".into(),
            ));
        }
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_millis(busy_timeout_ms))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;\
             PRAGMA journal_mode = WAL;\
             PRAGMA synchronous = NORMAL;",
        )?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(MIGRATION_SQL)?;
        transaction.commit()?;
        Ok(Self { connection })
    }

    pub fn list_topics(
        &self,
        project_path: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> CouncilResult<PaginatedTopics> {
        let filtered_project_path = project_path.filter(|value| !value.is_empty());
        let (count_sql, list_sql) = if filtered_project_path.is_some() {
            (
                "SELECT COUNT(*) FROM topics WHERE project_path = ?1",
                "SELECT id, title, question, constraints_json, project_path, status, \
                 created_by, created_at, updated_at FROM topics WHERE project_path = ?1 \
                 ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3",
            )
        } else {
            (
                "SELECT COUNT(*) FROM topics",
                "SELECT id, title, question, constraints_json, project_path, status, \
                 created_by, created_at, updated_at FROM topics \
                 ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
            )
        };
        let count: i64 = match filtered_project_path {
            Some(value) => self
                .connection
                .query_row(count_sql, params![value], |row| row.get(0))?,
            None => self.connection.query_row(count_sql, [], |row| row.get(0))?,
        };
        let mut statement = self.connection.prepare(list_sql)?;
        let rows = match filtered_project_path {
            Some(value) => statement
                .query_map(
                    params![value, i64::from(limit), i64::from(offset)],
                    read_topic_row,
                )?
                .collect::<Result<Vec<_>, _>>()?,
            None => statement
                .query_map(params![i64::from(limit), i64::from(offset)], read_topic_row)?
                .collect::<Result<Vec<_>, _>>()?,
        };
        let topics = rows
            .into_iter()
            .map(topic_from_row)
            .collect::<CouncilResult<Vec<_>>>()?;
        let total = non_negative(count, "topics count")?;
        let count = u64::try_from(topics.len())
            .map_err(|_| CouncilError::InvalidData("topics count 超出范围。".into()))?;
        let next_offset = u64::from(offset) + count;
        let has_more = next_offset < total;
        Ok(PaginatedTopics {
            total,
            count,
            offset,
            has_more,
            next_offset: has_more.then_some(next_offset),
            topics,
        })
    }

    pub fn get_topic(
        &self,
        id: &str,
        message_limit: u32,
        message_offset: u32,
    ) -> CouncilResult<TopicDetail> {
        let topic = self.require_topic(id)?;
        let message_count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM messages WHERE topic_id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let mut message_statement = self.connection.prepare(
            "SELECT id, topic_id, author, kind, content, parent_message_id, created_at FROM (\
               SELECT rowid AS internal_rowid, * FROM messages WHERE topic_id = ?1 \
               ORDER BY created_at DESC, rowid DESC LIMIT ?2 OFFSET ?3\
             ) ORDER BY created_at ASC, internal_rowid ASC",
        )?;
        let message_rows = message_statement
            .query_map(
                params![id, i64::from(message_limit), i64::from(message_offset)],
                read_message_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let messages = message_rows
            .into_iter()
            .map(message_from_row)
            .collect::<CouncilResult<Vec<_>>>()?;
        let mut decision_statement = self.connection.prepare(
            "SELECT id, topic_id, title, decision, rationale, alternatives_json, status, \
             created_by, created_at, updated_at FROM decisions WHERE topic_id = ?1 \
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let decision_rows = decision_statement
            .query_map(params![id], read_decision_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let decisions = decision_rows
            .into_iter()
            .map(decision_from_row)
            .collect::<CouncilResult<Vec<_>>>()?;
        let message_total = non_negative(message_count, "messages count")?;
        let returned_count = u64::try_from(messages.len())
            .map_err(|_| CouncilError::InvalidData("messages count 超出范围。".into()))?;
        let next_message_offset = u64::from(message_offset) + returned_count;
        let has_more_messages = next_message_offset < message_total;
        Ok(TopicDetail {
            topic,
            messages,
            decisions,
            message_total,
            message_limit,
            message_offset,
            has_more_messages,
            next_message_offset: has_more_messages.then_some(next_message_offset),
        })
    }

    pub fn create_topic(&mut self, input: CreateTopicInput) -> CouncilResult<Topic> {
        let id = format!("topic_{}", Uuid::new_v4());
        let now = now_iso();
        let constraints_json = serde_json::to_string(&input.constraints)?;
        self.connection.execute(
            "INSERT INTO topics (id, title, question, constraints_json, project_path, status, \
             created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?8)",
            params![
                id,
                input.title,
                input.question,
                constraints_json,
                input.project_path,
                input.created_by.as_db(),
                now,
                now,
            ],
        )?;
        self.require_topic(&id)
    }

    pub fn post_message(&mut self, input: PostMessageInput) -> CouncilResult<CouncilMessage> {
        self.require_topic(&input.topic_id)?;
        let id = format!("message_{}", Uuid::new_v4());
        let now = now_iso();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(parent_message_id) = input.parent_message_id.as_deref() {
            let parent_topic_id = transaction
                .query_row(
                    "SELECT topic_id FROM messages WHERE id = ?1",
                    params![parent_message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(parent_topic_id) = parent_topic_id else {
                return Err(CouncilError::NotFound(
                    "父消息不存在，无法建立回复关系。".into(),
                ));
            };
            if parent_topic_id != input.topic_id {
                return Err(CouncilError::Conflict(
                    "父消息不属于当前议题，无法建立回复关系。".into(),
                ));
            }
        }
        transaction.execute(
            "INSERT INTO messages (id, topic_id, author, kind, content, parent_message_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                input.topic_id,
                input.author.as_db(),
                input.kind.as_db(),
                input.content,
                input.parent_message_id,
                now,
            ],
        )?;
        transaction.execute(
            "UPDATE topics SET updated_at = ?1 WHERE id = ?2",
            params![now, input.topic_id],
        )?;
        transaction.commit()?;
        Ok(CouncilMessage {
            id,
            topic_id: input.topic_id,
            author: input.author,
            kind: input.kind,
            content: input.content,
            parent_message_id: input.parent_message_id,
            created_at: now,
        })
    }

    pub fn record_decision(&mut self, input: RecordDecisionInput) -> CouncilResult<Decision> {
        self.require_topic(&input.topic_id)?;
        if input.status == DecisionStatus::Accepted && input.created_by != Author::Human {
            return Err(CouncilError::Conflict(
                "Accepted 决策必须由用户确认。".into(),
            ));
        }
        let id = format!("decision_{}", Uuid::new_v4());
        let now = now_iso();
        let alternatives_json = serde_json::to_string(&input.alternatives)?;
        let topic_status = if input.status == DecisionStatus::Accepted {
            TopicStatus::Decided
        } else {
            TopicStatus::Open
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO decisions (id, topic_id, title, decision, rationale, alternatives_json, \
             status, created_by, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                input.topic_id,
                input.title,
                input.decision,
                input.rationale,
                alternatives_json,
                input.status.as_db(),
                input.created_by.as_db(),
                now,
                now,
            ],
        )?;
        transaction.execute(
            "UPDATE topics SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![topic_status.as_db(), now, input.topic_id],
        )?;
        transaction.commit()?;
        Ok(Decision {
            id,
            topic_id: input.topic_id,
            title: input.title,
            decision: input.decision,
            rationale: input.rationale,
            alternatives: input.alternatives,
            status: input.status,
            created_by: input.created_by,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get_revisions(&self) -> CouncilResult<CouncilRevisions> {
        let mut statement = self.connection.prepare(
            "SELECT key, value FROM council_meta \
             WHERE key IN ('revision', 'content_revision', 'orchestration_revision')",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let value = |key: &str| -> CouncilResult<u64> {
            let raw = rows
                .iter()
                .find_map(|(row_key, value)| (row_key == key).then_some(*value))
                .ok_or_else(|| CouncilError::InvalidData("Council revision 状态无效。".into()))?;
            non_negative(raw, "Council revision")
        };
        Ok(CouncilRevisions {
            total: value("revision")?,
            content: value("content_revision")?,
            orchestration: value("orchestration_revision")?,
        })
    }

    fn require_topic(&self, id: &str) -> CouncilResult<Topic> {
        let row = self
            .connection
            .query_row(
                "SELECT id, title, question, constraints_json, project_path, status, created_by, \
                 created_at, updated_at FROM topics WHERE id = ?1",
                params![id],
                read_topic_row,
            )
            .optional()?;
        match row {
            Some(row) => topic_from_row(row),
            None => Err(CouncilError::NotFound(format!(
                "议题 {id} 不存在。请先列出议题或创建新议题。"
            ))),
        }
    }
}

fn read_topic_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TopicRow> {
    Ok(TopicRow {
        id: row.get(0)?,
        title: row.get(1)?,
        question: row.get(2)?,
        constraints_json: row.get(3)?,
        project_path: row.get(4)?,
        status: row.get(5)?,
        created_by: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn read_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        author: row.get(2)?,
        kind: row.get(3)?,
        content: row.get(4)?,
        parent_message_id: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn read_decision_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DecisionRow> {
    Ok(DecisionRow {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        title: row.get(2)?,
        decision: row.get(3)?,
        rationale: row.get(4)?,
        alternatives_json: row.get(5)?,
        status: row.get(6)?,
        created_by: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn topic_from_row(row: TopicRow) -> CouncilResult<Topic> {
    Ok(Topic {
        id: row.id,
        title: row.title,
        question: row.question,
        constraints: parse_string_array(&row.constraints_json),
        project_path: row.project_path.filter(|value| !value.is_empty()),
        status: TopicStatus::from_db(&row.status).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 Topic status：{}", row.status))
        })?,
        created_by: Author::from_db(&row.created_by).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 Topic author：{}", row.created_by))
        })?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn message_from_row(row: MessageRow) -> CouncilResult<CouncilMessage> {
    Ok(CouncilMessage {
        id: row.id,
        topic_id: row.topic_id,
        author: Author::from_db(&row.author).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 Message author：{}", row.author))
        })?,
        kind: MessageKind::from_db(&row.kind)
            .ok_or_else(|| CouncilError::InvalidData(format!("未知 Message kind：{}", row.kind)))?,
        content: row.content,
        parent_message_id: row.parent_message_id.filter(|value| !value.is_empty()),
        created_at: row.created_at,
    })
}

fn decision_from_row(row: DecisionRow) -> CouncilResult<Decision> {
    Ok(Decision {
        id: row.id,
        topic_id: row.topic_id,
        title: row.title,
        decision: row.decision,
        rationale: row.rationale,
        alternatives: parse_string_array(&row.alternatives_json),
        status: DecisionStatus::from_db(&row.status).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 Decision status：{}", row.status))
        })?,
        created_by: Author::from_db(&row.created_by).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 Decision author：{}", row.created_by))
        })?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn parse_string_array(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn non_negative(value: i64, label: &str) -> CouncilResult<u64> {
    u64::try_from(value).map_err(|_| CouncilError::InvalidData(format!("{label} 必须是非负整数。")))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::CouncilStore;

    #[test]
    fn configures_sqlite_connection_pragmas() {
        let directory = tempdir().expect("temp directory");
        let store = CouncilStore::open(directory.path().join("council.sqlite3"), 4_321)
            .expect("store should open");

        let foreign_keys: i64 = store
            .connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("foreign_keys pragma");
        let journal_mode: String = store
            .connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .expect("journal_mode pragma");
        let synchronous: i64 = store
            .connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .expect("synchronous pragma");
        let busy_timeout: i64 = store
            .connection
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .expect("busy_timeout pragma");

        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode, "wal");
        assert_eq!(synchronous, 1);
        assert_eq!(busy_timeout, 4_321);
    }

    #[test]
    fn rejects_zero_busy_timeout() {
        let directory = tempdir().expect("temp directory");
        let result = CouncilStore::open(directory.path().join("council.sqlite3"), 0);
        assert!(result.is_err());
    }
}
