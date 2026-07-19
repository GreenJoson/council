//! @input 依赖：rusqlite 持久化错误与领域失败语义
//! @output 导出：CouncilError 和 CouncilResult
//! @pos SQLite 实现与未来桌面协议层之间的稳定错误边界
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use thiserror::Error;

pub type CouncilResult<T> = Result<T, CouncilError>;

#[derive(Debug, Error)]
pub enum CouncilError {
    #[error("SQLite 操作失败：{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON 编码失败：{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    InvalidConfiguration(String),
    #[error("{0}")]
    InvalidData(String),
}
