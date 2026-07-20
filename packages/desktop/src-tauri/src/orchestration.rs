/**
 * @input  依赖：validation::LoopbackEndpoint、settings::OrchestrationAutostart 与 std 网络/进程原语
 * @output 导出：本地 Agent 服务的健康探测、自动拉起与随应用退出的终止函数
 * @pos    桌面壳与 Node 编排服务之间唯一的进程与连通性边界（不承载业务状态机）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
use crate::settings::OrchestrationAutostart;
use crate::validation::{self, LoopbackEndpoint};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

// ============================================================
// 探测参数：loopback 服务的本机往返极快，超时保守取秒级即可；
// 这些是实现级常量而非业务配置，不进入用户设置。
// ============================================================
const PROBE_CONNECT_TIMEOUT_MS: u64 = 1_000;
const PROBE_IO_TIMEOUT_MS: u64 = 2_000;
const PROBE_PATH: &str = "/api/v1/status";
/// SIGTERM 后的有界等待：20 次 × 100ms = 2 秒，超时升级 SIGKILL。
const TERMINATE_POLL_COUNT: u32 = 20;
const TERMINATE_POLL_INTERVAL_MS: u64 = 100;

/// 探测本地 Agent 服务是否可达：TCP 连通 + 最小 HTTP GET。
/// 只要对端回出合法 HTTP 状态行（包括 4xx/5xx）即视为服务在监听；
/// Rust 侧探测不带 Origin 头，因此不受服务端 CORS 白名单影响。
pub fn probe_http_service(endpoint: &LoopbackEndpoint) -> bool {
    let Ok(addresses) = (endpoint.host.as_str(), endpoint.port).to_socket_addrs() else {
        return false;
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
        let mut buffer = [0_u8; 16];
        let mut read_total = 0_usize;
        while read_total < buffer.len() {
            match stream.read(&mut buffer[read_total..]) {
                Ok(0) => break,
                Ok(count) => read_total += count,
                Err(_) => break,
            }
        }
        if buffer[..read_total].starts_with(b"HTTP/") {
            return true;
        }
    }
    false
}

/// 按 autostart 配置拉起本地 Agent 服务子进程。
/// Unix 下放入独立进程组，便于退出时把 npm/node 之类的整棵子进程树一起终止。
pub fn spawn_service(autostart: &OrchestrationAutostart) -> Result<Child, String> {
    if autostart.command.trim().is_empty() {
        return Err("orchestrationAutostart.command 不能为空".to_string());
    }
    let mut command = Command::new(&autostart.command);
    command
        .args(&autostart.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
    use super::probe_http_service;
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
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{}",
            );
        });
        assert!(probe_http_service(&endpoint(port)));
        server.join().expect("join probe server");
    }

    #[test]
    fn reports_unreachable_when_no_listener() {
        // 先绑定拿到一个空闲端口，再立即释放，探测应失败。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral listener");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        assert!(!probe_http_service(&endpoint(port)));
    }
}
