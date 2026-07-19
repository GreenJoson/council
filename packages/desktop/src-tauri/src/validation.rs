/**
 * @input  依赖：来自 Tauri IPC 的路径、分页、ID 与文本参数
 * @output 导出：与现有 HTTP/MCP 协议一致的输入校验函数
 * @pos    未验证前端输入进入 Rust core 前的唯一边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
use std::path::Path;

pub const MAX_LIST_LIMIT: u32 = 100;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_QUESTION_CHARS: usize = 12_000;
pub const MAX_MESSAGE_CHARS: usize = 30_000;
pub const MAX_CONSTRAINT_COUNT: usize = 50;
pub const MAX_CONSTRAINT_CHARS: usize = 1_000;
pub const MAX_ALTERNATIVE_COUNT: usize = 30;

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
    use super::{identifier, non_blank, page, string_list};

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
}
