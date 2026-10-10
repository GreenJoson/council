//! @input 依赖：council-core 内部 SQLite 存储、错误与领域模块
//! @output 导出：CouncilStore、议题关闭、决策包接受等公开输入、领域类型（含 v18 WorkItemKind/WorkItemSource、v19 Asset/AssetLink）和 CouncilError
//! @pos Council Rust 内容核心的唯一公共入口
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

mod error;
mod store;
mod types;

pub use error::{CouncilError, CouncilResult};
pub use store::CouncilStore;
pub use types::{
    AcceptDecisionsInput, ActorSnapshot, Asset, AssetKind, AssetLink, AssetLinkRole,
    AssetLinkTargetKind, AssetOrigin, AssetTargetFilter, ClaimWorkItemInput, CloseTopicInput,
    CouncilMessage, CouncilRevisions, CreateTopicInput, CreateWorkItemEntry, CreateWorkItemsInput,
    Decision, DecisionStatus, MessageKind, PaginatedAssets, PaginatedTopics, PostMessageInput,
    RecordDecisionInput, Topic, TopicDetail, TopicStatus, UpdateWorkItemInput, WorkItem,
    WorkItemKind, WorkItemOrigin, WorkItemProgress, WorkItemSeverity, WorkItemSource,
    WorkItemStatus,
};
