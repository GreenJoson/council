/**
 * @input  依赖：Tauri、SettingsStore、sidecar ready/数据库身份与动态 Actor Rust Store
 * @output 导出：迁移 ready + 身份门后的 Actor alias 内容、设置和编排服务命令
 * @pos    React 进入 Rust 桌面能力的 IPC 边界，禁止 Rust 抢先建表或连接错误日志库
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
mod orchestration;
mod settings;
mod validation;

use council_core::{
    CouncilError, CouncilRevisions, CouncilStore, CreateTopicInput, Decision, DecisionStatus,
    MessageKind, PaginatedTopics, PostMessageInput, RecordDecisionInput, Topic, TopicDetail,
};
use serde::{Deserialize, Serialize};
use settings::{DesktopSettings, SettingsStore};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const DATABASE_FILE_NAME: &str = "council.sqlite3";
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;

struct AppState {
    inner: Mutex<DesktopState>,
}

struct DesktopState {
    settings: SettingsStore,
    database_path: Option<PathBuf>,
    store: Option<CouncilStore>,
    /// 由 autostart 托管的本地 Agent 服务子进程；退出时随应用一并终止。
    service_child: Option<Child>,
    /// sidecar 日志所在目录；服务起不来时唯一能说清原因的地方。
    log_directory: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    revision: u64,
    revisions: DesktopStatusRevisions,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatusRevisions {
    content: u64,
    orchestration: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationConfig {
    base_url: String,
    autostart_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationHealth {
    base_url: String,
    reachable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationStartResult {
    /// "spawned"：本次拉起；"alreadyRunning"：托管子进程仍在运行。
    status: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordDecisionCommand {
    topic_id: String,
    title: String,
    decision: String,
    rationale: String,
    alternatives: Vec<String>,
    status: DecisionStatus,
}

/// 用户主目录；只用于判断日志库是否落在系统隐私保护范围内。
fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

impl DesktopState {
    /// 服务不可用时给出真正的原因，而不是笼统猜一个「还在迁移」。
    ///
    /// 优先转述 sidecar 日志里最后一条错误；日志指向打不开数据库、而日志库又在
    /// 隐私保护目录下时，直接说清楚这是系统授权问题——这条路径上没有任何提示，
    /// 排查一次要翻日志、比对路径、再想到重建会让 ad-hoc 签名失去既有授权。
    fn service_unavailable_reason(&self) -> String {
        let last_error = self
            .log_directory
            .as_deref()
            .and_then(orchestration::last_service_error);
        let library = self.settings.snapshot().log_library;
        let blocked_by_privacy = match (&last_error, &library, home_directory()) {
            (Some(error), Some(path), Some(home)) => {
                error.contains("unable to open database file")
                    && orchestration::is_privacy_protected(path, &home)
            }
            _ => false,
        };
        if blocked_by_privacy {
            return "本地 Agent Service 无法打开日志库：该目录位于 macOS 隐私保护范围内，\
                    应用没有访问权限。请在「系统设置 → 隐私与安全性 → 文件与文件夹」中\
                    为 Council 开启对应权限，或用「重选日志库」把日志库移到保护范围之外。"
                .to_string();
        }
        match last_error {
            Some(error) => format!("本地 Agent Service 未就绪：{error}"),
            None => "本地 Agent Service 尚未就绪，请稍候重试。".to_string(),
        }
    }

    fn ensure_store(&mut self) -> Result<&mut CouncilStore, String> {
        let snapshot = self.settings.snapshot();
        let database_path = snapshot
            .log_library
            .ok_or_else(|| "请先设置 Council 日志库".to_string())?
            .join(DATABASE_FILE_NAME);
        let endpoint = validation::loopback_http_base_url(&snapshot.orchestration_base_url)?;
        let ready = orchestration::probe_http_service(&endpoint)
            .ok_or_else(|| self.service_unavailable_reason())?;
        if let Some(store) = self.store.as_ref()
            && store.database_instance_id() != ready.database_instance_id
        {
            return Err(
                "本地 Agent Service 与桌面内容 Store 的数据库实例身份不一致，已停止访问。"
                    .to_string(),
            );
        }
        if self.database_path.as_ref() != Some(&database_path) || self.store.is_none() {
            let store = open_database_for_service(database_path.clone(), &ready)?;
            self.database_path = Some(database_path);
            self.store = Some(store);
        }
        self.store
            .as_mut()
            .ok_or_else(|| "Council 数据库未初始化".to_string())
    }
}

fn with_store<T>(
    state: &tauri::State<'_, AppState>,
    operation: impl FnOnce(&mut CouncilStore) -> Result<T, CouncilError>,
) -> Result<T, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?;
    operation(inner.ensure_store()?).map_err(|error| error.to_string())
}

fn open_database(database_path: PathBuf) -> Result<CouncilStore, String> {
    let store = CouncilStore::open(&database_path, SQLITE_BUSY_TIMEOUT_MS)
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&database_path, permissions)
            .map_err(|error| format!("无法保护 Council 数据库权限：{error}"))?;
    }
    Ok(store)
}

fn open_database_for_service(
    database_path: PathBuf,
    ready: &orchestration::ReadyService,
) -> Result<CouncilStore, String> {
    let store = open_database(database_path)?;
    if store.database_instance_id() != ready.database_instance_id {
        return Err(
            "本地 Agent Service 与桌面内容 Store 的数据库实例身份不一致，已停止打开。".to_string(),
        );
    }
    Ok(store)
}

fn emit_content_changed(app: &tauri::AppHandle, revisions: CouncilRevisions) {
    let _ = app.emit(
        "council://changed",
        serde_json::json!({
            "revision": revisions.total,
            "content": revisions.content,
            "orchestration": revisions.orchestration,
        }),
    );
}

#[tauri::command]
fn get_desktop_settings(state: tauri::State<'_, AppState>) -> Result<DesktopSettings, String> {
    state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())
        .map(|inner| inner.settings.snapshot())
}

#[tauri::command]
fn configure_log_library(
    path: PathBuf,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<DesktopSettings, String> {
    validation::directory(&path, "日志库")?;
    let database_path = path.join(DATABASE_FILE_NAME);
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?;
    let settings = inner
        .settings
        .configure_log_library(path)
        .map_err(|error| error.to_string())?;
    inner.database_path = None;
    inner.store = None;
    if let Some(mut child) = inner.service_child.take() {
        orchestration::terminate_service(&mut child);
    }
    // 日志库决定 sidecar 的 SQLite 路径；切换后必须重启，避免 UI 与 Agent 写入不同库。
    start_managed_service(&mut inner, &app)?;
    let endpoint = validation::loopback_http_base_url(&settings.orchestration_base_url)?;
    let ready = orchestration::wait_for_http_service(&endpoint)?;
    let store = open_database_for_service(database_path.clone(), &ready)?;
    inner.database_path = Some(database_path);
    inner.store = Some(store);
    Ok(settings)
}

#[tauri::command]
fn list_topics(
    project_path: Option<String>,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
) -> Result<PaginatedTopics, String> {
    validation::page(limit)?;
    if let Some(path) = project_path.as_deref() {
        validation::directory(std::path::Path::new(path), "项目目录")?;
    }
    with_store(&state, |store| {
        store.list_topics(project_path.as_deref(), limit, offset)
    })
}

#[tauri::command]
fn get_topic(
    topic_id: String,
    message_limit: u32,
    message_offset: u32,
    state: tauri::State<'_, AppState>,
) -> Result<TopicDetail, String> {
    validation::identifier(&topic_id, "topic_", "topicId")?;
    validation::page(message_limit)?;
    with_store(&state, |store| {
        store.get_topic(&topic_id, message_limit, message_offset)
    })
}

#[tauri::command]
fn create_topic(
    title: String,
    question: String,
    constraints: Vec<String>,
    project_path: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Topic, String> {
    validation::non_blank(&title, validation::MAX_TITLE_CHARS, "title")?;
    validation::non_blank(&question, validation::MAX_QUESTION_CHARS, "question")?;
    validation::string_list(
        &constraints,
        validation::MAX_CONSTRAINT_COUNT,
        validation::MAX_CONSTRAINT_CHARS,
        "constraints",
    )?;
    if let Some(path) = project_path.as_deref() {
        validation::directory(std::path::Path::new(path), "项目目录")?;
    }
    let (topic, revisions) = with_store(&state, |store| {
        let topic = store.create_topic(CreateTopicInput {
            title,
            question,
            constraints,
            project_path,
            created_by_alias: "human".into(),
        })?;
        let revisions = store.get_revisions()?;
        Ok((topic, revisions))
    })?;
    emit_content_changed(&app, revisions);
    Ok(topic)
}

#[tauri::command]
fn post_message(
    topic_id: String,
    kind: MessageKind,
    content: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<council_core::CouncilMessage, String> {
    validation::identifier(&topic_id, "topic_", "topicId")?;
    validation::non_blank(&content, validation::MAX_MESSAGE_CHARS, "content")?;
    let (message, revisions) = with_store(&state, |store| {
        let message = store.post_message(PostMessageInput {
            topic_id,
            actor_alias: "human".into(),
            kind,
            content,
            parent_message_id: None,
        })?;
        let revisions = store.get_revisions()?;
        Ok((message, revisions))
    })?;
    emit_content_changed(&app, revisions);
    Ok(message)
}

#[tauri::command]
fn record_decision(
    input: RecordDecisionCommand,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Decision, String> {
    validation::identifier(&input.topic_id, "topic_", "topicId")?;
    validation::non_blank(&input.title, validation::MAX_TITLE_CHARS, "title")?;
    validation::non_blank(&input.decision, validation::MAX_MESSAGE_CHARS, "decision")?;
    validation::non_blank(&input.rationale, validation::MAX_MESSAGE_CHARS, "rationale")?;
    validation::string_list(
        &input.alternatives,
        validation::MAX_ALTERNATIVE_COUNT,
        validation::MAX_CONSTRAINT_CHARS,
        "alternatives",
    )?;
    let (recorded, revisions) = with_store(&state, |store| {
        let recorded = store.record_decision(RecordDecisionInput {
            topic_id: input.topic_id,
            title: input.title,
            decision: input.decision,
            rationale: input.rationale,
            alternatives: input.alternatives,
            status: input.status,
            created_by_alias: "human".into(),
        })?;
        let revisions = store.get_revisions()?;
        Ok((recorded, revisions))
    })?;
    emit_content_changed(&app, revisions);
    Ok(recorded)
}

#[tauri::command]
fn get_status(state: tauri::State<'_, AppState>) -> Result<DesktopStatus, String> {
    let revisions = with_store(&state, |store| store.get_revisions())?;
    Ok(DesktopStatus {
        revision: revisions.total,
        revisions: DesktopStatusRevisions {
            content: revisions.content,
            orchestration: revisions.orchestration,
        },
    })
}

#[tauri::command]
fn select_project(
    path: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<DesktopSettings, String> {
    state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?
        .settings
        .select_project(path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_orchestration_config(
    state: tauri::State<'_, AppState>,
) -> Result<OrchestrationConfig, String> {
    let snapshot = state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?
        .settings
        .snapshot();
    validation::loopback_http_base_url(&snapshot.orchestration_base_url)?;
    Ok(OrchestrationConfig {
        base_url: snapshot.orchestration_base_url,
        autostart_configured: snapshot.log_library.is_some()
            || snapshot.orchestration_autostart.is_some(),
    })
}

#[tauri::command]
async fn check_orchestration_service(
    state: tauri::State<'_, AppState>,
) -> Result<OrchestrationHealth, String> {
    // 先取配置并立即释放锁，网络探测期间不得持有桌面状态锁。
    let (base_url, expected_database_instance_id) = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "桌面状态锁已损坏".to_string())?;
        (
            inner.settings.snapshot().orchestration_base_url,
            inner
                .store
                .as_ref()
                .map(|store| store.database_instance_id().to_string()),
        )
    };
    let endpoint = validation::loopback_http_base_url(&base_url)?;
    let ready =
        tauri::async_runtime::spawn_blocking(move || orchestration::probe_http_service(&endpoint))
            .await
            .map_err(|_| "本地 Agent 服务健康探测任务异常退出".to_string())?;
    let reachable = ready.is_some_and(|service| {
        expected_database_instance_id
            .as_deref()
            .is_none_or(|expected| expected == service.database_instance_id)
    });
    Ok(OrchestrationHealth {
        base_url,
        reachable,
    })
}

#[tauri::command]
fn start_managed_service(
    inner: &mut DesktopState,
    app: &tauri::AppHandle,
) -> Result<OrchestrationStartResult, String> {
    if let Some(child) = inner.service_child.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                return Ok(OrchestrationStartResult {
                    status: "alreadyRunning",
                });
            }
            // 子进程已退出或状态不可读：清掉句柄后按新启动处理。
            _ => inner.service_child = None,
        }
    }
    let snapshot = inner.settings.snapshot();
    let endpoint = validation::loopback_http_base_url(&snapshot.orchestration_base_url)?;
    if let Some(ready) = orchestration::probe_http_service(&endpoint) {
        if inner
            .store
            .as_ref()
            .is_some_and(|store| store.database_instance_id() != ready.database_instance_id)
        {
            return Err("当前端口上的 Agent Service 使用了另一数据库实例，拒绝复用。".to_string());
        }
        return Ok(OrchestrationStartResult {
            status: "alreadyRunning",
        });
    }
    let autostart = if let Some(custom) = snapshot.orchestration_autostart {
        custom
    } else {
        let log_library = snapshot
            .log_library
            .as_deref()
            .ok_or_else(|| "请先设置 Council 日志库".to_string())?;
        orchestration::built_in_autostart(
            orchestration::bundled_service_binary()?,
            log_library,
            &endpoint,
        )?
    };
    let log_directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("无法定位 Council 日志目录：{error}"))?;
    let log_path = orchestration::service_log_path(&log_directory);
    let child = orchestration::spawn_service(&autostart, &log_path)?;
    inner.service_child = Some(child);
    Ok(OrchestrationStartResult { status: "spawned" })
}

#[tauri::command]
fn start_orchestration_service(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<OrchestrationStartResult, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?;
    start_managed_service(&mut inner, &app)
}

/// 应用退出时终止托管的服务子进程，防止 macOS 上留下孤儿进程。
fn shutdown_managed_service(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(mut inner) = state.inner.lock() {
            if let Some(mut child) = inner.service_child.take() {
                orchestration::terminate_service(&mut child);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let settings = SettingsStore::open(&config_dir)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let mut desktop_state = DesktopState {
                settings,
                database_path: None,
                store: None,
                service_child: None,
                log_directory: app.path().app_log_dir().ok(),
            };
            if desktop_state.settings.snapshot().log_library.is_some() {
                // Node sidecar 是唯一 schema 迁移器；只有 ready 后 Rust 才能打开数据库。
                if start_managed_service(&mut desktop_state, app.handle()).is_ok() {
                    let snapshot = desktop_state.settings.snapshot();
                    if let Ok(endpoint) =
                        validation::loopback_http_base_url(&snapshot.orchestration_base_url)
                        && let Some(log_library) = snapshot.log_library
                    {
                        let database_path = log_library.join(DATABASE_FILE_NAME);
                        if let Ok(ready) = orchestration::wait_for_http_service(&endpoint)
                            && let Ok(store) =
                                open_database_for_service(database_path.clone(), &ready)
                        {
                            desktop_state.database_path = Some(database_path);
                            desktop_state.store = Some(store);
                        }
                    }
                }
            }
            app.manage(AppState {
                inner: Mutex::new(desktop_state),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_settings,
            configure_log_library,
            select_project,
            list_topics,
            get_topic,
            create_topic,
            post_message,
            record_decision,
            get_status,
            get_orchestration_config,
            check_orchestration_service,
            start_orchestration_service
        ])
        .build(tauri::generate_context!())
        .expect("Council 桌面应用启动失败")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown_managed_service(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{DesktopState, SettingsStore, open_database, open_database_for_service};
    use crate::orchestration::ReadyService;
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    fn workspace_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
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
    fn refuses_rust_store_before_sidecar_reports_ready() {
        let root = tempfile::tempdir().expect("create temp root");
        let config = root.path().join("config");
        let log_library = root.path().join("logs");
        fs::create_dir_all(&log_library).expect("create log library");

        let mut settings = SettingsStore::open(&config).expect("open settings");
        settings
            .configure_log_library(log_library)
            .expect("configure log library");
        let mut state = DesktopState {
            settings,
            database_path: None,
            store: None,
            service_child: None,
            log_directory: None,
        };

        let error = match state.ensure_store() {
            Ok(_) => panic!("sidecar is not ready"),
            Err(error) => error,
        };
        assert!(error.contains("尚未就绪"));
        assert!(state.database_path.is_none());
        assert!(state.store.is_none());
    }

    #[test]
    fn rejects_ready_service_for_different_database_identity() {
        let root = tempfile::tempdir().expect("create temp root");
        let database_a = root.path().join("a.sqlite3");
        let database_b = root.path().join("b.sqlite3");
        for (path, instance_id) in [
            (&database_a, "00000000-0000-4000-8000-00000000000a"),
            (&database_b, "00000000-0000-4000-8000-00000000000b"),
        ] {
            create_node_database(path);
            let connection = Connection::open(path).expect("open fixture database");
            connection
                .execute(
                    "UPDATE council_identity SET instance_id = ?1 WHERE singleton = 1",
                    [instance_id],
                )
                .expect("set fixture identity");
        }
        let service_store = open_database(database_a).expect("open service database");
        let ready = ReadyService {
            database_instance_id: service_store.database_instance_id().to_string(),
        };
        let error = match open_database_for_service(database_b, &ready) {
            Ok(_) => panic!("different database identity must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("实例身份不一致"));
    }
}
