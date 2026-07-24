//! @input 依赖：Council TypeScript 内容协议与 serde
//! @output 导出：Topic、Message、Decision、分页、revision 和写入输入类型
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
pub struct TopicDetail {
    pub topic: Topic,
    pub messages: Vec<CouncilMessage>,
    pub decisions: Vec<Decision>,
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
