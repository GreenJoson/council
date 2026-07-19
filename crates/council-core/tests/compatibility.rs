//! @input 依赖：临时 SQLite 文件、CouncilStore 和原始 rusqlite 连接
//! @output 导出：TypeScript schema、分页、revision 与跨连接兼容性集成测试
//! @pos Rust 内容核心可安全接管现有 council.sqlite3 的回归证据
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use council_core::{
    Author, CouncilError, CouncilRevisions, CouncilStore, CreateTopicInput, DecisionStatus,
    MessageKind, PostMessageInput, RecordDecisionInput, TopicStatus,
};
use rusqlite::{Connection, params};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tempfile::tempdir;

fn topic_input(title: &str, project_path: &str, created_by: Author) -> CreateTopicInput {
    CreateTopicInput {
        title: title.into(),
        question: "如何保持兼容？".into(),
        constraints: vec!["必须可回滚".into()],
        project_path: Some(project_path.into()),
        created_by,
    }
}

#[test]
fn preserves_content_pagination_decision_and_revision_semantics() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
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
            Author::Human,
        ))
        .expect("topic should be created");
    assert!(topic.id.starts_with("topic_"));
    assert_eq!(store.get_revisions().expect("topic revision").total, 1);

    let first = store
        .post_message(PostMessageInput {
            topic_id: topic.id.clone(),
            author: Author::Claude,
            kind: MessageKind::Proposal,
            content: "采用兼容 schema。".into(),
            parent_message_id: None,
        })
        .expect("first message");
    let second = store
        .post_message(PostMessageInput {
            topic_id: topic.id.clone(),
            author: Author::Codex,
            kind: MessageKind::Critique,
            content: "还需要验证分页顺序。".into(),
            parent_message_id: Some(first.id.clone()),
        })
        .expect("second message");
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
            created_by: Author::Human,
        })
        .expect("decision should be recorded");
    assert_eq!(decision.status, DecisionStatus::Accepted);
    let decided = store.get_topic(&topic.id, 20, 0).expect("decided topic");
    assert_eq!(decided.topic.status, TopicStatus::Decided);
    assert_eq!(decided.decisions, vec![decision]);
    assert_eq!(store.get_revisions().expect("decision revisions").total, 7);

    store
        .create_topic(topic_input(
            "其他项目",
            "/workspace/project-beta",
            Author::Other,
        ))
        .expect("other topic");
    let page = store
        .list_topics(Some("/workspace/project-alpha"), 10, 0)
        .expect("filtered topics");
    assert_eq!(page.total, 1);
    assert_eq!(page.count, 1);
    assert_eq!(page.topics[0].id, topic.id);
    assert!(!page.has_more);
}

#[test]
fn shares_writes_across_connections_and_enforces_domain_conflicts() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    let mut first_store = CouncilStore::open(&database_path, 5_000).expect("first store");
    let mut second_store = CouncilStore::open(&database_path, 5_000).expect("second store");
    let first_topic = first_store
        .create_topic(topic_input(
            "双连接共享",
            "/workspace/project-alpha",
            Author::Claude,
        ))
        .expect("first topic");
    let second_topic = first_store
        .create_topic(topic_input(
            "父消息边界",
            "/workspace/project-alpha",
            Author::Human,
        ))
        .expect("second topic");
    let parent = first_store
        .post_message(PostMessageInput {
            topic_id: first_topic.id.clone(),
            author: Author::Human,
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
            author: Author::Codex,
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
        author: Author::Human,
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
        created_by: Author::Claude,
    });
    assert!(matches!(agent_accept, Err(CouncilError::Conflict(_))));
}

#[test]
fn reopens_existing_fields_without_rewriting_orchestration_revision() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    let topic_id = "topic_existing_typescript_fixture";
    let raw = Connection::open(&database_path).expect("raw connection");
    raw.execute_batch(
        "CREATE TABLE topics (
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
         CREATE TABLE agent_sessions (
           topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
           agent TEXT NOT NULL,
           session_id TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY (topic_id, agent)
         );
         CREATE TABLE council_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
         INSERT INTO council_meta (key, value) VALUES ('revision', 48);
         INSERT INTO council_meta (key, value) VALUES ('content_revision', 7);
         INSERT INTO council_meta (key, value) VALUES ('orchestration_revision', 41);",
    )
    .expect("create TypeScript-compatible schema fixture");
    raw.execute(
        "INSERT INTO topics (
           id, title, question, constraints_json, project_path, status,
           created_by, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'open', 'human', ?6, ?7)",
        params![
            topic_id,
            "旧库兼容",
            "Rust 能否读取现有字段？",
            "{invalid-json",
            "/workspace/project-alpha",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        ],
    )
    .expect("insert TypeScript-compatible topic fixture");
    let raw_created_by: String = raw
        .query_row(
            "SELECT created_by FROM topics WHERE id = ?1",
            params![topic_id],
            |row| row.get(0),
        )
        .expect("raw topic field");
    assert_eq!(raw_created_by, "human");
    drop(raw);

    let store = CouncilStore::open(&database_path, 5_000).expect("reopened store");
    let detail = store.get_topic(topic_id, 20, 0).expect("legacy topic");
    assert!(detail.topic.constraints.is_empty());
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
    assert_eq!(trigger_count, 9);
}

#[test]
fn migration_lock_keeps_revision_triggers_continuous_for_concurrent_writes() {
    let directory = tempdir().expect("temp directory");
    let database_path = directory.path().join("council.sqlite3");
    CouncilStore::open(&database_path, 5_000).expect("initialize schema");
    let blocker = Connection::open(&database_path).expect("blocker connection");
    blocker
        .busy_timeout(Duration::from_secs(5))
        .expect("blocker timeout");
    blocker
        .execute_batch("BEGIN IMMEDIATE")
        .expect("begin blocker transaction");
    let topic_id = "topic_migration_lock_test".to_string();
    let worker_path = database_path.clone();
    let worker_topic_id = topic_id.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        started_tx.send(()).expect("signal worker start");
        let mut store = CouncilStore::open(worker_path, 5_000).expect("concurrent migration");
        store
            .post_message(PostMessageInput {
                topic_id: worker_topic_id,
                author: Author::Human,
                kind: MessageKind::Note,
                content: "迁移完成后的并发写入。".into(),
                parent_message_id: None,
            })
            .expect("worker message");
        store.get_revisions().expect("worker revisions")
    });
    started_rx.recv().expect("worker started");
    thread::sleep(Duration::from_millis(20));
    let now = "2026-01-01T00:00:00.000Z";
    blocker
        .execute(
            "INSERT INTO topics (id, title, question, constraints_json, project_path, status, \
             created_by, created_at, updated_at) \
             VALUES (?1, ?2, ?3, '[]', NULL, 'open', 'human', ?4, ?5)",
            params![topic_id, "迁移并发", "revision 是否完整？", now, now],
        )
        .expect("insert while migration waits");
    blocker.execute_batch("COMMIT").expect("release blocker");

    let revisions = worker.join().expect("worker should finish");
    assert_eq!(revisions.total, 3);
    assert_eq!(revisions.content, 3);
    assert_eq!(revisions.orchestration, 0);
}
