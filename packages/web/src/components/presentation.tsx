/**
 * @input  依赖：界面语言上下文、Agent、冻结 Actor 快照、消息、议题状态与决策状态类型
 * @output 导出：BrandLogo、AgentAvatar、StatusBadge、DecisionStatusBadge、messageKindLabels、
 *         participantFromActorSnapshot、topicStatusLabels 与 decisionStatusLabels 展示标签
 * @pos    Operator Console 跨区域复用的基础展示组件；DecisionStatusBadge 供检查器、
 *         决策记录与架构档案三处共用同一套 proposed/accepted/rejected/superseded 文案与配色
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AgentId,
  ActorSnapshot,
  DecisionStatus,
  MessageKind,
  Participant,
  TopicStatus,
} from "../types/council";
import { useI18n } from "../i18n/I18nProvider";

export function participantFromActorSnapshot(
  snapshot: ActorSnapshot | undefined,
  fallback?: Participant,
): Participant | undefined {
  if (!snapshot) {
    return fallback;
  }
  return {
    id: snapshot.actorId,
    slug: snapshot.slug,
    name: snapshot.displayName,
    shortName: snapshot.shortName,
    role: snapshot.role,
  };
}

export interface BrandLogoProps {
  size?: number;
}

/**
 * 圆桌 + 三席位 + 共识点的品牌标识，与桌面应用图标同一符号。
 * 几何正本：packages/desktop/src-tauri/icons/source/council-icon.svg（同一套 32 单位坐标），改一处请同步另一处。
 * 颜色全部走主题变量：底板随表面色、符号随主色、共识点随 Council 语义色，深浅色主题下都成立。
 */
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
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8"
        fill="var(--color-surface)"
        stroke="var(--color-border-strong)"
        strokeWidth="1"
      />
      <circle
        cx="16"
        cy="17.6"
        r="5.4"
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="1.7"
      />
      <circle cx="16" cy="17.6" r="1.6" fill="var(--color-agent-council)" />
      <circle cx="16" cy="7.2" r="2.2" fill="var(--color-primary)" />
      <circle cx="6.99" cy="22.8" r="2.2" fill="var(--color-primary)" />
      <circle cx="25.01" cy="22.8" r="2.2" fill="var(--color-primary)" />
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
  closed: "已关闭",
};

const agentNames: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  human: "User",
  council: "Council",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  "legacy-unknown": "Legacy unknown",
};

const agentShortNames: Readonly<Record<string, string>> = {
  claude: "CL",
  codex: "CX",
  human: "U",
  council: "CO",
  deepseek: "DS",
  kimi: "KI",
  "legacy-unknown": "?",
};

export interface AgentAvatarProps {
  agent: AgentId;
  participant?: Participant;
  size?: "small" | "medium";
}

function fallbackShortName(agent: string): string {
  return agent
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    || "?";
}

export function AgentAvatar({ agent, participant, size = "medium" }: AgentAvatarProps) {
  const name = participant?.name ?? agentNames[agent] ?? agent;
  const shortName = participant?.shortName ?? agentShortNames[agent] ?? fallbackShortName(agent);
  return (
    <span
      className={`agent-avatar agent-${agent} agent-avatar-${size}`}
      title={name}
      aria-label={name}
    >
      {shortName}
    </span>
  );
}

export interface StatusBadgeProps {
  status: TopicStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useI18n();
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {t(topicStatusLabels[status])}
    </span>
  );
}

/** 决策卡片标题行使用的四态中文文案。 */
export const decisionStatusLabels: Record<DecisionStatus, string> = {
  proposed: "拟议决策",
  accepted: "已接受决策",
  rejected: "已拒绝决策",
  superseded: "已被取代",
};

/** 决策卡片右上角的英文状态短标签，沿用既有 Proposed/Accepted 风格追加 Superseded */
export const decisionStatusBadgeLabels: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded",
};

export interface DecisionStatusBadgeProps {
  status: DecisionStatus;
}

/** 决策自身的四态徽章；InspectorPanel、决策记录、架构档案共用。 */
export function DecisionStatusBadge({ status }: DecisionStatusBadgeProps) {
  return (
    <span className={`decision-status-badge decision-status-${status}`}>
      {decisionStatusBadgeLabels[status]}
    </span>
  );
}
