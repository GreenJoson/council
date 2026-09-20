//! @input 依赖：Council TypeScript 内容协议与 serde
//! @output 导出：Topic、Message、Decision、议题关闭、决策包接受、实施项、分页、revision 和写入输入类型
//! @pos Rust 与现有 MCP/HTTP camelCase 领域模型的同构类型正本
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use serde::{Deserialize, Serialize};

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "lowercase")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub(crate) const fn as_db(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }

            pub(crate) fn from_db(value: &str) -> Option<Self> {
                match value {
                    $($value => Some(Self::$variant)),+,
                    _ => None,
                }
            }
        }
    };
}

string_enum!(TopicStatus {
    Open => "open",
    Decided => "decided",
    Closed => "closed",
});

string_enum!(MessageKind {
    Brief => "brief",
    Proposal => "proposal",
    Critique => "critique",
    Rebuttal => "rebuttal",
    Synthesis => "synthesis",
    Note => "note",
});

string_enum!(DecisionStatus {
    Proposed => "proposed",
    Accepted => "accepted",
    Rejected => "rejected",
    Superseded => "superseded",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemStatus {
    Pending,
    InProgress,
    Blocked,
    Completed,
}

/// 审核发现由评审尾块自动录入，manual 是手工拆的交付项。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemOrigin {
    Manual,
    ReviewFinding,
}

impl WorkItemOrigin {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::ReviewFinding => "review_finding",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "review_finding" => Some(Self::ReviewFinding),
            _ => None,
        }
    }
}

/// 只有 blocking 会拦住审核收敛；non_blocking 记录在案但放行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemSeverity {
    Blocking,
    NonBlocking,
}

impl WorkItemSeverity {
    // 桌面端只读严重度：审核发现由服务端解析评审尾块写入，这里不需要 as_db。
    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "blocking" => Some(Self::Blocking),
            "non_blocking" => Some(Self::NonBlocking),
            _ => None,
        }
    }
}

impl WorkItemStatus {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Blocked => "blocked",
            Self::Completed => "completed",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "blocked" => Some(Self::Blocked),
            "completed" => Some(Self::Completed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorSnapshot {
    pub schema_version: u32,
    pub actor_id: String,
    pub slug: String,
    pub display_name: String,
    pub short_name: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub title: String,
    pub question: String,
    pub constraints: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub status: TopicStatus,
    pub created_by_actor_id: String,
    pub created_by_snapshot: ActorSnapshot,
    pub created_at: String,
    pub updated_at: String,
    /// 不是 topics 表的列，而是列表查询顺带聚合出的派生属性：
    /// 议题导航要在不拉取每个议题详情的前提下显示「12 / 15」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_item_progress: Option<WorkItemProgress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilMessage {
    pub id: String,
    pub topic_id: String,
    pub actor_id: String,
    pub actor_snapshot: ActorSnapshot,
    pub kind: MessageKind,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub topic_id: String,
    pub title: String,
    pub decision: String,
    pub rationale: String,
    pub alternatives: Vec<String>,
    pub status: DecisionStatus,
    pub created_by_actor_id: String,
    pub created_by_snapshot: ActorSnapshot,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub topic_id: String,
    /// 审核发现可以先于决策存在，因此锚点是可选的。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub title: String,
    pub details: String,
    pub status: WorkItemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_note: Option<String>,
    pub version: u32,
    pub sort_order: i64,
    pub origin: WorkItemOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<WorkItemSeverity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cycle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_round: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_actor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_at: Option<String>,
    pub created_by_actor_id: String,
    pub created_by_snapshot: ActorSnapshot,
    pub updated_by_actor_id: String,
    pub updated_by_snapshot: ActorSnapshot,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

/// 议题级完成度。父任务状态由子任务派生，分母只数叶子节点，
/// 否则一次两层拆解会把同一件事数两次。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemProgress {
    pub total: u64,
    pub completed: u64,
    pub blocked: u64,
    pub open_blocking_findings: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicDetail {
    pub topic: Topic,
    pub messages: Vec<CouncilMessage>,
    pub decisions: Vec<Decision>,
    pub work_items: Vec<WorkItem>,
    pub message_total: u64,
    pub message_limit: u32,
    pub message_offset: u32,
    pub has_more_messages: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_message_offset: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedTopics {
    pub total: u64,
    pub count: u64,
    pub offset: u32,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
    pub topics: Vec<Topic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilRevisions {
    pub total: u64,
    pub content: u64,
    pub orchestration: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateTopicInput {
    pub title: String,
    pub question: String,
    pub constraints: Vec<String>,
    pub project_path: Option<String>,
    pub created_by_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseTopicInput {
    pub topic_id: String,
    pub actor_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostMessageInput {
    pub topic_id: String,
    pub actor_alias: String,
    pub kind: MessageKind,
    pub content: String,
    pub parent_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordDecisionInput {
    pub topic_id: String,
    pub title: String,
    pub decision: String,
    pub rationale: String,
    pub alternatives: Vec<String>,
    pub status: DecisionStatus,
    pub created_by_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptDecisionsInput {
    pub topic_id: String,
    pub decision_ids: Vec<String>,
    pub actor_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateWorkItemEntry {
    pub title: String,
    pub details: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateWorkItemsInput {
    pub topic_id: String,
    pub decision_id: Option<String>,
    /// 给了就挂成子任务，并继承父任务的决策锚点。
    pub parent_id: Option<String>,
    pub items: Vec<CreateWorkItemEntry>,
    pub actor_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateWorkItemInput {
    pub topic_id: String,
    pub work_item_id: String,
    pub status: WorkItemStatus,
    pub status_note: Option<String>,
    /// 标记完成时附上修复所在的 commit，作为复审的证据入口。
    pub fix_commit: Option<String>,
    pub expected_version: u32,
    pub actor_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimWorkItemInput {
    pub topic_id: String,
    pub work_item_id: String,
    pub status_note: Option<String>,
    pub expected_version: u32,
    pub actor_alias: String,
}

#[cfg(test)]
mod tests {
    use super::{ActorSnapshot, CouncilMessage, MessageKind};

    #[test]
    fn serializes_camel_case_and_omits_absent_parent() {
        let message = CouncilMessage {
            id: "message_test".into(),
            topic_id: "topic_test".into(),
            actor_id: "claude".into(),
            actor_snapshot: ActorSnapshot {
                schema_version: 1,
                actor_id: "claude".into(),
                slug: "claude".into(),
                display_name: "Claude".into(),
                short_name: "CL".into(),
                role: "方案顾问".into(),
            },
            kind: MessageKind::Proposal,
            content: "方案".into(),
            parent_message_id: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
        };

        let value = serde_json::to_value(message).expect("message should serialize");
        assert_eq!(value["topicId"], "topic_test");
        assert_eq!(value["actorId"], "claude");
        assert!(value.get("parentMessageId").is_none());
    }
}
