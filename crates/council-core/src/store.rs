//! @input 依赖：已由 Node 迁移器准备的 v12 Actor/Model Router/RuntimeBinding/Cycle/实施项树 SQLite、rusqlite 和领域类型
//! @output 导出：CouncilStore Actor alias/冻结快照一致性、v12 schema、内容与实施项查询写入和 revision API
//! @pos council.sqlite3 与 Rust 桌面调用方之间的只消费、身份失败关闭边界
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use std::path::Path;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use uuid::Uuid;

use crate::error::{CouncilError, CouncilResult};
use crate::types::{
    ActorSnapshot, ClaimWorkItemInput, CouncilMessage, CouncilRevisions, CreateTopicInput,
    CreateWorkItemsInput, Decision, DecisionStatus, MessageKind, PaginatedTopics, PostMessageInput,
    RecordDecisionInput, Topic, TopicDetail, TopicStatus, UpdateWorkItemInput, WorkItem,
    WorkItemOrigin, WorkItemProgress, WorkItemSeverity, WorkItemStatus,
};

const SUPPORTED_SCHEMA_VERSION: i64 = 12;
const REQUIRED_TABLES: &[&str] = &[
    "topics",
    "messages",
    "decisions",
    "work_items",
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
    "idx_work_items_topic_status",
    "idx_work_items_parent_title",
    "idx_work_items_parent_order",
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
    "trg_work_items_revision_insert",
    "trg_work_items_revision_update",
    "trg_work_items_revision_delete",
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
const WORK_ITEM_COLUMNS: &[&str] = &[
    "id",
    "topic_id",
    "decision_id",
    "title",
    "details",
    "status",
    "status_note",
    "version",
    "created_by_actor_id",
    "created_by_snapshot_json",
    "updated_by_actor_id",
    "updated_by_snapshot_json",
    "created_at",
    "updated_at",
    "completed_at",
    "parent_id",
    "sort_order",
    "origin",
    "severity",
    "source_message_id",
    "source_cycle_id",
    "review_round",
    "fix_commit",
    "assignee_actor_id",
    "claimed_at",
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
    assert_table_columns(connection, "work_items", WORK_ITEM_COLUMNS)?;
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
    assert_foreign_key(connection, "work_items", "topic_id", "topics", "id")?;
    assert_foreign_key(connection, "work_items", "decision_id", "decisions", "id")?;
    assert_foreign_key(connection, "work_items", "parent_id", "work_items", "id")?;
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
        "idx_work_items_topic_status",
        &["topic_id", "status", "created_at"],
    )?;
    // v12 起唯一性按父级判定：同决策不同父级的同名子任务是树的正常形态。
    // parent_key 是生成列，PRAGMA table_info 看不到它，这条索引断言就是它没有漂移的凭据。
    assert_index_columns(
        connection,
        "idx_work_items_parent_title",
        &["topic_id", "parent_key", "title"],
    )?;
    assert_index_columns(
        connection,
        "idx_work_items_parent_order",
        &["topic_id", "parent_key", "sort_order", "created_at"],
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
        "work_items",
        &[
            "status IN ('pending', 'in_progress', 'blocked', 'completed')",
            "version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)",
            "(status = 'completed' AND completed_at IS NOT NULL)",
            "(status <> 'completed' AND completed_at IS NULL)",
            "parent_key TEXT GENERATED ALWAYS AS (COALESCE(parent_id, '')) VIRTUAL",
            "origin IN ('manual', 'review_finding')",
            "severity IS NULL OR severity IN ('blocking', 'non_blocking')",
            "CHECK (parent_id IS NULL OR parent_id <> id)",
        ],
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

/// 实施项读取列清单。read_work_item_row 按位置索引取值，
/// 所以每一处 SELECT 都必须用这个常量，不能各写各的顺序。
const WORK_ITEM_SELECT_COLUMNS: &str = "id, topic_id, decision_id, title, details, status, \
     status_note, version, created_by_actor_id, created_by_snapshot_json, \
     updated_by_actor_id, updated_by_snapshot_json, created_at, updated_at, completed_at, \
     parent_id, sort_order, origin, severity, source_message_id, source_cycle_id, \
     review_round, fix_commit, assignee_actor_id, claimed_at";

#[derive(Debug)]
struct WorkItemRow {
    id: String,
    topic_id: String,
    decision_id: Option<String>,
    title: String,
    details: String,
    status: String,
    status_note: Option<String>,
    version: i64,
    created_by_actor_id: String,
    created_by_snapshot_json: String,
    updated_by_actor_id: String,
    updated_by_snapshot_json: String,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
    parent_id: Option<String>,
    sort_order: i64,
    origin: String,
    severity: Option<String>,
    source_message_id: Option<String>,
    source_cycle_id: Option<String>,
    review_round: Option<i64>,
    fix_commit: Option<String>,
    assignee_actor_id: Option<String>,
    claimed_at: Option<String>,
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
        let mut topics = rows
            .into_iter()
            .map(topic_from_row)
            .collect::<CouncilResult<Vec<_>>>()?;
        // 议题导航要在不拉取每个议题详情的前提下显示完成度，只能由列表查询顺带带下来。
        let progress = read_work_item_progress(
            &self.connection,
            &topics
                .iter()
                .map(|topic| topic.id.clone())
                .collect::<Vec<_>>(),
        )?;
        for topic in &mut topics {
            // 没有实施项的议题不带这个字段：界面据此区分「还没拆」和「0 / N」，
            // 前者不该在列表里显示一个毫无信息量的 0/0 徽章。
            topic.work_item_progress = progress.get(&topic.id).copied();
        }
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
        let mut work_item_statement = self.connection.prepare(&format!(
            "SELECT {WORK_ITEM_SELECT_COLUMNS} FROM work_items WHERE topic_id = ?1 \
             ORDER BY parent_key ASC, sort_order ASC, created_at ASC, rowid ASC"
        ))?;
        let work_item_rows = work_item_statement
            .query_map(params![id], read_work_item_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let work_items = work_item_rows
            .into_iter()
            .map(work_item_from_row)
            .collect::<CouncilResult<Vec<_>>>()?;
        let message_total = non_negative(message_count, "messages count")?;
        let returned_count = u64::try_from(messages.len())
            .map_err(|_| CouncilError::InvalidData("messages count 超出范围。".into()))?;
        let next_message_offset = u64::from(message_offset) + returned_count;
        let has_more_messages = next_message_offset < message_total;
        let mut topic = topic;
        // 详情已经手握全量实施项，就地汇总即可，不必为同一个数字再查一次库。
        topic.work_item_progress = summarize_work_item_progress(&work_items);
        Ok(TopicDetail {
            topic,
            messages,
            decisions,
            work_items,
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

    pub fn create_work_items(
        &mut self,
        input: CreateWorkItemsInput,
    ) -> CouncilResult<Vec<WorkItem>> {
        self.require_topic(&input.topic_id)?;
        if input.items.is_empty() {
            return Err(CouncilError::Conflict("至少需要一个实施项。".into()));
        }
        let actor = self.resolve_active_actor(&input.actor_alias)?;
        // 子任务不自己选决策：它属于父任务所属的那次决策，否则一棵树会横跨两个 ADR。
        let decision_id = match input.parent_id.as_deref() {
            Some(parent_id) => {
                self.require_work_item(parent_id, &input.topic_id)?
                    .decision_id
            }
            None => Some(
                self.require_accepted_decision_id(&input.topic_id, input.decision_id.as_deref())?,
            ),
        };
        let parent_key = input.parent_id.clone().unwrap_or_default();
        let mut normalized_items = Vec::with_capacity(input.items.len());
        let mut normalized_titles = std::collections::HashSet::new();
        for item in input.items {
            let title = item.title.trim().to_string();
            if title.is_empty() {
                return Err(CouncilError::Conflict("实施项标题不能为空。".into()));
            }
            if !normalized_titles.insert(title.to_lowercase()) {
                return Err(CouncilError::Conflict(
                    "同一批实施项不能包含重复标题。".into(),
                ));
            }
            normalized_items.push((title, item.details.trim().to_string()));
        }

        let now = now_iso();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut sort_order: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM work_items \
             WHERE topic_id = ?1 AND parent_key = ?2",
            params![input.topic_id, parent_key],
            |row| row.get(0),
        )?;
        let mut created_ids = Vec::with_capacity(normalized_items.len());
        for (title, details) in normalized_items {
            let duplicate: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM work_items \
                 WHERE topic_id = ?1 AND parent_key = ?2 AND title = ?3 COLLATE NOCASE)",
                params![input.topic_id, parent_key, title],
                |row| row.get(0),
            )?;
            if duplicate {
                return Err(CouncilError::Conflict(format!("实施项“{title}”已经存在。")));
            }
            let id = format!("work_item_{}", Uuid::new_v4());
            transaction.execute(
                "INSERT INTO work_items (
                   id, topic_id, decision_id, parent_id, title, details, status, status_note,
                   version, sort_order, origin, severity,
                   created_by_actor_id, created_by_snapshot_json,
                   updated_by_actor_id, updated_by_snapshot_json,
                   created_at, updated_at, completed_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, 'pending', NULL,
                   1, ?7, ?8, NULL,
                   ?9, ?10, ?11, ?12, ?13, ?14, NULL
                 )",
                params![
                    id,
                    input.topic_id,
                    decision_id,
                    input.parent_id,
                    title,
                    details,
                    sort_order,
                    // 桌面端只做手工拆解；审核发现由服务端解析评审尾块写入。
                    WorkItemOrigin::Manual.as_db(),
                    actor.id,
                    actor.snapshot_json,
                    actor.id,
                    actor.snapshot_json,
                    now,
                    now,
                ],
            )?;
            created_ids.push(id);
            sort_order += 1;
        }
        if let Some(parent_id) = input.parent_id.as_deref() {
            // 新子任务会把一个已完成的父任务重新拉回进行中，这一步不能省。
            recompute_ancestors(
                &transaction,
                parent_id,
                &actor.id,
                &actor.snapshot_json,
                &now,
            )?;
        }
        transaction.execute(
            "UPDATE topics SET updated_at = ?1 WHERE id = ?2",
            params![now, input.topic_id],
        )?;
        transaction.commit()?;
        created_ids
            .into_iter()
            .map(|id| self.require_work_item(&id, &input.topic_id))
            .collect()
    }

    pub fn update_work_item(&mut self, input: UpdateWorkItemInput) -> CouncilResult<WorkItem> {
        self.require_topic(&input.topic_id)?;
        let actor = self.resolve_active_actor(&input.actor_alias)?;
        let current = self.require_work_item(&input.work_item_id, &input.topic_id)?;
        if current.version != input.expected_version {
            return Err(CouncilError::Conflict(
                "实施项已被其他参与者更新，请刷新后重试。".into(),
            ));
        }
        if self.has_children(&input.work_item_id)? {
            return Err(CouncilError::Conflict(
                "这是一个父任务，状态由子任务派生；请更新它的子任务。".into(),
            ));
        }
        let now = now_iso();
        let status_note = match input.status_note {
            Some(note) => {
                let trimmed = note.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            None => current.status_note,
        };
        let fix_commit = match input.fix_commit {
            Some(commit) => {
                let trimmed = commit.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            None => current.fix_commit,
        };
        let completed_at = if input.status == WorkItemStatus::Completed {
            current.completed_at.or_else(|| Some(now.clone()))
        } else {
            None
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE work_items SET status = ?1, status_note = ?2, fix_commit = ?3,
               version = version + 1,
               updated_by_actor_id = ?4, updated_by_snapshot_json = ?5,
               updated_at = ?6, completed_at = ?7
             WHERE id = ?8 AND topic_id = ?9 AND version = ?10",
            params![
                input.status.as_db(),
                status_note,
                fix_commit,
                actor.id,
                actor.snapshot_json,
                now,
                completed_at,
                input.work_item_id,
                input.topic_id,
                input.expected_version,
            ],
        )?;
        if changed != 1 {
            return Err(CouncilError::Conflict(
                "实施项已被其他参与者更新，请刷新后重试。".into(),
            ));
        }
        if let Some(parent_id) = current.parent_id.as_deref() {
            recompute_ancestors(
                &transaction,
                parent_id,
                &actor.id,
                &actor.snapshot_json,
                &now,
            )?;
        }
        transaction.execute(
            "UPDATE topics SET updated_at = ?1 WHERE id = ?2",
            params![now, input.topic_id],
        )?;
        transaction.commit()?;
        self.require_work_item(&input.work_item_id, &input.topic_id)
    }

    /// 认领一条待办：写上执行者并置为进行中。
    /// 这是「谁正在做哪一条」唯一可信的来源——执行方开工前必须先在账本上签名，
    /// 否则用户只看得到一个跑了很久却不知道在干什么的 Agent。
    pub fn claim_work_item(&mut self, input: ClaimWorkItemInput) -> CouncilResult<WorkItem> {
        self.require_topic(&input.topic_id)?;
        let actor = self.resolve_active_actor(&input.actor_alias)?;
        let current = self.require_work_item(&input.work_item_id, &input.topic_id)?;
        if current.version != input.expected_version {
            return Err(CouncilError::Conflict(
                "实施项已被其他参与者更新，请刷新后重试。".into(),
            ));
        }
        if self.has_children(&input.work_item_id)? {
            return Err(CouncilError::Conflict(
                "父任务不能被认领；请认领它的子任务。".into(),
            ));
        }
        if current.status == WorkItemStatus::Completed {
            return Err(CouncilError::Conflict(
                "这条实施项已经完成，无需认领。".into(),
            ));
        }
        let now = now_iso();
        let status_note = match input.status_note {
            Some(note) => {
                let trimmed = note.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            None => current.status_note,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE work_items SET status = 'in_progress', status_note = ?1,
               version = version + 1, assignee_actor_id = ?2, claimed_at = ?3,
               updated_by_actor_id = ?4, updated_by_snapshot_json = ?5,
               updated_at = ?6, completed_at = NULL
             WHERE id = ?7 AND topic_id = ?8 AND version = ?9",
            params![
                status_note,
                actor.id,
                now,
                actor.id,
                actor.snapshot_json,
                now,
                input.work_item_id,
                input.topic_id,
                input.expected_version,
            ],
        )?;
        if changed != 1 {
            return Err(CouncilError::Conflict(
                "实施项已被其他参与者更新，请刷新后重试。".into(),
            ));
        }
        if let Some(parent_id) = current.parent_id.as_deref() {
            recompute_ancestors(
                &transaction,
                parent_id,
                &actor.id,
                &actor.snapshot_json,
                &now,
            )?;
        }
        transaction.execute(
            "UPDATE topics SET updated_at = ?1 WHERE id = ?2",
            params![now, input.topic_id],
        )?;
        transaction.commit()?;
        self.require_work_item(&input.work_item_id, &input.topic_id)
    }

    fn has_children(&self, work_item_id: &str) -> CouncilResult<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_items WHERE parent_id = ?1)",
            params![work_item_id],
            |row| row.get(0),
        )?)
    }

    fn require_accepted_decision_id(
        &self,
        topic_id: &str,
        decision_id: Option<&str>,
    ) -> CouncilResult<String> {
        let decision = if let Some(decision_id) = decision_id {
            self.connection
                .query_row(
                    "SELECT id, status FROM decisions WHERE id = ?1 AND topic_id = ?2",
                    params![decision_id, topic_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
        } else {
            self.connection
                .query_row(
                    "SELECT id, status FROM decisions \
                     WHERE topic_id = ?1 AND status = 'accepted' \
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    params![topic_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
        };
        let Some((decision_id, decision_status)) = decision else {
            return Err(CouncilError::NotFound(
                "当前议题没有可绑定的 Accepted 决策。".into(),
            ));
        };
        if decision_status != "accepted" {
            return Err(CouncilError::Conflict(
                "实施项只能绑定 Accepted 决策。".into(),
            ));
        }
        Ok(decision_id)
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

    fn require_work_item(&self, id: &str, topic_id: &str) -> CouncilResult<WorkItem> {
        let row = self
            .connection
            .query_row(
                &format!(
                    "SELECT {WORK_ITEM_SELECT_COLUMNS} FROM work_items \
                     WHERE id = ?1 AND topic_id = ?2"
                ),
                params![id, topic_id],
                read_work_item_row,
            )
            .optional()?;
        match row {
            Some(row) => work_item_from_row(row),
            None => Err(CouncilError::NotFound(format!("实施项 {id} 不存在。"))),
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

fn read_work_item_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkItemRow> {
    Ok(WorkItemRow {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        decision_id: row.get(2)?,
        title: row.get(3)?,
        details: row.get(4)?,
        status: row.get(5)?,
        status_note: row.get(6)?,
        version: row.get(7)?,
        created_by_actor_id: row.get(8)?,
        created_by_snapshot_json: row.get(9)?,
        updated_by_actor_id: row.get(10)?,
        updated_by_snapshot_json: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        completed_at: row.get(14)?,
        parent_id: row.get(15)?,
        sort_order: row.get(16)?,
        origin: row.get(17)?,
        severity: row.get(18)?,
        source_message_id: row.get(19)?,
        source_cycle_id: row.get(20)?,
        review_round: row.get(21)?,
        fix_commit: row.get(22)?,
        assignee_actor_id: row.get(23)?,
        claimed_at: row.get(24)?,
    })
}

/// 父任务状态的派生规则。顺序即优先级：
/// 有子任务受阻就是受阻（先解依赖），全部完成才算完成，
/// 只要有人动过（进行中或已完成一部分）就是进行中，否则待处理。
fn derive_parent_status(child_statuses: &[String]) -> WorkItemStatus {
    if child_statuses.iter().any(|status| status == "blocked") {
        return WorkItemStatus::Blocked;
    }
    if child_statuses.iter().all(|status| status == "completed") {
        return WorkItemStatus::Completed;
    }
    if child_statuses
        .iter()
        .any(|status| status == "in_progress" || status == "completed")
    {
        return WorkItemStatus::InProgress;
    }
    WorkItemStatus::Pending
}

/// 父任务状态完全由子任务派生，任何一条写入路径都不接受手动设置。
/// 允许手动改父状态，就等于允许「父已完成、子未完成」这种自相矛盾的账本，
/// Agent 也会直接把父节点标完成来跳过实际交付。
fn recompute_ancestors(
    transaction: &Transaction<'_>,
    from_work_item_id: &str,
    actor_id: &str,
    actor_snapshot_json: &str,
    now: &str,
) -> CouncilResult<()> {
    let mut cursor = Some(from_work_item_id.to_string());
    let mut visited = std::collections::HashSet::new();
    while let Some(current_id) = cursor {
        if !visited.insert(current_id.clone()) {
            return Err(CouncilError::Conflict(
                "实施项父子关系存在环，已停止派生。".into(),
            ));
        }
        let current = transaction
            .query_row(
                "SELECT status, completed_at, parent_id FROM work_items WHERE id = ?1",
                params![current_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((status, completed_at, parent_id)) = current else {
            return Ok(());
        };
        let child_statuses = {
            let mut statement =
                transaction.prepare("SELECT status FROM work_items WHERE parent_id = ?1")?;
            statement
                .query_map(params![current_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        if !child_statuses.is_empty() {
            let derived = derive_parent_status(&child_statuses);
            if derived.as_db() != status {
                let derived_completed_at = if derived == WorkItemStatus::Completed {
                    completed_at.or_else(|| Some(now.to_string()))
                } else {
                    None
                };
                transaction.execute(
                    "UPDATE work_items SET status = ?1, version = version + 1,
                       updated_by_actor_id = ?2, updated_by_snapshot_json = ?3,
                       updated_at = ?4, completed_at = ?5
                     WHERE id = ?6",
                    params![
                        derived.as_db(),
                        actor_id,
                        actor_snapshot_json,
                        now,
                        derived_completed_at,
                        current_id,
                    ],
                )?;
            }
        }
        cursor = parent_id;
    }
    Ok(())
}

/// 只统计叶子节点：父任务的状态本来就是子任务汇总出来的，
/// 再把它计入分母等于同一件事数两次，界面上的「12 / 15」会凭空变大。
fn read_work_item_progress(
    connection: &Connection,
    topic_ids: &[String],
) -> CouncilResult<std::collections::HashMap<String, WorkItemProgress>> {
    let mut progress = std::collections::HashMap::new();
    if topic_ids.is_empty() {
        return Ok(progress);
    }
    let placeholders = (1..=topic_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut statement = connection.prepare(&format!(
        "SELECT topic_id, COUNT(*),
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END),
           SUM(
             CASE
               WHEN origin = 'review_finding'
                 AND severity = 'blocking'
                 AND status <> 'completed'
               THEN 1 ELSE 0
             END
           )
         FROM work_items AS item
         WHERE topic_id IN ({placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM work_items AS child WHERE child.parent_id = item.id
           )
         GROUP BY topic_id"
    ))?;
    let parameters = rusqlite::params_from_iter(topic_ids.iter());
    let rows = statement
        .query_map(parameters, |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (topic_id, total, completed, blocked, open_blocking) in rows {
        progress.insert(
            topic_id,
            WorkItemProgress {
                total: non_negative(total, "work item total")?,
                completed: non_negative(completed, "work item completed")?,
                blocked: non_negative(blocked, "work item blocked")?,
                open_blocking_findings: non_negative(open_blocking, "open blocking findings")?,
            },
        );
    }
    Ok(progress)
}

/// 与 read_work_item_progress 的 SQL 同口径：只数叶子。两处必须一起改。
fn summarize_work_item_progress(work_items: &[WorkItem]) -> Option<WorkItemProgress> {
    let parent_ids = work_items
        .iter()
        .filter_map(|item| item.parent_id.clone())
        .collect::<std::collections::HashSet<_>>();
    let leaves = work_items
        .iter()
        .filter(|item| !parent_ids.contains(&item.id))
        .collect::<Vec<_>>();
    if leaves.is_empty() {
        return None;
    }
    Some(WorkItemProgress {
        total: leaves.len() as u64,
        completed: leaves
            .iter()
            .filter(|item| item.status == WorkItemStatus::Completed)
            .count() as u64,
        blocked: leaves
            .iter()
            .filter(|item| item.status == WorkItemStatus::Blocked)
            .count() as u64,
        open_blocking_findings: leaves
            .iter()
            .filter(|item| {
                item.origin == WorkItemOrigin::ReviewFinding
                    && item.severity == Some(WorkItemSeverity::Blocking)
                    && item.status != WorkItemStatus::Completed
            })
            .count() as u64,
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
        // 完成度是查询侧聚合出来的，行映射本身不认识它。
        work_item_progress: None,
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

fn work_item_from_row(row: WorkItemRow) -> CouncilResult<WorkItem> {
    let created_by_snapshot =
        parse_actor_snapshot(&row.created_by_snapshot_json, &row.created_by_actor_id)?;
    let updated_by_snapshot =
        parse_actor_snapshot(&row.updated_by_snapshot_json, &row.updated_by_actor_id)?;
    let version = u32::try_from(row.version)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| CouncilError::InvalidData("实施项 version 无效。".into()))?;
    let origin = WorkItemOrigin::from_db(&row.origin).ok_or_else(|| {
        CouncilError::InvalidData(format!("未知 WorkItem origin：{}", row.origin))
    })?;
    let severity = match row.severity.as_deref().filter(|value| !value.is_empty()) {
        Some(value) => Some(WorkItemSeverity::from_db(value).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 WorkItem severity：{value}"))
        })?),
        None => None,
    };
    Ok(WorkItem {
        id: row.id,
        topic_id: row.topic_id,
        decision_id: row.decision_id.filter(|value| !value.is_empty()),
        parent_id: row.parent_id.filter(|value| !value.is_empty()),
        title: row.title,
        details: row.details,
        status: WorkItemStatus::from_db(&row.status).ok_or_else(|| {
            CouncilError::InvalidData(format!("未知 WorkItem status：{}", row.status))
        })?,
        status_note: row.status_note.filter(|value| !value.is_empty()),
        version,
        sort_order: row.sort_order,
        origin,
        severity,
        source_message_id: row.source_message_id.filter(|value| !value.is_empty()),
        source_cycle_id: row.source_cycle_id.filter(|value| !value.is_empty()),
        review_round: row.review_round,
        fix_commit: row.fix_commit.filter(|value| !value.is_empty()),
        assignee_actor_id: row.assignee_actor_id.filter(|value| !value.is_empty()),
        claimed_at: row.claimed_at.filter(|value| !value.is_empty()),
        created_by_actor_id: row.created_by_actor_id,
        created_by_snapshot,
        updated_by_actor_id: row.updated_by_actor_id,
        updated_by_snapshot,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at.filter(|value| !value.is_empty()),
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
