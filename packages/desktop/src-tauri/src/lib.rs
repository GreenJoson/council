/**
 * @input  依赖：Tauri 运行时、原生对话框、本机 SettingsStore 与本地 Agent 服务探测/托管
 * @output 导出：Council 桌面命令（内容、设置、编排服务接入）和 run 启动函数
 * @pos    React 界面进入 Rust 桌面能力的唯一 IPC 边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
mod orchestration;
mod settings;
mod validation;

use council_core::{
    Author, CouncilError, CouncilRevisions, CouncilStore, CreateTopicInput, Decision,
    DecisionStatus, MessageKind, PaginatedTopics, PostMessageInput, RecordDecisionInput, Topic,
    TopicDetail,
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

impl DesktopState {
    fn ensure_store(&mut self) -> Result<&mut CouncilStore, String> {
        let database_path = self
            .settings
            .snapshot()
            .log_library
            .ok_or_else(|| "请先设置 Council 日志库".to_string())?
            .join(DATABASE_FILE_NAME);
        if self.database_path.as_ref() != Some(&database_path) || self.store.is_none() {
            let store = open_database(database_path.clone())?;
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
    let store = open_database(database_path.clone())?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?;
    let settings = inner
        .settings
        .configure_log_library(path)
        .map_err(|error| error.to_string())?;
    inner.database_path = Some(database_path);
    inner.store = Some(store);
    if let Some(mut child) = inner.service_child.take() {
        orchestration::terminate_service(&mut child);
    }
    // 日志库决定 sidecar 的 SQLite 路径；切换后必须重启，避免 UI 与 Agent 写入不同库。
    let _ = start_managed_service(&mut inner, &app);
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
            created_by: Author::Human,
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
            author: Author::Human,
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
            created_by: Author::Human,
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
    let base_url = state
        .inner
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?
        .settings
        .snapshot()
        .orchestration_base_url;
    let endpoint = validation::loopback_http_base_url(&base_url)?;
    let reachable =
        tauri::async_runtime::spawn_blocking(move || orchestration::probe_http_service(&endpoint))
            .await
            .map_err(|_| "本地 Agent 服务健康探测任务异常退出".to_string())?;
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
    if orchestration::probe_http_service(&endpoint) {
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
            };
            if desktop_state.settings.snapshot().log_library.is_some() {
                // 已完成首次配置的用户打开 App 即拉起服务；失败不阻断内容阅读，
                // 前端健康轮询仍会显示离线并允许后续重试。
                let _ = start_managed_service(&mut desktop_state, app.handle());
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
    use super::{DATABASE_FILE_NAME, DesktopState, SettingsStore};
    use std::fs;

    #[test]
    fn reuses_store_until_log_library_changes() {
        let root = tempfile::tempdir().expect("create temp root");
        let config = root.path().join("config");
        let first_library = root.path().join("first-logs");
        let second_library = root.path().join("second-logs");
        fs::create_dir_all(&first_library).expect("create first log library");
        fs::create_dir_all(&second_library).expect("create second log library");

        let mut settings = SettingsStore::open(&config).expect("open settings");
        settings
            .configure_log_library(first_library.clone())
            .expect("configure first library");
        let mut state = DesktopState {
            settings,
            database_path: None,
            store: None,
            service_child: None,
        };

        let first_store = state.ensure_store().expect("open first store") as *const _;
        let reused_store = state.ensure_store().expect("reuse first store") as *const _;
        assert_eq!(first_store, reused_store);
        assert_eq!(
            state.database_path.as_deref(),
            Some(first_library.join(DATABASE_FILE_NAME).as_path())
        );

        state
            .settings
            .configure_log_library(second_library.clone())
            .expect("configure second library");
        state.ensure_store().expect("open second store");
        assert_eq!(
            state.database_path.as_deref(),
            Some(second_library.join(DATABASE_FILE_NAME).as_path())
        );
    }
}
