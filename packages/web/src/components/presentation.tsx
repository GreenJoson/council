/**
 * @input  依赖：Agent、消息、议题状态与决策状态类型
 * @output 导出：BrandLogo、AgentAvatar、StatusBadge、DecisionStatusBadge、messageKindLabels、
 *         topicStatusLabels 与 decisionStatusLabels 展示标签
 * @pos    Operator Console 跨区域复用的基础展示组件；DecisionStatusBadge 供检查器、
 *         决策记录与架构档案三处共用同一套 proposed/accepted/superseded 文案与配色
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { AgentId, DecisionStatus, MessageKind, TopicStatus } from "../types/council";

export interface BrandLogoProps {
  size?: number;
}

/** 圆桌 + 三席位的品牌标识；颜色走主题变量，深浅色主题下都成立 */
export function BrandLogo({ size = 26 }: BrandLogoProps) {
  return (
    <svg
      className="brand-logo"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--color-primary)" />
      <circle
        cx="16"
        cy="17.4"
        r="5.2"
        fill="none"
        stroke="var(--color-text-on-primary)"
        strokeWidth="2.1"
      />
      <circle cx="16" cy="7.4" r="2.5" fill="var(--color-text-on-primary)" />
      <circle cx="8.2" cy="22.8" r="2.5" fill="var(--color-text-on-primary)" />
      <circle cx="23.8" cy="22.8" r="2.5" fill="var(--color-text-on-primary)" />
    </svg>
  );
}

export const messageKindLabels: Record<MessageKind, string> = {
  proposal: "Proposal",
  critique: "Critique",
  rebuttal: "Rebuttal",
  synthesis: "Synthesis",
  note: "Note",
};

export const topicStatusLabels: Record<TopicStatus, string> = {
  open: "开放",
  proposed: "提案中",
  discussing: "讨论中",
  synthesis: "综合中",
  decided: "已决策",
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

/** 决策卡片标题行使用的中文文案（"拟议决策"/"已接受决策"/"已被取代"） */
export const decisionStatusLabels: Record<DecisionStatus, string> = {
  proposed: "拟议决策",
  accepted: "已接受决策",
  superseded: "已被取代",
};

/** 决策卡片右上角的英文状态短标签，沿用既有 Proposed/Accepted 风格追加 Superseded */
export const decisionStatusBadgeLabels: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  superseded: "Superseded",
};

export interface DecisionStatusBadgeProps {
  status: DecisionStatus;
}

/** 决策自身的 proposed/accepted/superseded 徽章；InspectorPanel、决策记录、架构档案共用 */
export function DecisionStatusBadge({ status }: DecisionStatusBadgeProps) {
  return (
    <span className={`decision-status-badge decision-status-${status}`}>
      {decisionStatusBadgeLabels[status]}
    </span>
  );
}
