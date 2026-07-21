/**
 * @input  依赖：操作系统应用配置目录、用户选择的绝对目录
 * @output 导出：DesktopSettings（含本地 Agent 服务配置）与原子持久化 SettingsStore
 * @pos    日志库、当前项目、最近项目和本地 Agent 服务接入的本机唯一设置边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;

const SETTINGS_FILE_NAME: &str = "settings.json";
const MAX_RECENT_PROJECTS: usize = 10;

// ============================================================
// 本地 Agent 服务默认地址：与 Node 编排服务的默认端口保持一致。
// 这是唯一允许出现该默认值的位置；其余代码一律从设置读取。
// ============================================================
pub const DEFAULT_ORCHESTRATION_BASE_URL: &str = "http://127.0.0.1:4317";

fn default_orchestration_base_url() -> String {
    DEFAULT_ORCHESTRATION_BASE_URL.to_string()
}

/// 本地 Agent 服务的可选开发者启动覆盖；None 表示使用安装包内置 sidecar。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationAutostart {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default)]
    pub log_library: Option<PathBuf>,
    #[serde(default)]
    pub current_project_path: Option<PathBuf>,
    #[serde(default)]
    pub recent_project_paths: Vec<PathBuf>,
    /// 本地 Agent 服务（Node 编排服务）的 loopback 基础地址。
    #[serde(default = "default_orchestration_base_url")]
    pub orchestration_base_url: String,
    /// 可选开发者启动覆盖；旧版 settings.json 可继续使用，普通用户无需配置。
    #[serde(default)]
    pub orchestration_autostart: Option<OrchestrationAutostart>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            log_library: None,
            current_project_path: None,
            recent_project_paths: Vec::new(),
            orchestration_base_url: default_orchestration_base_url(),
            orchestration_autostart: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("所选路径必须是存在的绝对目录")]
    InvalidDirectory,
    #[error("无法读取桌面设置：{0}")]
    Read(#[source] std::io::Error),
    #[error("桌面设置格式无效：{0}")]
    Decode(#[source] serde_json::Error),
    #[error("无法编码桌面设置：{0}")]
    Encode(#[source] serde_json::Error),
    #[error("无法保存桌面设置：{0}")]
    Write(#[source] std::io::Error),
}

#[derive(Debug)]
pub struct SettingsStore {
    settings_path: PathBuf,
    settings: DesktopSettings,
}

impl SettingsStore {
    pub fn open(config_dir: &Path) -> Result<Self, SettingsError> {
        let settings_path = config_dir.join(SETTINGS_FILE_NAME);
        let settings = if settings_path.exists() {
            let content = fs::read_to_string(&settings_path).map_err(SettingsError::Read)?;
            serde_json::from_str(&content).map_err(SettingsError::Decode)?
        } else {
            DesktopSettings::default()
        };
        Ok(Self {
            settings_path,
            settings,
        })
    }

    pub fn snapshot(&self) -> DesktopSettings {
        self.settings.clone()
    }

    pub fn configure_log_library(
        &mut self,
        log_library: PathBuf,
    ) -> Result<DesktopSettings, SettingsError> {
        validate_directory(&log_library)?;
        let previous = self.settings.clone();
        self.settings.log_library = Some(log_library);
        if let Err(error) = self.persist() {
            self.settings = previous;
            return Err(error);
        }
        Ok(self.snapshot())
    }

    pub fn select_project(
        &mut self,
        project_path: PathBuf,
    ) -> Result<DesktopSettings, SettingsError> {
        validate_directory(&project_path)?;
        let previous = self.settings.clone();
        self.settings.current_project_path = Some(project_path.clone());
        self.settings
            .recent_project_paths
            .retain(|candidate| candidate != &project_path);
        self.settings.recent_project_paths.insert(0, project_path);
        self.settings
            .recent_project_paths
            .truncate(MAX_RECENT_PROJECTS);
        if let Err(error) = self.persist() {
            self.settings = previous;
            return Err(error);
        }
        Ok(self.snapshot())
    }

    fn persist(&self) -> Result<(), SettingsError> {
        let parent = self
            .settings_path
            .parent()
            .ok_or(SettingsError::InvalidDirectory)?;
        fs::create_dir_all(parent).map_err(SettingsError::Write)?;
        let content = serde_json::to_vec_pretty(&self.settings).map_err(SettingsError::Encode)?;
        let temporary_path = self.settings_path.with_extension("json.tmp");
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut temporary = options
            .open(&temporary_path)
            .map_err(SettingsError::Write)?;
        temporary
            .write_all(&content)
            .map_err(SettingsError::Write)?;
        temporary.sync_all().map_err(SettingsError::Write)?;
        fs::rename(&temporary_path, &self.settings_path).map_err(SettingsError::Write)
    }
}

fn validate_directory(path: &Path) -> Result<(), SettingsError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(SettingsError::InvalidDirectory);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{DesktopSettings, SettingsError, SettingsStore};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn persists_log_library_and_recent_projects() {
        let root = tempfile::tempdir().expect("create temp root");
        let config = root.path().join("config");
        let logs = root.path().join("logs");
        let first_project = root.path().join("first");
        let second_project = root.path().join("second");
        fs::create_dir_all(&logs).expect("create logs");
        fs::create_dir_all(&first_project).expect("create first project");
        fs::create_dir_all(&second_project).expect("create second project");

        let mut store = SettingsStore::open(&config).expect("open settings");
        store
            .configure_log_library(logs.clone())
            .expect("configure logs");
        store
            .select_project(first_project.clone())
            .expect("select first");
        store
            .select_project(second_project.clone())
            .expect("select second");
        store
            .select_project(first_project.clone())
            .expect("select first again");

        let reopened = SettingsStore::open(&config).expect("reopen settings");
        assert_eq!(
            reopened.snapshot(),
            DesktopSettings {
                log_library: Some(logs),
                current_project_path: Some(first_project.clone()),
                recent_project_paths: vec![first_project, second_project],
                ..DesktopSettings::default()
            }
        );
    }

    #[test]
    fn upgrades_legacy_settings_without_orchestration_fields() {
        let root = tempfile::tempdir().expect("create temp root");
        // 旧版本 settings.json 只有三个内容字段；升级后必须无损解析并落到默认编排配置。
        fs::write(
            root.path().join("settings.json"),
            r#"{"logLibrary":null,"currentProjectPath":null,"recentProjectPaths":[]}"#,
        )
        .expect("write legacy settings");

        let store = SettingsStore::open(root.path()).expect("open legacy settings");
        let snapshot = store.snapshot();
        assert_eq!(
            snapshot.orchestration_base_url,
            super::DEFAULT_ORCHESTRATION_BASE_URL
        );
        assert!(snapshot.orchestration_autostart.is_none());
    }

    #[test]
    fn parses_and_persists_orchestration_autostart() {
        let root = tempfile::tempdir().expect("create temp root");
        let logs = root.path().join("logs");
        fs::create_dir_all(&logs).expect("create logs");
        fs::write(
            root.path().join("settings.json"),
            r#"{
                "logLibrary": null,
                "currentProjectPath": null,
                "recentProjectPaths": [],
                "orchestrationBaseUrl": "http://127.0.0.1:14317",
                "orchestrationAutostart": {
                    "command": "npm",
                    "args": ["run", "start:http"],
                    "cwd": "/path/to/service",
                    "env": {"COUNCIL_HTTP_PORT": "14317"}
                }
            }"#,
        )
        .expect("write settings with autostart");

        let mut store = SettingsStore::open(root.path()).expect("open settings");
        let snapshot = store.snapshot();
        assert_eq!(snapshot.orchestration_base_url, "http://127.0.0.1:14317");
        let autostart = snapshot
            .orchestration_autostart
            .expect("autostart configured");
        assert_eq!(autostart.command, "npm");
        assert_eq!(
            autostart.args,
            vec!["run".to_string(), "start:http".to_string()]
        );
        assert_eq!(
            autostart.cwd.as_deref(),
            Some(std::path::Path::new("/path/to/service"))
        );
        assert_eq!(
            autostart.env.get("COUNCIL_HTTP_PORT").map(String::as_str),
            Some("14317")
        );

        // 写回其他设置后编排配置必须原样保留。
        store.configure_log_library(logs).expect("configure logs");
        let reopened = SettingsStore::open(root.path()).expect("reopen settings");
        assert_eq!(
            reopened.snapshot().orchestration_base_url,
            "http://127.0.0.1:14317"
        );
        assert!(reopened.snapshot().orchestration_autostart.is_some());
    }

    #[test]
    fn rejects_relative_or_missing_directories_without_mutating_state() {
        let root = tempfile::tempdir().expect("create temp root");
        let mut store = SettingsStore::open(root.path()).expect("open settings");
        let before = store.snapshot();

        let error = store
            .configure_log_library(PathBuf::from("relative"))
            .expect_err("reject relative directory");
        assert!(matches!(error, SettingsError::InvalidDirectory));
        assert_eq!(store.snapshot(), before);
    }

    #[test]
    fn rejects_corrupt_settings_instead_of_overwriting_them() {
        let root = tempfile::tempdir().expect("create temp root");
        fs::write(root.path().join("settings.json"), "not-json").expect("write corrupt settings");

        let error = SettingsStore::open(root.path()).expect_err("reject corrupt settings");
        assert!(matches!(error, SettingsError::Decode(_)));
    }
}
