//! @input 依赖：council-core 内部 SQLite 存储、错误与领域模块
//! @output 导出：CouncilStore、公开输入、领域类型和 CouncilError
//! @pos Council Rust 内容核心的唯一公共入口
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

mod error;
mod store;
mod types;

pub use error::{CouncilError, CouncilResult};
pub use store::CouncilStore;
pub use types::{
    ActorSnapshot, CouncilMessage, CouncilRevisions, CreateTopicInput, Decision, DecisionStatus,
    MessageKind, PaginatedTopics, PostMessageInput, RecordDecisionInput, Topic, TopicDetail,
    TopicStatus,
};
