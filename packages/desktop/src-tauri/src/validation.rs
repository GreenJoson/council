/**
 * @input  依赖：来自 Tauri IPC 的路径、分页、ID、内容/实施项文本参数与设置文件里的服务地址
 * @output 导出：与现有 HTTP/MCP 协议一致的输入校验函数和 loopback 服务地址解析
 * @pos    未验证外部输入（前端 IPC 与用户可编辑设置）进入 Rust core 前的唯一边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
use std::net::Ipv4Addr;
use std::path::Path;

pub const MAX_LIST_LIMIT: u32 = 100;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_QUESTION_CHARS: usize = 12_000;
pub const MAX_MESSAGE_CHARS: usize = 30_000;
pub const MAX_CONSTRAINT_COUNT: usize = 50;
pub const MAX_CONSTRAINT_CHARS: usize = 1_000;
pub const MAX_ALTERNATIVE_COUNT: usize = 30;
pub const MAX_WORK_ITEM_COUNT: usize = 50;
pub const MAX_WORK_ITEM_DETAILS_CHARS: usize = 8_000;
pub const MAX_WORK_ITEM_STATUS_NOTE_CHARS: usize = 4_000;

pub fn directory(path: &Path, name: &str) -> Result<(), String> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("{name} 必须是存在的绝对目录"));
    }
    Ok(())
}

pub fn page(limit: u32) -> Result<(), String> {
    if limit == 0 || limit > MAX_LIST_LIMIT {
        return Err(format!("分页上限必须在 1 到 {MAX_LIST_LIMIT} 之间"));
    }
    Ok(())
}

pub fn identifier(value: &str, prefix: &str, name: &str) -> Result<(), String> {
    let suffix = value.strip_prefix(prefix).unwrap_or_default();
    if suffix.is_empty()
        || !suffix
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(format!("{name} 格式无效"));
    }
    Ok(())
}

pub fn non_blank(value: &str, maximum: usize, name: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > maximum {
        return Err(format!("{name} 必须为非空文本且不能超过 {maximum} 个字符"));
    }
    Ok(())
}

/// 解析后的 loopback HTTP 服务端点，供健康探测直接建立 TCP 连接。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoopbackEndpoint {
    pub host: String,
    pub port: u16,
}

const DEFAULT_HTTP_PORT: u16 = 80;

fn is_loopback_host(host: &str) -> bool {
    let lowered = host.to_ascii_lowercase();
    if lowered == "localhost" || lowered == "::1" {
        return true;
    }
    lowered
        .parse::<Ipv4Addr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

/// 校验并拆解本地 Agent 服务地址：只接受 `http://<loopback 主机>[:端口]`，
/// 不允许路径、查询、片段或用户信息；IPv6 需写成 `[::1]` 带方括号形式。
pub fn loopback_http_base_url(value: &str) -> Result<LoopbackEndpoint, String> {
    const FORMAT_HINT: &str = "编排服务地址必须是 http://<loopback 主机>[:端口] 形式";
    let trimmed = value.trim();
    let rest = trimmed
        .strip_prefix("http://")
        .ok_or_else(|| format!("{FORMAT_HINT}，且只允许 http 协议"))?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
    {
        return Err(format!("{FORMAT_HINT}，不允许路径、查询或用户信息"));
    }
    let (host, port_text) = if let Some(bracketed) = rest.strip_prefix('[') {
        let end = bracketed
            .find(']')
            .ok_or_else(|| format!("{FORMAT_HINT}；IPv6 主机缺少右方括号"))?;
        let host = &bracketed[..end];
        let remainder = &bracketed[end + 1..];
        let port_text = if remainder.is_empty() {
            None
        } else {
            Some(
                remainder
                    .strip_prefix(':')
                    .ok_or_else(|| FORMAT_HINT.to_string())?,
            )
        };
        (host, port_text)
    } else if let Some((host, port_text)) = rest.rsplit_once(':') {
        (host, Some(port_text))
    } else {
        (rest, None)
    };
    if host.is_empty() {
        return Err(format!("{FORMAT_HINT}，主机不能为空"));
    }
    let port = match port_text {
        Some(text) => text
            .parse::<u16>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| format!("{FORMAT_HINT}，端口必须在 1 到 65535 之间"))?,
        None => DEFAULT_HTTP_PORT,
    };
    if !is_loopback_host(host) {
        return Err(
            "编排服务地址只允许 loopback 主机（localhost、127.0.0.0/8 或 [::1]）".to_string(),
        );
    }
    Ok(LoopbackEndpoint {
        host: host.to_string(),
        port,
    })
}

pub fn string_list(
    values: &[String],
    maximum_count: usize,
    maximum_chars: usize,
    name: &str,
) -> Result<(), String> {
    if values.len() > maximum_count {
        return Err(format!("{name} 数量不能超过 {maximum_count}"));
    }
    for value in values {
        non_blank(value, maximum_chars, name)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        LoopbackEndpoint, identifier, loopback_http_base_url, non_blank, page, string_list,
    };

    #[test]
    fn validates_protocol_identifiers_and_text_boundaries() {
        assert!(identifier("topic_abc-123", "topic_", "topicId").is_ok());
        assert!(identifier("topic_", "topic_", "topicId").is_err());
        assert!(identifier("message_bad/value", "message_", "messageId").is_err());
        assert!(non_blank("  ", 20, "content").is_err());
        assert!(non_blank("正文", 20, "content").is_ok());
        assert!(page(0).is_err());
        assert!(page(100).is_ok());
        assert!(string_list(&["约束".into()], 2, 20, "constraints").is_ok());
    }

    #[test]
    fn accepts_loopback_http_base_urls() {
        assert_eq!(
            loopback_http_base_url("http://127.0.0.1:4317"),
            Ok(LoopbackEndpoint {
                host: "127.0.0.1".into(),
                port: 4317
            })
        );
        assert_eq!(
            loopback_http_base_url(" http://localhost:8080/ "),
            Ok(LoopbackEndpoint {
                host: "localhost".into(),
                port: 8080
            })
        );
        assert_eq!(
            loopback_http_base_url("http://[::1]:4317"),
            Ok(LoopbackEndpoint {
                host: "::1".into(),
                port: 4317
            })
        );
        assert_eq!(
            loopback_http_base_url("http://127.0.0.1"),
            Ok(LoopbackEndpoint {
                host: "127.0.0.1".into(),
                port: 80
            })
        );
    }

    #[test]
    fn rejects_non_loopback_or_malformed_base_urls() {
        for value in [
            "",
            "https://127.0.0.1:4317",
            "http://example.com:4317",
            "http://192.0.2.8:4317",
            "http://127.0.0.1:0",
            "http://127.0.0.1:70000",
            "http://127.0.0.1:4317/api",
            "http://user@127.0.0.1:4317",
            "http://[::1:4317",
            "http://:4317",
        ] {
            assert!(loopback_http_base_url(value).is_err(), "应拒绝：{value}");
        }
    }
}
