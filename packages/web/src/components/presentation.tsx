/**
 * @input  依赖：Agent、消息和议题状态类型
 * @output 导出：AgentAvatar、StatusBadge 与展示标签
 * @pos    Operator Console 跨区域复用的基础展示组件
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { AgentId, MessageKind, TopicStatus } from "../types/council";

export const messageKindLabels: Record<MessageKind, string> = {
  proposal: "Proposal",
  critique: "Critique",
  rebuttal: "Rebuttal",
  synthesis: "Synthesis",
  note: "Note",
};

const topicStatusLabels: Record<TopicStatus, string> = {
  open: "Open",
  proposed: "Proposed",
  discussing: "In discussion",
  synthesis: "Synthesis",
  decided: "Decided",
};

const agentNames: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  user: "User",
  chair: "Council",
  other: "Other",
};

const agentShortNames: Record<AgentId, string> = {
  claude: "CL",
  codex: "CX",
  user: "U",
  chair: "CO",
  other: "OT",
};

export interface AgentAvatarProps {
  agent: AgentId;
  size?: "small" | "medium";
}

export function AgentAvatar({ agent, size = "medium" }: AgentAvatarProps) {
  return (
    <span
      className={`agent-avatar agent-${agent} agent-avatar-${size}`}
      title={agentNames[agent]}
      aria-label={agentNames[agent]}
    >
      {agentShortNames[agent]}
    </span>
  );
}

export interface StatusBadgeProps {
  status: TopicStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {topicStatusLabels[status]}
    </span>
  );
}
