//! @input 依赖：临时 SQLite 文件、CouncilStore 和真实 Node schema 迁移器
//! @output 导出：Node fresh/v2/v3/v5/v10→v16、议题关闭、Agent 委派/决策包/实施项树、RuntimeBinding schema、分页、revision 与版本拒绝测试
//! @pos Rust 内容核心只消费 Node 实际迁移 council.sqlite3 的跨语言回归证据
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use council_core::{
    AcceptDecisionsInput, ClaimWorkItemInput, CloseTopicInput, CouncilError, CouncilRevisions,
    CouncilStore, CreateTopicInput, CreateWorkItemEntry, CreateWorkItemsInput, DecisionStatus,
    MessageKind, PostMessageInput, RecordDecisionInput, TopicStatus, UpdateWorkItemInput,
    WorkItemProgress, WorkItemStatus,
};
use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use tempfile::tempdir;

const HUMAN_ALIAS: &str = "human";
const CLAUDE_ALIAS: &str = "claude";
const CODEX_ALIAS: &str = "codex";

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("workspace root")
}

fn ensure_node_migrator_built() {
    static NODE_BUILD: OnceLock<()> = OnceLock::new();
    NODE_BUILD.get_or_init(|| {
        let status = Command::new("npm")
            .args(["run", "build", "--prefix", "packages/mcp-server"])
            .current_dir(workspace_root())
            .status()
            .expect("build Node migrator");
        assert!(status.success(), "Node migrator build must succeed");
    });
}

fn prepare_node_schema_with_mode(database_path: &Path, mode: &str) {
    ensure_node_migrator_built();
    let status = Command::new("node")
        .arg("packages/mcp-server/scripts/create-rust-test-database.mjs")
        .arg(mode)
        .arg(database_path)
        .current_dir(workspace_root())
        .status()
        .expect("run Node database generator");
    assert!(status.success(), "Node database generator must succeed");
}

fn prepare_node_schema(database_path: &Path) {
    prepare_node_schema_with_mode(database_path, "fresh");
}

fn topic_input(title: &str, project_path: &str, created_by_alias: &str) -> CreateTopicInput {
    CreateTopicInput {
        title: title.into(),
        question: "如何保持兼容？".into(),
        constraints: vec!["必须可回滚".into()],
        project_path: Some(project_path.into()),
        created_by_alias: created_by_alias.into(),
    }
}

#[test]
fn preserves_content_pagination_decision_and_revision_semantics() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    prepare_node_schema(&database_path);
    let mut store = CouncilStore::open(&database_path, 5_000).expect("store should open");
    assert_eq!(
        store.get_revisions().expect("initial revisions"),
        CouncilRevisions {
            total: 0,
            content: 0,
            orchestration: 0,
        }
    );

    let topic = store
        .create_topic(topic_input(
            "共享内容存储",
            "/workspace/project-alpha",
            HUMAN_ALIAS,
        ))
        .expect("topic should be created");
    assert!(topic.id.starts_with("topic_"));
    assert_eq!(topic.created_by_actor_id, "human");
    assert_eq!(topic.created_by_snapshot.display_name, "User");
    assert_eq!(store.get_revisions().expect("topic revision").total, 1);

    let first = store
        .post_message(PostMessageInput {
            topic_id: topic.id.clone(),
            actor_alias: CLAUDE_ALIAS.into(),
            kind: MessageKind::Proposal,
            content: "采用兼容 schema。".into(),
            parent_message_id: None,
        })
        .expect("first message");
    let second = store
        .post_message(PostMessageInput {
            topic_id: topic.id.clone(),
            actor_alias: CODEX_ALIAS.into(),
            kind: MessageKind::Critique,
            content: "还需要验证分页顺序。".into(),
            parent_message_id: Some(first.id.clone()),
        })
        .expect("second message");
    assert_eq!(first.actor_id, "claude");
    assert_eq!(second.actor_id, "codex");
    assert_eq!(store.get_revisions().expect("message revisions").total, 5);

    let latest = store.get_topic(&topic.id, 1, 0).expect("latest page");
    assert_eq!(latest.message_total, 2);
    assert_eq!(latest.messages[0].id, second.id);
    assert!(latest.has_more_messages);
    assert_eq!(latest.next_message_offset, Some(1));
    let older = store.get_topic(&topic.id, 1, 1).expect("older page");
    assert_eq!(older.messages[0].id, first.id);
    assert!(!older.has_more_messages);
    assert_eq!(older.next_message_offset, None);

    let decision = store
        .record_decision(RecordDecisionInput {
            topic_id: topic.id.clone(),
            title: "保持兼容表结构".into(),
            decision: "Rust 和 TypeScript 共用同一 SQLite 文件。".into(),
            rationale: "允许渐进迁移。".into(),
            alternatives: vec!["创建第二份数据库".into()],
            status: DecisionStatus::Accepted,
            created_by_alias: HUMAN_ALIAS.into(),
        })
        .expect("decision should be recorded");
    assert_eq!(decision.status, DecisionStatus::Accepted);
    assert_eq!(decision.created_by_actor_id, "human");
    let decided = store.get_topic(&topic.id, 20, 0).expect("decided topic");
    assert_eq!(decided.topic.status, TopicStatus::Decided);
    assert_eq!(decided.decisions, vec![decision]);
    assert_eq!(store.get_revisions().expect("decision revisions").total, 7);

    let work_items = store
        .create_work_items(CreateWorkItemsInput {
            topic_id: topic.id.clone(),
            decision_id: None,
            parent_id: None,
            items: vec![
                CreateWorkItemEntry {
                    title: "实现跨语言读写".into(),
                    details: "验证冻结 Actor".into(),
                },
                CreateWorkItemEntry {
                    title: "补齐并发测试".into(),
                    details: String::new(),
                },
            ],
            actor_alias: CODEX_ALIAS.into(),
        })
        .expect("work items should be created");
    assert_eq!(work_items.len(), 2);
    assert_eq!(work_items[0].status, WorkItemStatus::Pending);
    let completed = store
        .update_work_item(UpdateWorkItemInput {
            topic_id: topic.id.clone(),
            work_item_id: work_items[0].id.clone(),
            status: WorkItemStatus::Completed,
            status_note: Some("Rust 验证通过。".into()),
            fix_commit: None,
            expected_version: 1,
            actor_alias: CLAUDE_ALIAS.into(),
        })
        .expect("work item should update");
    assert_eq!(completed.version, 2);
    assert_eq!(completed.updated_by_actor_id, "claude");
    assert!(completed.completed_at.is_some());
    assert!(matches!(
        store.update_work_item(UpdateWorkItemInput {
            topic_id: topic.id.clone(),
            work_item_id: completed.id.clone(),
            status: WorkItemStatus::Blocked,
            status_note: None,
            fix_commit: None,
            expected_version: 1,
            actor_alias: CODEX_ALIAS.into(),
        }),
        Err(CouncilError::Conflict(_))
    ));
    assert_eq!(
        store
            .get_topic(&topic.id, 20, 0)
            .expect("topic with work items")
            .work_items
            .len(),
        2
    );

    // ---- 实施项树：父状态只能由子任务派生 ----
    let parent = work_items[1].clone();
    let children = store
        .create_work_items(CreateWorkItemsInput {
            topic_id: topic.id.clone(),
            decision_id: None,
            parent_id: Some(parent.id.clone()),
            items: vec![
                CreateWorkItemEntry {
                    title: "写并发用例".into(),
                    details: String::new(),
                },
                CreateWorkItemEntry {
                    title: "跑一遍 CI".into(),
                    details: String::new(),
                },
            ],
            actor_alias: CODEX_ALIAS.into(),
        })
        .expect("child work items should be created");
    assert_eq!(children.len(), 2);
    assert_eq!(children[0].parent_id.as_deref(), Some(parent.id.as_str()));
    // 子任务继承父任务的决策锚点，一棵树不横跨两个 ADR。
    assert_eq!(children[0].decision_id, parent.decision_id);
    assert_eq!(children[0].sort_order, 0);
    assert_eq!(children[1].sort_order, 1);

    // 父任务不接受手动改状态，只能改它的子任务。
    assert!(matches!(
        store.update_work_item(UpdateWorkItemInput {
            topic_id: topic.id.clone(),
            work_item_id: parent.id.clone(),
            status: WorkItemStatus::Completed,
            status_note: None,
            fix_commit: None,
            expected_version: 1,
            actor_alias: CODEX_ALIAS.into(),
        }),
        Err(CouncilError::Conflict(_))
    ));

    // 认领一条子任务：父任务随之进入进行中。
    let claimed = store
        .claim_work_item(ClaimWorkItemInput {
            topic_id: topic.id.clone(),
            work_item_id: children[0].id.clone(),
            status_note: Some("先补并发用例。".into()),
            expected_version: children[0].version,
            actor_alias: CLAUDE_ALIAS.into(),
        })
        .expect("child should be claimable");
    assert_eq!(claimed.status, WorkItemStatus::InProgress);
    assert_eq!(claimed.assignee_actor_id.as_deref(), Some("claude"));
    assert!(claimed.claimed_at.is_some());
    let detail = store
        .get_topic(&topic.id, 20, 0)
        .expect("detail after claim");
    let reloaded_parent = detail
        .work_items
        .iter()
        .find(|item| item.id == parent.id)
        .expect("parent still present");
    assert_eq!(reloaded_parent.status, WorkItemStatus::InProgress);

    // 父任务不能被认领——认领的对象只能是叶子。
    assert!(matches!(
        store.claim_work_item(ClaimWorkItemInput {
            topic_id: topic.id.clone(),
            work_item_id: parent.id.clone(),
            status_note: None,
            expected_version: reloaded_parent.version,
            actor_alias: CODEX_ALIAS.into(),
        }),
        Err(CouncilError::Conflict(_))
    ));

    // 子任务全部完成后，父任务自动结算为完成。
    for child in &children {
        let current = store
            .get_topic(&topic.id, 20, 0)
            .expect("detail before completing child")
            .work_items
            .iter()
            .find(|item| item.id == child.id)
            .cloned()
            .expect("child present");
        store
            .update_work_item(UpdateWorkItemInput {
                topic_id: topic.id.clone(),
                work_item_id: child.id.clone(),
                status: WorkItemStatus::Completed,
                status_note: None,
                fix_commit: Some("abc1234".into()),
                expected_version: current.version,
                actor_alias: CLAUDE_ALIAS.into(),
            })
            .expect("child should complete");
    }
    let settled = store
        .get_topic(&topic.id, 20, 0)
        .expect("detail after children done");
    let settled_parent = settled
        .work_items
        .iter()
        .find(|item| item.id == parent.id)
        .expect("parent present");
    assert_eq!(settled_parent.status, WorkItemStatus::Completed);
    assert!(settled_parent.completed_at.is_some());

    // 完成度只数叶子：两条子任务加上最初那条独立任务，父任务不计入分母。
    assert_eq!(
        settled.topic.work_item_progress,
        Some(WorkItemProgress {
            total: 3,
            completed: 3,
            blocked: 0,
            open_blocking_findings: 0,
        })
    );
    // 列表查询同样带出完成度，议题导航不必为此拉取详情。
    let listed = store
        .list_topics(None, 20, 0)
        .expect("topics with progress");
    assert_eq!(
        listed
            .topics
            .iter()
            .find(|item| item.id == topic.id)
            .and_then(|item| item.work_item_progress),
        settled.topic.work_item_progress,
    );

    let kimi_topic = store
        .create_topic(topic_input(
            "其他项目",
            "/workspace/project-beta",
            CLAUDE_ALIAS,
        ))
        .expect("Kimi topic");
    assert_eq!(kimi_topic.created_by_actor_id, "claude");
    let page = store
        .list_topics(Some("/workspace/project-alpha"), 10, 0)
        .expect("filtered topics");
    assert_eq!(page.total, 1);
    assert_eq!(page.count, 1);
    assert_eq!(page.topics[0].id, topic.id);
    assert!(!page.has_more);

    let closed = store
        .close_topic(CloseTopicInput {
            topic_id: kimi_topic.id.clone(),
            actor_alias: HUMAN_ALIAS.into(),
        })
        .expect("idle topic should close");
    assert_eq!(closed.status, TopicStatus::Closed);
    assert_eq!(
        store
            .get_topic(&kimi_topic.id, 20, 0)
            .expect("closed topic remains readable")
            .topic
            .title,
        "其他项目",
    );
}

#[test]
fn accepts_each_decision_in_place_and_only_closes_after_the_package_is_complete() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("decision-package.sqlite3");
    prepare_node_schema(&database_path);
    let mut store = CouncilStore::open(&database_path, 5_000).expect("store should open");
    let topic = store
        .create_topic(topic_input(
            "多决策包",
            "/workspace/project-alpha",
            HUMAN_ALIAS,
        ))
        .expect("topic should be created");
    let first = store
        .record_decision(RecordDecisionInput {
            topic_id: topic.id.clone(),
            title: "第一项".into(),
            decision: "先稳定协议。".into(),
            rationale: "降低耦合。".into(),
            alternatives: Vec::new(),
            status: DecisionStatus::Proposed,
            created_by_alias: CLAUDE_ALIAS.into(),
        })
        .expect("first proposal");
    let second = store
        .record_decision(RecordDecisionInput {
            topic_id: topic.id.clone(),
            title: "第二项".into(),
            decision: "再补齐观测。".into(),
            rationale: "保留故障证据。".into(),
            alternatives: Vec::new(),
            status: DecisionStatus::Proposed,
            created_by_alias: CODEX_ALIAS.into(),
        })
        .expect("second proposal");

    let accepted_first = store
        .accept_decisions(AcceptDecisionsInput {
            topic_id: topic.id.clone(),
            decision_ids: vec![first.id.clone()],
            actor_alias: HUMAN_ALIAS.into(),
        })
        .expect("first proposal accepted");
    assert_eq!(accepted_first[0].id, first.id);
    assert_eq!(accepted_first[0].status, DecisionStatus::Accepted);
    let partially_accepted = store.get_topic(&topic.id, 20, 0).expect("partial package");
    assert_eq!(partially_accepted.topic.status, TopicStatus::Open);
    assert_eq!(partially_accepted.decisions.len(), 2);
    assert_eq!(
        partially_accepted
            .decisions
            .iter()
            .find(|decision| decision.id == second.id)
            .expect("second decision")
            .status,
        DecisionStatus::Proposed,
    );

    store
        .accept_decisions(AcceptDecisionsInput {
            topic_id: topic.id.clone(),
            decision_ids: vec![second.id.clone()],
            actor_alias: HUMAN_ALIAS.into(),
        })
        .expect("second proposal accepted");
    assert_eq!(
        store
            .get_topic(&topic.id, 20, 0)
            .expect("complete package")
            .topic
            .status,
        TopicStatus::Decided,
    );

    let replay = store
        .accept_decisions(AcceptDecisionsInput {
            topic_id: topic.id,
            decision_ids: vec![first.id.clone()],
            actor_alias: HUMAN_ALIAS.into(),
        })
        .expect("accepted replay should be idempotent");
    assert_eq!(replay[0].id, first.id);
}

#[test]
fn opens_node_current_schema_and_preserves_cross_language_identity() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("node-current.sqlite3");
    prepare_node_schema(&database_path);
    let raw = Connection::open(&database_path).expect("inspection connection");
    let (user_version, binding_tables, binding_triggers): (i64, i64, i64) = (
        raw.query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user version"),
        raw.query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table'
               AND name IN (
                 'runtime_bindings',
                 'runtime_binding_leases',
                 'runtime_binding_requests'
               )",
            [],
            |row| row.get(0),
        )
        .expect("binding tables"),
        raw.query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'trg_%runtime_%'",
            [],
            |row| row.get(0),
        )
        .expect("binding triggers"),
    );
    assert_eq!(user_version, 16);
    assert_eq!(binding_tables, 3);
    assert_eq!(binding_triggers, 7); // 含审计追加 revision 与禁止覆盖触发器。
    drop(raw);

    let mut store =
        CouncilStore::open(&database_path, 5_000).expect("Rust opens Node current schema");
    let topic = store
        .create_topic(topic_input(
            "Node 当前 schema 到 Rust",
            "/workspace/project-alpha",
            HUMAN_ALIAS,
        ))
        .expect("Rust write");
    let raw = Connection::open(&database_path).expect("Node-compatible read");
    let (actor_id, snapshot_actor_id): (String, String) = raw
        .query_row(
            "SELECT created_by_actor_id,
                    json_extract(created_by_snapshot_json, '$.actorId')
             FROM topics WHERE id = ?1",
            [&topic.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read Rust write");
    assert_eq!(actor_id, "human");
    assert_eq!(snapshot_actor_id, "human");
}

#[test]
fn rejects_runtime_request_ledger_without_logical_uniqueness() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("invalid-request-ledger.sqlite3");
    prepare_node_schema(&database_path);
    Connection::open(&database_path)
        .expect("inspection connection")
        .execute_batch(
            "DROP TABLE runtime_binding_requests;
             CREATE TABLE runtime_binding_requests (
               topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
               agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
               request_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
               consumed_at TEXT NOT NULL
             );",
        )
        .expect("corrupt logical request ledger");

    assert!(matches!(
        CouncilStore::open(&database_path, 5_000),
        Err(CouncilError::InvalidData(_))
    ));
}

#[test]
fn rejects_unknown_and_review_only_actor_aliases_for_new_writes() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    prepare_node_schema(&database_path);
    let mut store = CouncilStore::open(&database_path, 5_000).expect("store should open");

    for alias in ["unknown-provider", "other", "legacy-unknown"] {
        let result =
            store.create_topic(topic_input("无效 Actor", "/workspace/project-alpha", alias));
        assert!(matches!(result, Err(CouncilError::InvalidData(_))));
    }
}

#[test]
fn rejects_actor_snapshot_that_disagrees_with_indexed_actor() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    prepare_node_schema(&database_path);
    let raw = Connection::open(&database_path).expect("raw connection");
    raw.execute(
        "INSERT INTO topics (
           id, title, question, constraints_json, project_path, status,
           created_by_actor_id, created_by_snapshot_json, created_by_legacy,
           created_at, updated_at
         ) VALUES (
           'topic_snapshot_mismatch', 'mismatch', 'mismatch', '[]', NULL, 'open',
           'human',
           '{\"schemaVersion\":1,\"actorId\":\"codex\",\"slug\":\"codex\",\"displayName\":\"Codex\",\"shortName\":\"CX\",\"role\":\"代码审查\"}',
           NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
         )",
        [],
    )
    .expect("insert mismatch fixture");
    drop(raw);

    let store = CouncilStore::open(&database_path, 5_000).expect("store should open");
    assert!(matches!(
        store.get_topic("topic_snapshot_mismatch", 20, 0),
        Err(CouncilError::InvalidData(_))
    ));
}

#[test]
fn shares_writes_across_connections_and_enforces_domain_conflicts() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    prepare_node_schema(&database_path);
    let mut first_store = CouncilStore::open(&database_path, 5_000).expect("first store");
    let mut second_store = CouncilStore::open(&database_path, 5_000).expect("second store");
    let first_topic = first_store
        .create_topic(topic_input(
            "双连接共享",
            "/workspace/project-alpha",
            CLAUDE_ALIAS,
        ))
        .expect("first topic");
    let second_topic = first_store
        .create_topic(topic_input(
            "父消息边界",
            "/workspace/project-alpha",
            HUMAN_ALIAS,
        ))
        .expect("second topic");
    let parent = first_store
        .post_message(PostMessageInput {
            topic_id: first_topic.id.clone(),
            actor_alias: HUMAN_ALIAS.into(),
            kind: MessageKind::Note,
            content: "父消息".into(),
            parent_message_id: None,
        })
        .expect("parent message");

    assert_eq!(
        second_store
            .get_topic(&first_topic.id, 20, 0)
            .expect("second connection read")
            .topic
            .title,
        "双连接共享"
    );
    second_store
        .post_message(PostMessageInput {
            topic_id: first_topic.id.clone(),
            actor_alias: CODEX_ALIAS.into(),
            kind: MessageKind::Critique,
            content: "第二连接写回。".into(),
            parent_message_id: Some(parent.id.clone()),
        })
        .expect("cross-connection reply");
    assert_eq!(
        first_store
            .get_topic(&first_topic.id, 20, 0)
            .expect("first connection reread")
            .messages
            .len(),
        2
    );

    let wrong_topic_parent = second_store.post_message(PostMessageInput {
        topic_id: second_topic.id.clone(),
        actor_alias: HUMAN_ALIAS.into(),
        kind: MessageKind::Note,
        content: "错误父消息".into(),
        parent_message_id: Some(parent.id),
    });
    assert!(matches!(wrong_topic_parent, Err(CouncilError::Conflict(_))));

    let agent_accept = second_store.record_decision(RecordDecisionInput {
        topic_id: second_topic.id,
        title: "无效确认".into(),
        decision: "Agent 不能直接接受。".into(),
        rationale: "需要用户确认。".into(),
        alternatives: Vec::new(),
        status: DecisionStatus::Accepted,
        created_by_alias: CLAUDE_ALIAS.into(),
    });
    assert!(matches!(agent_accept, Err(CouncilError::Conflict(_))));
}

#[test]
fn reopens_node_migrated_fields_without_rewriting_orchestration_revision() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    let topic_id = "topic_existing_typescript_fixture";
    prepare_node_schema_with_mode(&database_path, "v2-migrated");
    let raw = Connection::open(&database_path).expect("raw connection");
    let snapshot = r#"{"schemaVersion":1,"actorId":"human","slug":"human","displayName":"User","shortName":"U","role":"决策者"}"#;
    raw.execute(
        "INSERT INTO topics (
           id, title, question, constraints_json, project_path, status,
           created_by_actor_id, created_by_snapshot_json, created_by_legacy,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'open', 'human', ?6, NULL, ?7, ?8)",
        params![
            topic_id,
            "旧库兼容",
            "Rust 能否读取现有字段？",
            "{invalid-json",
            "/workspace/project-alpha",
            snapshot,
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        ],
    )
    .expect("insert TypeScript-compatible topic fixture");
    raw.execute(
        "UPDATE council_meta SET value = 48 WHERE key = 'revision'",
        [],
    )
    .expect("set total revision");
    raw.execute(
        "UPDATE council_meta SET value = 7 WHERE key = 'content_revision'",
        [],
    )
    .expect("set content revision");
    raw.execute(
        "UPDATE council_meta SET value = 41 WHERE key = 'orchestration_revision'",
        [],
    )
    .expect("set orchestration revision");
    let raw_actor_id: String = raw
        .query_row(
            "SELECT created_by_actor_id FROM topics WHERE id = ?1",
            params![topic_id],
            |row| row.get(0),
        )
        .expect("raw topic actor");
    assert_eq!(raw_actor_id, "human");
    drop(raw);

    let store = CouncilStore::open(&database_path, 5_000).expect("reopened store");
    let detail = store.get_topic(topic_id, 20, 0).expect("legacy topic");
    assert!(detail.topic.constraints.is_empty());
    assert_eq!(detail.topic.created_by_snapshot.actor_id, "human");
    assert_eq!(
        store.get_revisions().expect("preserved revisions"),
        CouncilRevisions {
            total: 48,
            content: 7,
            orchestration: 41,
        }
    );
    let trigger_count: i64 = Connection::open(&database_path)
        .expect("inspection connection")
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' \
             AND name LIKE 'trg_%_revision_%'",
            [],
            |row| row.get(0),
        )
        .expect("trigger count");
    // v7 为 cycle/question 各加 3 个，v11 为实施项、v14 为 Agent 委派各增加 3 个 revision 触发器。
    assert_eq!(trigger_count, 28);
}

#[test]
fn opens_fresh_v2_v3_and_v5_migrated_databases_created_by_node() {
    let directory = tempdir().expect("temp directory");

    for mode in ["fresh", "v2-migrated", "v3-migrated", "v5-migrated"] {
        let database_path = directory.path().join(format!("{mode}.sqlite3"));
        prepare_node_schema_with_mode(&database_path, mode);
        CouncilStore::open(&database_path, 5_000)
            .unwrap_or_else(|error| panic!("Rust must open Node {mode} database: {error}"));
    }
}

#[test]
fn reads_v3_to_v11_dynamic_kimi_rebinding_created_by_node() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("v3-migrated.sqlite3");
    prepare_node_schema_with_mode(&database_path, "v3-migrated");
    CouncilStore::open(&database_path, 5_000).expect("Rust must open Node v3→v11 database");

    let raw = Connection::open(&database_path).expect("inspection connection");
    let (actor_id, mention_alias, config_revision): (String, String, i64) = raw
        .query_row(
            "SELECT actor_id, mention_alias, config_revision
             FROM agent_definitions
             WHERE id = 'agent-kimi-v3'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("migrated Kimi agent");
    assert!(actor_id.starts_with("actor-"));
    assert_ne!(actor_id, "kimi");
    assert_eq!(mention_alias, "kimi");
    assert_eq!(config_revision, 2);
    let alias_owner: String = raw
        .query_row(
            "SELECT actor_id FROM actor_aliases WHERE alias = 'kimi'",
            [],
            |row| row.get(0),
        )
        .expect("current Kimi alias");
    assert_eq!(alias_owner, actor_id);
    let old_status: String = raw
        .query_row(
            "SELECT status FROM actor_identities WHERE id = 'kimi'",
            [],
            |row| row.get(0),
        )
        .expect("historical Kimi seed");
    assert_eq!(old_status, "inactive");
    let old_alias_count: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM actor_aliases WHERE actor_id = 'kimi'",
            [],
            |row| row.get(0),
        )
        .expect("historical Kimi aliases");
    assert_eq!(old_alias_count, 0);
}

#[test]
fn requires_fresh_human_evidence_for_delegation_acceptance() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("acceptance.sqlite3");
    prepare_node_schema(&database_path);
    let mut store = CouncilStore::open(&database_path, 5_000).expect("store");
    let topic = store
        .create_topic(topic_input(
            "人工验收",
            "/workspace/acceptance",
            HUMAN_ALIAS,
        ))
        .expect("topic");
    store
        .record_decision(RecordDecisionInput {
            topic_id: topic.id.clone(),
            title: "实施".into(),
            decision: "按标准交付".into(),
            rationale: "验证验收边界".into(),
            alternatives: vec![],
            status: DecisionStatus::Accepted,
            created_by_alias: HUMAN_ALIAS.into(),
        })
        .expect("decision");
    let items = store
        .create_work_items(CreateWorkItemsInput {
            topic_id: topic.id.clone(),
            decision_id: None,
            parent_id: None,
            items: vec![CreateWorkItemEntry {
                title: "待验收任务".into(),
                details: "检查交付".into(),
            }],
            actor_alias: HUMAN_ALIAS.into(),
        })
        .expect("work item");
    let item = &items[0];
    let raw = Connection::open(&database_path).expect("fixture connection");
    raw.execute("INSERT INTO work_item_delegations (
        id, topic_id, work_item_id, supervisor_agent_id, executor_agent_id, permission_profile,
        status, attempt, max_attempts, created_at, updated_at, completed_at, completion_policy, acceptance_criteria
    ) VALUES ('delegation-acceptance', ?1, ?2,
        (SELECT id FROM agent_definitions WHERE actor_id='claude'),
        (SELECT id FROM agent_definitions WHERE actor_id='codex'),
        'workspace_write', 'approved', 1, 2, '2026-01-01', '2026-01-01', '2026-01-01', 'human', '检查交付')",
        params![topic.id, item.id]).expect("delegation");
    raw.execute("UPDATE work_item_delegations SET status='queued', completed_at=NULL WHERE id='delegation-acceptance'", []).expect("active delegation");
    assert!(matches!(
        store.close_topic(CloseTopicInput {
            topic_id: topic.id.clone(),
            actor_alias: HUMAN_ALIAS.into(),
        }),
        Err(CouncilError::Conflict(_))
    ));
    raw.execute("UPDATE work_item_delegations SET status='approved', completed_at='2026-01-01' WHERE id='delegation-acceptance'", []).expect("reviewed delegation");
    let updated = store
        .update_work_item(UpdateWorkItemInput {
            topic_id: topic.id.clone(),
            work_item_id: item.id.clone(),
            status: WorkItemStatus::InProgress,
            status_note: Some("Agent 审核通过，等待验收".into()),
            fix_commit: None,
            expected_version: item.version,
            actor_alias: CODEX_ALIAS.into(),
        })
        .expect("review summary");
    for (actor, note) in [
        (HUMAN_ALIAS, None),
        (HUMAN_ALIAS, Some("  ")),
        (CODEX_ALIAS, Some("自行验收")),
    ] {
        assert!(matches!(
            store.update_work_item(UpdateWorkItemInput {
                topic_id: topic.id.clone(),
                work_item_id: item.id.clone(),
                status: WorkItemStatus::Completed,
                status_note: note.map(str::to_string),
                fix_commit: None,
                expected_version: updated.version,
                actor_alias: actor.into(),
            }),
            Err(CouncilError::Conflict(_))
        ));
    }
    let accepted = store
        .update_work_item(UpdateWorkItemInput {
            topic_id: topic.id,
            work_item_id: item.id.clone(),
            status: WorkItemStatus::Completed,
            status_note: Some("人工检查交付符合标准".into()),
            fix_commit: None,
            expected_version: updated.version,
            actor_alias: HUMAN_ALIAS.into(),
        })
        .expect("human acceptance");
    assert_eq!(accepted.updated_by_actor_id, "human");
    assert_eq!(accepted.version, updated.version + 1);
}

#[test]
fn rejects_unmigrated_and_future_schema_versions() {
    let directory = tempdir().expect("temp directory");
    let unmigrated = directory.path().join("unmigrated.sqlite3");
    Connection::open(&unmigrated)
        .expect("unmigrated database")
        .execute_batch("CREATE TABLE placeholder (id INTEGER PRIMARY KEY);")
        .expect("unmigrated fixture");
    assert!(matches!(
        CouncilStore::open(&unmigrated, 5_000),
        Err(CouncilError::InvalidData(_))
    ));

    let future = directory.path().join("future.sqlite3");
    prepare_node_schema(&future);
    Connection::open(&future)
        .expect("future database")
        .execute_batch(
            "INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (17, 'future-schema', '2026-01-01T00:00:00.000Z');
             PRAGMA user_version = 17;",
        )
        .expect("future schema fixture");
    assert!(matches!(
        CouncilStore::open(&future, 5_000),
        Err(CouncilError::InvalidData(_))
    ));
}
