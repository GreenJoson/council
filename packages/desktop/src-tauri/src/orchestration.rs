/**
 * @input  依赖：loopback 端点、日志库、内置 sidecar/默认配置与 std 网络/进程原语
 * @output 导出：Agent 服务启动配置、ready + 数据库身份探测/等待、进程拉起与退出终止函数
 * @pos    桌面壳与内置 Agent Service 之间唯一的进程、配置和连通性边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
use crate::settings::OrchestrationAutostart;
use crate::validation::{self, LoopbackEndpoint};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

// ============================================================
// 探测参数：loopback 服务的本机往返极快，超时保守取秒级即可；
// 这些是实现级常量而非业务配置，不进入用户设置。
// ============================================================
const PROBE_CONNECT_TIMEOUT_MS: u64 = 1_000;
const PROBE_IO_TIMEOUT_MS: u64 = 2_000;
const PROBE_PATH: &str = "/api/v1/status";
const READY_MAX_ATTEMPTS_KEY: &str = "COUNCIL_DESKTOP_READY_MAX_ATTEMPTS";
const READY_POLL_MS_KEY: &str = "COUNCIL_DESKTOP_READY_POLL_MS";
const SIDECAR_BINARY_NAME: &str = "council-agent-service";
const SERVICE_LOG_FILE_NAME: &str = "agent-service.log";
const LOGIN_SHELL_PATH_MARKER: &str = "__COUNCIL_PATH__";
const LOGIN_SHELL_POLL_COUNT: u32 = 50;
/// SIGTERM 后的有界等待：20 次 × 100ms = 2 秒，超时升级 SIGKILL。
const TERMINATE_POLL_COUNT: u32 = 20;
const TERMINATE_POLL_INTERVAL_MS: u64 = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadyService {
    pub database_instance_id: String,
}

/// Tauri 在开发输出和发行包里都会把 externalBin 放在主程序旁边，并移除 target triple 后缀。
pub fn bundled_service_binary() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位 Council 主程序：{error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "Council 主程序路径缺少父目录".to_string())?;
    let binary = directory.join(format!(
        "{SIDECAR_BINARY_NAME}{}",
        std::env::consts::EXE_SUFFIX
    ));
    if !binary.is_file() {
        return Err("Council 安装包缺少内置 Agent Service，请重新安装应用。".to_string());
    }
    Ok(binary)
}

/// 从用户的登录 shell 获取完整 PATH。Finder 启动的 GUI 通常拿不到 CLI 安装目录；
/// 此处只读取 PATH，固定脚本不拼接任何用户输入。
fn login_shell_path() -> Option<String> {
    let shell = std::env::var_os("SHELL")?;
    let shell_path = Path::new(&shell);
    if !shell_path.is_absolute() || !shell_path.is_file() {
        return None;
    }
    let mut command = Command::new(shell_path);
    command
        .args(["-lc", "printf '\n__COUNCIL_PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).map(|_| output)
    });
    let mut completed = None;
    for _ in 0..LOGIN_SHELL_POLL_COUNT {
        match child.try_wait() {
            Ok(Some(status)) => {
                completed = Some(status);
                break;
            }
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(TERMINATE_POLL_INTERVAL_MS));
            }
            Err(_) => break,
        }
    }
    if completed.is_none() {
        completed = child.try_wait().ok().flatten();
    }
    let Some(status) = completed else {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        #[cfg(not(unix))]
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        return None;
    };
    let output = reader.join().ok()?.ok()?;
    if !status.success() {
        return None;
    }
    let output = String::from_utf8(output).ok()?;
    let path = output.rsplit_once(LOGIN_SHELL_PATH_MARKER)?.1.trim();
    (!path.is_empty()).then(|| path.to_string())
}

fn service_defaults() -> Result<BTreeMap<String, String>, String> {
    serde_json::from_str(include_str!("../resources/agent-service-defaults.json"))
        .map_err(|error| format!("内置 Agent Service 默认配置无效：{error}"))
}

/// 构造内置 sidecar 的完整环境。动态路径和监听端点覆盖只读默认配置；
/// 模型与远程 Provider 密钥仍由共享 SQLite / 系统 Keychain 管理。
pub fn built_in_autostart(
    binary: PathBuf,
    log_library: &Path,
    endpoint: &LoopbackEndpoint,
) -> Result<OrchestrationAutostart, String> {
    validation::directory(log_library, "日志库")?;
    let data_dir = log_library
        .to_str()
        .ok_or_else(|| "日志库路径必须是有效 UTF-8".to_string())?;
    let mut env = service_defaults()?;
    env.insert("COUNCIL_DATA_DIR".to_string(), data_dir.to_string());
    env.insert("COUNCIL_HTTP_HOST".to_string(), endpoint.host.clone());
    env.insert("COUNCIL_HTTP_PORT".to_string(), endpoint.port.to_string());
    if let Some(path) = login_shell_path().or_else(|| std::env::var("PATH").ok()) {
        env.insert("PATH".to_string(), path);
    }
    Ok(OrchestrationAutostart {
        command: binary.to_string_lossy().into_owned(),
        args: Vec::new(),
        cwd: None,
        env,
    })
}

pub fn service_log_path(log_directory: &Path) -> PathBuf {
    log_directory.join(SERVICE_LOG_FILE_NAME)
}

/// 只有 status 返回 HTTP 200、统一 code=0、data.ready=true 且带数据库实例身份才视为可用；
/// 端口监听但 schema 迁移失败或服务未 ready 时绝不允许 Rust Store 打开。
pub fn probe_http_service(endpoint: &LoopbackEndpoint) -> Option<ReadyService> {
    let Ok(addresses) = (endpoint.host.as_str(), endpoint.port).to_socket_addrs() else {
        return None;
    };
    for address in addresses {
        let Ok(mut stream) =
            TcpStream::connect_timeout(&address, Duration::from_millis(PROBE_CONNECT_TIMEOUT_MS))
        else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(PROBE_IO_TIMEOUT_MS)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(PROBE_IO_TIMEOUT_MS)));
        let request = format!(
            "GET {PROBE_PATH} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            host = endpoint.host,
            port = endpoint.port,
        );
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut response = Vec::new();
        if stream.take(8_192).read_to_end(&mut response).is_err() {
            continue;
        }
        let Ok(response) = String::from_utf8(response) else {
            continue;
        };
        let Some((headers, body)) = response.split_once("\r\n\r\n") else {
            continue;
        };
        if !headers.lines().next().is_some_and(|line| {
            line.starts_with("HTTP/1.1 200 ") || line.starts_with("HTTP/1.0 200 ")
        }) {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
            continue;
        };
        if payload.get("code").and_then(serde_json::Value::as_i64) == Some(0)
            && payload
                .pointer("/data/ready")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        {
            let Some(database_instance_id) = payload
                .pointer("/data/databaseInstanceId")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 128)
            else {
                continue;
            };
            return Some(ReadyService {
                database_instance_id: database_instance_id.to_string(),
            });
        }
    }
    None
}

fn positive_default(name: &str) -> Result<u64, String> {
    let defaults = service_defaults()?;
    let value = defaults
        .get(name)
        .ok_or_else(|| format!("内置 Agent Service 缺少 {name}。"))?;
    value
        .parse::<u64>()
        .ok()
        .filter(|parsed| *parsed > 0)
        .ok_or_else(|| format!("内置 Agent Service 的 {name} 必须是正整数。"))
}

pub fn wait_for_http_service(endpoint: &LoopbackEndpoint) -> Result<ReadyService, String> {
    let max_attempts = positive_default(READY_MAX_ATTEMPTS_KEY)?;
    let poll_ms = positive_default(READY_POLL_MS_KEY)?;
    for _ in 0..max_attempts {
        if let Some(ready) = probe_http_service(endpoint) {
            return Ok(ready);
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }
    Err("本地 Agent Service 未在配置时限内完成数据库迁移并进入 ready。".to_string())
}

/// 按 autostart 配置拉起本地 Agent 服务子进程。
/// Unix 下放入独立进程组，便于退出时把 npm/node 之类的整棵子进程树一起终止。
pub fn spawn_service(autostart: &OrchestrationAutostart, log_path: &Path) -> Result<Child, String> {
    if autostart.command.trim().is_empty() {
        return Err("orchestrationAutostart.command 不能为空".to_string());
    }
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Agent Service 日志目录：{error}"))?;
    }
    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    let log = log_options
        .open(log_path)
        .map_err(|error| format!("无法打开 Agent Service 日志：{error}"))?;
    let error_log = log
        .try_clone()
        .map_err(|error| format!("无法复制 Agent Service 日志句柄：{error}"))?;

    let mut command = Command::new(&autostart.command);
    command
        .args(&autostart.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    if let Some(cwd) = &autostart.cwd {
        validation::directory(cwd, "orchestrationAutostart.cwd")?;
        command.current_dir(cwd);
    }
    for (key, value) in &autostart.env {
        if key.trim().is_empty() {
            return Err("orchestrationAutostart.env 的变量名不能为空".to_string());
        }
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 新进程组：组长 pid 即子进程 pid，退出清理时对 -pid 发信号覆盖整个进程树。
        command.process_group(0);
    }
    command
        .spawn()
        .map_err(|error| format!("无法启动本地 Agent 服务：{error}"))
}

/// 应用退出时终止托管的服务子进程：先 SIGTERM（服务端有优雅关闭逻辑），
/// 有界等待后升级 SIGKILL，避免退出流程被挂住或留下孤儿进程。
pub fn terminate_service(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    {
        let group = -(child.id() as i32);
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        for _ in 0..TERMINATE_POLL_COUNT {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(TERMINATE_POLL_INTERVAL_MS));
        }
        unsafe {
            libc::kill(group, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::{built_in_autostart, probe_http_service, service_defaults};
    use crate::validation::LoopbackEndpoint;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn endpoint(port: u16) -> LoopbackEndpoint {
        LoopbackEndpoint {
            host: "127.0.0.1".to_string(),
            port,
        }
    }

    #[test]
    fn detects_listening_http_service() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
        let port = listener.local_addr().expect("local addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept probe");
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"code\":0,\"data\":{\"ready\":true,\"databaseInstanceId\":\"00000000-0000-4000-8000-000000000001\"}}",
            );
        });
        assert_eq!(
            probe_http_service(&endpoint(port)).map(|ready| ready.database_instance_id),
            Some("00000000-0000-4000-8000-000000000001".to_string())
        );
        server.join().expect("join probe server");
    }

    #[test]
    fn reports_unreachable_when_no_listener() {
        // 先绑定拿到一个空闲端口，再立即释放，探测应失败。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral listener");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        assert!(probe_http_service(&endpoint(port)).is_none());
    }

    #[test]
    fn rejects_listening_http_service_without_ready_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
        let port = listener.local_addr().expect("local addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept probe");
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"code\":503,\"data\":{\"ready\":false}}",
            );
        });
        assert!(probe_http_service(&endpoint(port)).is_none());
        server.join().expect("join probe server");
    }

    #[test]
    fn builds_sidecar_environment_from_defaults_and_dynamic_paths() {
        let logs = tempfile::tempdir().expect("create logs");
        let config = built_in_autostart(
            std::path::PathBuf::from("/tmp/council-agent-service"),
            logs.path(),
            &LoopbackEndpoint {
                host: "localhost".to_string(),
                port: 14_317,
            },
        )
        .expect("build autostart");
        assert_eq!(
            config.env.get("COUNCIL_DATA_DIR").map(String::as_str),
            logs.path().to_str()
        );
        assert_eq!(
            config.env.get("COUNCIL_HTTP_HOST").map(String::as_str),
            Some("localhost")
        );
        assert_eq!(
            config.env.get("COUNCIL_HTTP_PORT").map(String::as_str),
            Some("14317")
        );
        assert_eq!(
            config
                .env
                .get("COUNCIL_CLAUDE_PERMISSION_MODE")
                .map(String::as_str),
            Some("plan")
        );
    }

    #[test]
    fn bundled_defaults_never_contain_user_data_or_api_keys() {
        let defaults = service_defaults().expect("parse defaults");
        assert!(!defaults.contains_key("COUNCIL_DATA_DIR"));
        assert!(defaults.keys().all(|key| !key.contains("API_KEY")));
    }
}
