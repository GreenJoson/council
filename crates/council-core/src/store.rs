//! @input 依赖：已由 Node 迁移器准备的 v10 Actor/Model Router/RuntimeBinding/Cycle SQLite、rusqlite 和领域类型
//! @output 导出：CouncilStore Actor alias/冻结快照一致性、v10 通用 ACP Runtime/逻辑请求/session/capability 唯一 schema、查询写入和 revision API
//! @pos council.sqlite3 与 Rust 桌面调用方之间的只消费、身份失败关闭边界
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use std::path::Path;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use crate::error::{CouncilError, CouncilResult};
use crate::types::{
    ActorSnapshot, CouncilMessage, CouncilRevisions, CreateTopicInput, Decision, DecisionStatus,
    MessageKind, PaginatedTopics, PostMessageInput, RecordDecisionInput, Topic, TopicDetail,
    TopicStatus,
};

const SUPPORTED_SCHEMA_VERSION: i64 = 10;
const REQUIRED_TABLES: &[&str] = &[
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
    "runtime_bindings",
    "runtime_binding_leases",
    "runtime_binding_requests",
    "discussion_cycles",
    "blocking_questions",
    "schema_migrations",
];
const REQUIRED_INDEXES: &[&str] = &[
    "idx_topics_project_updated",
    "idx_messages_topic_created",
    "idx_decisions_topic_created",
    "idx_actor_identities_status_slug",
    "idx_actor_aliases_actor",
    "idx_agent_sessions_current",
    "idx_provider_profiles_status_slug",
    "idx_agent_definitions_provider",
    "idx_agent_definitions_enabled_alias",
    "idx_runtime_bindings_topic_status",
    "idx_runtime_bindings_idle",
    "idx_runtime_bindings_one_open_agent",
    "idx_runtime_bindings_active_session",
    "idx_runtime_binding_leases_expiry",
    "idx_discussion_cycles_one_active_topic",
    "idx_discussion_cycles_topic_updated",
    "idx_discussion_cycles_status_stage",
    "idx_blocking_questions_one_open_cycle",
    "idx_blocking_questions_cycle_created",
    "idx_blocking_questions_status_created",
];
const REQUIRED_TRIGGERS: &[&str] = &[
    "trg_topics_revision_insert",
    "trg_topics_revision_update",
    "trg_topics_revision_delete",
    "trg_messages_revision_insert",
    "trg_messages_revision_update",
    "trg_messages_revision_delete",
    "trg_decisions_revision_insert",
    "trg_decisions_revision_update",
    "trg_decisions_revision_delete",
    "trg_runtime_bindings_revision_insert",
    "trg_runtime_bindings_revision_update",
    "trg_runtime_bindings_revision_delete",
    "trg_decisions_runtime_close_insert",
    "trg_decisions_runtime_close_update",
    "trg_discussion_cycles_revision_insert",
    "trg_discussion_cycles_revision_update",
    "trg_discussion_cycles_revision_delete",
    "trg_blocking_questions_revision_insert",
    "trg_blocking_questions_revision_update",
    "trg_blocking_questions_revision_delete",
    "trg_decisions_cycle_close_insert",
    "trg_decisions_cycle_close_update",
];
const TOPIC_COLUMNS: &[&str] = &[
    "id",
    "title",
    "question",
    "constraints_json",
    "project_path",
    "status",
    "created_by_actor_id",
    "created_by_snapshot_json",
    "created_by_legacy",
    "created_at",
    "updated_at",
];
const MESSAGE_COLUMNS: &[&str] = &[
    "id",
    "topic_id",
    "author_actor_id",
    "author_snapshot_json",
    "author_legacy",
    "kind",
    "content",
    "parent_message_id",
    "created_at",
];
const DECISION_COLUMNS: &[&str] = &[
    "id",
    "topic_id",
    "title",
    "decision",
    "rationale",
    "alternatives_json",
    "status",
    "created_by_actor_id",
    "created_by_snapshot_json",
    "created_by_legacy",
    "created_at",
    "updated_at",
];
const SESSION_COLUMNS: &[&str] = &[
    "id",
    "topic_id",
    "actor_id",
    "session_id",
    "legacy_agent",
    "is_current",
    "updated_at",
];
const BRAND_COLUMNS: &[&str] = &[
    "id",
    "slug",
    "display_name",
    "glyph_id",
    "color_token",
    "source_kind",
    "source_label",
    "status",
    "created_at",
    "updated_at",
];
const PROVIDER_COLUMNS: &[&str] = &[
    "id",
    "slug",
    "display_name",
    "protocol",
    "base_url",
    "requires_api_key",
    "credential_ref",
    "brand_asset_id",
    "runtime_definition_id",
    "status",
    "created_at",
    "updated_at",
    "config_revision",
];
const AGENT_DEFINITION_COLUMNS: &[&str] = &[
    "id",
    "actor_id",
    "provider_id",
    "slug",
    "display_name",
    "model",
    "mention_alias",
    "enabled",
    "deleted_at",
    "created_at",
    "updated_at",
    "config_revision",
];
const RUNTIME_BINDING_COLUMNS: &[&str] = &[
    "id",
    "topic_id",
    "agent_id",
    "actor_id",
    "provider_id",
    "binding_revision",
    "agent_config_revision",
    "provider_config_revision",
    "project_path",
    "transport_kind",
    "session_id",
    "cursor_created_at",
    "cursor_message_id",
    "status",
    "state_version",
    "epoch",
    "process_instance_id",
    "last_activity_at",
    "close_reason",
    "created_at",
    "updated_at",
    "closed_at",
];
const RUNTIME_BINDING_LEASE_COLUMNS: &[&str] = &[
    "binding_id",
    "owner_id",
    "lease_token",
    "epoch",
    "expires_at_ms",
    "updated_at",
];
const RUNTIME_BINDING_REQUEST_COLUMNS: &[&str] =
    &["topic_id", "agent_id", "request_message_id", "consumed_at"];
const DISCUSSION_CYCLE_COLUMNS: &[&str] = &[
    "id",
    "topic_id",
    "stage",
    "status",
    "participants_json",
    "turns_json",
    "round_budget",
    "current_round",
    "resume_stage",
    "context_cursor_message_id",
    "context_cursor_created_at",
    "proposed_decision_id",
    "state_version",
    "epoch",
    "stop_reason",
    "created_at",
    "updated_at",
    "completed_at",
    "cycle_kind",
    "requirements_json",
    "capability_snapshot_json",
    "outcome_json",
];
const BLOCKING_QUESTION_COLUMNS: &[&str] = &[
    "id",
    "cycle_id",
    "asked_by_actor_id",
    "asked_at_stage",
    "question",
    "rationale",
    "options_json",
    "status",
    "question_message_id",
    "answer_message_id",
    "created_at",
    "updated_at",
    "resolved_at",
];

fn assert_schema_objects(
    connection: &Connection,
    object_type: &str,
    names: &[&str],
) -> CouncilResult<()> {
    for name in names {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2
             )",
            params![object_type, name],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(CouncilError::InvalidData(format!(
                "Council SQLite 缺少已迁移 {object_type}：{name}。"
            )));
        }
    }
    Ok(())
}

fn assert_table_sql_contains(
    connection: &Connection,
    table: &str,
    required_fragments: &[&str],
) -> CouncilResult<()> {
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    let canonical = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    for fragment in required_fragments {
        if !canonical.contains(fragment) {
            return Err(CouncilError::InvalidData(format!(
                "Council SQLite 表 {table} 缺少 canonical 约束。"
            )));
        }
    }
    Ok(())
}

fn assert_table_columns(
    connection: &Connection,
    table: &str,
    expected: &[&str],
) -> CouncilResult<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if actual != expected {
        return Err(CouncilError::InvalidData(format!(
            "Council SQLite 表字段不兼容：{table}。"
        )));
    }
    Ok(())
}

fn assert_foreign_key(
    connection: &Connection,
    table: &str,
    from: &str,
    target_table: &str,
    target_column: &str,
) -> CouncilResult<()> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_list(?1)
         WHERE \"from\" = ?2 AND \"table\" = ?3 AND \"to\" = ?4 AND on_delete = 'CASCADE'",
        params![table, from, target_table, target_column],
        |row| row.get(0),
    )?;
    if count != 1 {
        return Err(CouncilError::InvalidData(format!(
            "Council SQLite 外键定义不兼容：{table}.{from}。"
        )));
    }
    Ok(())
}

fn assert_index_columns(
    connection: &Connection,
    index: &str,
    expected: &[&str],
) -> CouncilResult<()> {
    let mut statement =
        connection.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?;
    let actual = statement
        .query_map([index], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if actual != expected {
        return Err(CouncilError::InvalidData(format!(
            "Council SQLite 索引定义不兼容：{index}。"
        )));
    }
    Ok(())
}

fn assert_index_sql_contains(
    connection: &Connection,
    index: &str,
    required_fragment: &str,
) -> CouncilResult<()> {
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
        [index],
        |row| row.get(0),
    )?;
    let canonical = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if !canonical.contains(required_fragment) {
        return Err(CouncilError::InvalidData(format!(
            "Council SQLite 索引 {index} 缺少 canonical 约束。"
        )));
    }
    Ok(())
}

fn read_database_instance_id(connection: &Connection) -> CouncilResult<String> {
    let mut statement =
        connection.prepare("SELECT instance_id FROM council_identity WHERE singleton = 1")?;
    let identities = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if identities.len() != 1 || uuid::Uuid::parse_str(&identities[0]).is_err() {
        return Err(CouncilError::InvalidData(
            "Council SQLite 数据库实例身份无效。".into(),
        ));
    }
    Ok(identities[0].clone())
}

fn validate_schema(connection: &Connection) -> CouncilResult<()> {
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let mut ledger_statement = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .map_err(|_| {
            CouncilError::InvalidData(
                "Council SQLite 尚未由 Node 迁移器准备 schema_migrations。".into(),
            )
        })?;
    let ledger_versions = ledger_statement
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for (index, version) in ledger_versions.iter().enumerate() {
        if *version != (index as i64) + 1 {
            return Err(CouncilError::InvalidData(
                "Council schema_migrations 账本不连续。".into(),
            ));
        }
    }
    let ledger_version = ledger_versions.last().copied().unwrap_or(0);
    if user_version != ledger_version {
        return Err(CouncilError::InvalidData(
            "Council schema_migrations 与 user_version 不一致。".into(),
        ));
    }
    if user_version != SUPPORTED_SCHEMA_VERSION {
        return Err(CouncilError::InvalidData(format!(
            "Council SQLite schema 版本 {user_version} 不受当前桌面核心支持。"
        )));
    }
    assert_schema_objects(connection, "table", REQUIRED_TABLES)?;
    assert_schema_objects(connection, "index", REQUIRED_INDEXES)?;
    assert_schema_objects(connection, "trigger", REQUIRED_TRIGGERS)?;
    assert_table_columns(connection, "topics", TOPIC_COLUMNS)?;
    assert_table_columns(connection, "messages", MESSAGE_COLUMNS)?;
    assert_table_columns(connection, "decisions", DECISION_COLUMNS)?;
    assert_table_columns(connection, "agent_sessions", SESSION_COLUMNS)?;
    assert_table_columns(connection, "brand_assets", BRAND_COLUMNS)?;
    assert_table_columns(connection, "provider_profiles", PROVIDER_COLUMNS)?;
    assert_table_columns(connection, "agent_definitions", AGENT_DEFINITION_COLUMNS)?;
    assert_table_columns(connection, "runtime_bindings", RUNTIME_BINDING_COLUMNS)?;
    assert_table_columns(
        connection,
        "runtime_binding_leases",
        RUNTIME_BINDING_LEASE_COLUMNS,
    )?;
    assert_table_columns(
        connection,
        "runtime_binding_requests",
        RUNTIME_BINDING_REQUEST_COLUMNS,
    )?;
    assert_table_columns(connection, "discussion_cycles", DISCUSSION_CYCLE_COLUMNS)?;
    assert_table_columns(connection, "blocking_questions", BLOCKING_QUESTION_COLUMNS)?;
    assert_table_columns(
        connection,
        "actor_identities",
        &[
            "id",
            "slug",
            "display_name",
            "short_name",
            "role",
            "actor_type",
            "status",
            "created_at",
            "updated_at",
        ],
    )?;
    assert_table_columns(
        connection,
        "actor_aliases",
        &["alias", "actor_id", "alias_kind", "created_at"],
    )?;
    assert_table_columns(
        connection,
        "council_identity",
        &["singleton", "instance_id"],
    )?;
    assert_foreign_key(connection, "messages", "topic_id", "topics", "id")?;
    assert_foreign_key(connection, "decisions", "topic_id", "topics", "id")?;
    assert_foreign_key(connection, "runtime_bindings", "topic_id", "topics", "id")?;
    assert_foreign_key(
        connection,
        "runtime_binding_leases",
        "binding_id",
        "runtime_bindings",
        "id",
    )?;
    assert_foreign_key(
        connection,
        "runtime_binding_requests",
        "topic_id",
        "topics",
        "id",
    )?;
    assert_foreign_key(
        connection,
        "runtime_binding_requests",
        "agent_id",
        "agent_definitions",
        "id",
    )?;
    assert_foreign_key(
        connection,
        "runtime_binding_requests",
        "request_message_id",
        "messages",
        "id",
    )?;
    assert_index_columns(
        connection,
        "idx_topics_project_updated",
        &["project_path", "updated_at"],
    )?;
    assert_index_columns(
        connection,
        "idx_messages_topic_created",
        &["topic_id", "created_at"],
    )?;
    assert_index_columns(
        connection,
        "idx_decisions_topic_created",
        &["topic_id", "created_at"],
    )?;
    assert_index_columns(
        connection,
        "idx_actor_identities_status_slug",
        &["status", "slug"],
    )?;
    assert_index_columns(connection, "idx_actor_aliases_actor", &["actor_id"])?;
    assert_index_columns(
        connection,
        "idx_agent_sessions_current",
        &["topic_id", "actor_id"],
    )?;
    assert_index_columns(
        connection,
        "idx_provider_profiles_status_slug",
        &["status", "slug"],
    )?;
    assert_index_columns(
        connection,
        "idx_agent_definitions_provider",
        &["provider_id", "deleted_at"],
    )?;
    assert_index_columns(
        connection,
        "idx_agent_definitions_enabled_alias",
        &["enabled", "mention_alias"],
    )?;
    assert_index_columns(
        connection,
        "idx_runtime_bindings_topic_status",
        &["topic_id", "status", "updated_at"],
    )?;
    assert_index_columns(
        connection,
        "idx_runtime_bindings_idle",
        &["status", "last_activity_at"],
    )?;
    assert_index_columns(
        connection,
        "idx_runtime_bindings_one_open_agent",
        &["topic_id", "agent_id"],
    )?;
    assert_index_columns(
        connection,
        "idx_runtime_bindings_active_session",
        &["provider_id", "agent_id", "transport_kind", "session_id"],
    )?;
    assert_index_columns(
        connection,
        "idx_runtime_binding_leases_expiry",
        &["expires_at_ms"],
    )?;
    assert_index_sql_contains(
        connection,
        "idx_runtime_bindings_one_open_agent",
        "WHERE status <> 'closed'",
    )?;
    assert_index_sql_contains(
        connection,
        "idx_runtime_bindings_active_session",
        "WHERE session_id IS NOT NULL AND status <> 'closed' AND transport_kind IN ('claude-resume', 'codex-resume', 'acp')",
    )?;
    assert_table_sql_contains(
        connection,
        "runtime_binding_requests",
        &["PRIMARY KEY (topic_id, agent_id, request_message_id)"],
    )?;
    assert_table_sql_contains(
        connection,
        "provider_profiles",
        &[
            "credential_ref TEXT UNIQUE",
            "requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1))",
            "runtime_definition_id TEXT",
            "status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deleted'))",
            "(protocol = 'acp' AND runtime_definition_id IS NOT NULL)",
            "(protocol <> 'acp' AND runtime_definition_id IS NULL)",
            "config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0)",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "agent_definitions",
        &[
            "actor_id TEXT NOT NULL UNIQUE",
            "mention_alias TEXT NOT NULL COLLATE NOCASE UNIQUE",
            "enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))",
            "CHECK ( (deleted_at IS NULL) OR (enabled = 0) )",
            "config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0)",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "runtime_bindings",
        &[
            "transport_kind IN ( 'claude-resume', 'codex-resume', 'openai-sessionless', 'openai-tool-loop', 'acp' )",
            "agent_config_revision INTEGER NOT NULL CHECK (agent_config_revision > 0)",
            "provider_config_revision INTEGER NOT NULL CHECK (provider_config_revision > 0)",
            "(cursor_created_at IS NULL AND cursor_message_id IS NULL)",
            "(status = 'closed' AND closed_at IS NOT NULL)",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "runtime_binding_leases",
        &[
            "binding_id TEXT PRIMARY KEY REFERENCES runtime_bindings(id) ON DELETE CASCADE",
            "lease_token TEXT NOT NULL UNIQUE",
            "epoch INTEGER NOT NULL CHECK (epoch > 0)",
        ],
    )?;
    let foreign_key_error_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_error_count != 0 {
        return Err(CouncilError::InvalidData(
            "Council SQLite 外键检查失败。".into(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct TopicRow {
    id: String,
    title: String,
    question: String,
    constraints_json: String,
    project_path: Option<String>,
    status: String,
    created_by_actor_id: String,
    created_by_snapshot_json: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug)]
struct MessageRow {
    id: String,
    topic_id: String,
    author_actor_id: String,
    author_snapshot_json: String,
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
    created_by_actor_id: String,
    created_by_snapshot_json: String,
    created_at: String,
    updated_at: String,
}

struct ResolvedActor {
    id: String,
    snapshot: ActorSnapshot,
    snapshot_json: String,
}

pub struct CouncilStore {
    connection: Connection,
    database_instance_id: String,
}

impl CouncilStore {
    pub fn open(path: impl AsRef<Path>, busy_timeout_ms: u64) -> CouncilResult<Self> {
        if busy_timeout_ms == 0 {
            return Err(CouncilError::InvalidConfiguration(
                "SQLite busy timeout 必须是正整数。".into(),
            ));
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(busy_timeout_ms))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;\
             PRAGMA journal_mode = WAL;\
             PRAGMA synchronous = NORMAL;",
        )?;
        validate_schema(&connection)?;
        let database_instance_id = read_database_instance_id(&connection)?;
        Ok(Self {
            connection,
            database_instance_id,
        })
    }

    pub fn database_instance_id(&self) -> &str {
        &self.database_instance_id
    }

    fn resolve_active_actor(&self, alias: &str) -> CouncilResult<ResolvedActor> {
        let normalized = alias.trim();
        if normalized.is_empty() {
            return Err(CouncilError::InvalidData("Actor alias 不能为空。".into()));
        }
        let row = self
            .connection
            .query_row(
                "SELECT identities.id, identities.slug, identities.display_name,
                        identities.short_name, identities.role
                 FROM actor_aliases AS aliases
                 INNER JOIN actor_identities AS identities ON identities.id = aliases.actor_id
                 WHERE aliases.alias = ?1 COLLATE NOCASE AND identities.status = 'active'",
                params![normalized],
                |row| {
                    Ok(ActorSnapshot {
                        schema_version: 1,
                        actor_id: row.get(0)?,
                        slug: row.get(1)?,
                        display_name: row.get(2)?,
                        short_name: row.get(3)?,
                        role: row.get(4)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| {
                CouncilError::InvalidData(format!(
                    "Actor alias {normalized} 未注册或不可用于新写入。"
                ))
            })?;
        let snapshot_json = serde_json::to_string(&row)?;
        Ok(ResolvedActor {
            id: row.actor_id.clone(),
            snapshot: row,
            snapshot_json,
        })
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
                 created_by_actor_id, created_by_snapshot_json, created_at, updated_at \
                 FROM topics WHERE project_path = ?1 \
                 ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3",
            )
        } else {
            (
                "SELECT COUNT(*) FROM topics",
                "SELECT id, title, question, constraints_json, project_path, status, \
                 created_by_actor_id, created_by_snapshot_json, created_at, updated_at FROM topics \
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
            "SELECT id, topic_id, author_actor_id, author_snapshot_json, kind, content, \
             parent_message_id, created_at FROM (\
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
             created_by_actor_id, created_by_snapshot_json, created_at, updated_at \
             FROM decisions WHERE topic_id = ?1 \
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
        let actor = self.resolve_active_actor(&input.created_by_alias)?;
        let id = format!("topic_{}", Uuid::new_v4());
        let now = now_iso();
        let constraints_json = serde_json::to_string(&input.constraints)?;
        self.connection.execute(
            "INSERT INTO topics (
               id, title, question, constraints_json, project_path, status,
               created_by_actor_id, created_by_snapshot_json, created_by_legacy,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, NULL, ?8, ?9)",
            params![
                id,
                input.title,
                input.question,
                constraints_json,
                input.project_path,
                actor.id,
                actor.snapshot_json,
                now,
                now,
            ],
        )?;
        self.require_topic(&id)
    }

    pub fn post_message(&mut self, input: PostMessageInput) -> CouncilResult<CouncilMessage> {
        self.require_topic(&input.topic_id)?;
        let actor = self.resolve_active_actor(&input.actor_alias)?;
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
            "INSERT INTO messages (
               id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
               kind, content, parent_message_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
            params![
                id,
                input.topic_id,
                actor.id,
                actor.snapshot_json,
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
            actor_id: actor.id,
            actor_snapshot: actor.snapshot,
            kind: input.kind,
            content: input.content,
            parent_message_id: input.parent_message_id,
            created_at: now,
        })
    }

    pub fn record_decision(&mut self, input: RecordDecisionInput) -> CouncilResult<Decision> {
        self.require_topic(&input.topic_id)?;
        let actor = self.resolve_active_actor(&input.created_by_alias)?;
        if input.status == DecisionStatus::Accepted && actor.id != "human" {
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
             status, created_by_actor_id, created_by_snapshot_json, created_by_legacy,
             created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11)",
            params![
                id,
                input.topic_id,
                input.title,
                input.decision,
                input.rationale,
                alternatives_json,
                input.status.as_db(),
                actor.id,
                actor.snapshot_json,
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
            created_by_actor_id: actor.id,
            created_by_snapshot: actor.snapshot,
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
                "SELECT id, title, question, constraints_json, project_path, status,
                 created_by_actor_id, created_by_snapshot_json, created_at, updated_at
                 FROM topics WHERE id = ?1",
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
        created_by_actor_id: row.get(6)?,
        created_by_snapshot_json: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn read_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        author_actor_id: row.get(2)?,
        author_snapshot_json: row.get(3)?,
        kind: row.get(4)?,
        content: row.get(5)?,
        parent_message_id: row.get(6)?,
        created_at: row.get(7)?,
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
        created_by_actor_id: row.get(7)?,
        created_by_snapshot_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn topic_from_row(row: TopicRow) -> CouncilResult<Topic> {
    let created_by_snapshot =
        parse_actor_snapshot(&row.created_by_snapshot_json, &row.created_by_actor_id)?;
    Ok(Topic {
        id: row.id,
        title: row.title,
        question: row.question,
        constraints: parse_string_array(&row.constraints_json),
        project_path: row.project_path.filter(|value| !value.is_empty()),
        status: TopicStatus::from_db(&row.status).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 Topic status：{}", row.status))
        })?,
        created_by_actor_id: row.created_by_actor_id,
        created_by_snapshot,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn message_from_row(row: MessageRow) -> CouncilResult<CouncilMessage> {
    let actor_snapshot = parse_actor_snapshot(&row.author_snapshot_json, &row.author_actor_id)?;
    Ok(CouncilMessage {
        id: row.id,
        topic_id: row.topic_id,
        actor_id: row.author_actor_id,
        actor_snapshot,
        kind: MessageKind::from_db(&row.kind)
            .ok_or_else(|| CouncilError::InvalidData(format!("未知 Message kind：{}", row.kind)))?,
        content: row.content,
        parent_message_id: row.parent_message_id.filter(|value| !value.is_empty()),
        created_at: row.created_at,
    })
}

fn decision_from_row(row: DecisionRow) -> CouncilResult<Decision> {
    let created_by_snapshot =
        parse_actor_snapshot(&row.created_by_snapshot_json, &row.created_by_actor_id)?;
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
        created_by_actor_id: row.created_by_actor_id,
        created_by_snapshot,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn parse_string_array(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn parse_actor_snapshot(value: &str, expected_actor_id: &str) -> CouncilResult<ActorSnapshot> {
    let snapshot: ActorSnapshot = serde_json::from_str(value)
        .map_err(|_| CouncilError::InvalidData("Actor snapshot 无效。".into()))?;
    if snapshot.schema_version != 1
        || snapshot.actor_id.is_empty()
        || snapshot.slug.is_empty()
        || snapshot.display_name.is_empty()
        || snapshot.short_name.is_empty()
        || snapshot.role.is_empty()
        || snapshot.actor_id != expected_actor_id
    {
        return Err(CouncilError::InvalidData(
            "Actor snapshot 字段无效。".into(),
        ));
    }
    Ok(snapshot)
}

fn non_negative(value: i64, label: &str) -> CouncilResult<u64> {
    u64::try_from(value).map_err(|_| CouncilError::InvalidData(format!("{label} 必须是非负整数。")))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    use tempfile::tempdir;

    use super::CouncilStore;

    fn workspace_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("workspace root")
    }

    fn create_node_database(database_path: &Path) {
        static NODE_BUILD: OnceLock<()> = OnceLock::new();
        NODE_BUILD.get_or_init(|| {
            let status = Command::new("npm")
                .args(["run", "build", "--prefix", "packages/mcp-server"])
                .current_dir(workspace_root())
                .status()
                .expect("build Node migrator");
            assert!(status.success(), "Node migrator build must succeed");
        });
        let status = Command::new("node")
            .arg("packages/mcp-server/scripts/create-rust-test-database.mjs")
            .arg("fresh")
            .arg(database_path)
            .current_dir(workspace_root())
            .status()
            .expect("run Node database generator");
        assert!(status.success(), "Node database generator must succeed");
    }

    #[test]
    fn configures_sqlite_connection_pragmas() {
        let directory = tempdir().expect("temp directory");
        let database_path = directory.path().join("council.sqlite3");
        create_node_database(&database_path);
        let store = CouncilStore::open(database_path, 4_321).expect("store should open");

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
