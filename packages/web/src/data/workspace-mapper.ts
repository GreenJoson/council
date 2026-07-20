/**
 * @input  依赖：严格解析后的 API 议题详情和 Web 领域模型
 * @output 导出：Author、Topic 摘要、TopicDetail 与 WorkspaceSnapshot 映射函数
 * @pos    后端协议和 Operator Console 展示模型之间的纯转换层；decision.status 会原样
 *         透传 accepted/superseded（只丢弃 rejected），decidedAt 取 ApiDecision.updatedAt
 *         兜底，供架构档案的 ADR 编号排序使用（真实后端没有专门的"首次接受时间"字段，
 *         这是当前可得的最佳近似，见 mapDecision 内部注释）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApiAuthor,
  ApiDecision,
  ApiMessage,
  ApiTopic,
  ApiTopicDetail,
} from "./api-types";
import type {
  AgentId,
  CouncilDecision,
  CouncilMessage,
  DecisionStatus,
  MessageKind,
  Participant,
  TopicDetail,
  TopicStatus,
  WorkspaceSnapshot,
} from "../types/council";

const PARTICIPANTS: Participant[] = [
  { id: "claude", name: "Claude", shortName: "CL", role: "方案顾问" },
  { id: "codex", name: "Codex", shortName: "CX", role: "代码审查" },
  { id: "user", name: "User", shortName: "U", role: "决策者" },
  { id: "chair", name: "Council", shortName: "CO", role: "综合协调" },
  { id: "other", name: "Other", shortName: "OT", role: "其他参与者" },
];

const MESSAGE_TITLES: Record<ApiMessage["kind"], string> = {
  brief: "议题说明",
  proposal: "方案提议",
  critique: "审查意见",
  rebuttal: "公开回应",
  synthesis: "综合结论",
  note: "补充记录",
};

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function mapApiAuthor(author: ApiAuthor): AgentId {
  return author === "human" ? "user" : author;
}

export function mapWebAuthor(author: AgentId): ApiAuthor {
  return author === "user" ? "human" : author;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return TIMESTAMP_FORMATTER.format(date);
}

function mapMessageKind(kind: ApiMessage["kind"]): MessageKind {
  return kind === "brief" ? "note" : kind;
}

function mapMessage(message: ApiMessage): CouncilMessage {
  return {
    id: message.id,
    author: mapApiAuthor(message.author),
    kind: mapMessageKind(message.kind),
    title: MESSAGE_TITLES[message.kind],
    content: message.content,
    createdLabel: formatTimestamp(message.createdAt),
  };
}

/**
 * 只有 rejected 决策整条丢弃（该状态目前在 Web UI 没有任何呈现位置）；
 * proposed/accepted/superseded 都要浮现——superseded 曾经是本议题的定论，
 * 架构档案需要它来渲染"已被取代"的 ADR 历史，不能像过去那样直接判定为"无决策"。
 */
function findCurrentDecision(decisions: ApiDecision[]): ApiDecision | undefined {
  const latestDecision = decisions.at(-1);
  return latestDecision?.status === "rejected" ? undefined : latestDecision;
}

function mapDecisionStatus(status: ApiDecision["status"]): DecisionStatus {
  if (status === "accepted" || status === "superseded") {
    return status;
  }
  return "proposed";
}

function mapDecision(decision: ApiDecision): CouncilDecision {
  const status = mapDecisionStatus(decision.status);
  return {
    title: decision.title,
    summary: decision.decision,
    rationale: decision.rationale,
    status,
    proposedBy: mapApiAuthor(decision.createdBy),
    // decidedAt 用决策记录自身的 updatedAt 兜底：真实后端没有单独记录"首次被接受的时间"，
    // 这是当前可得的最佳近似值（accepted 时会被写入一次；若之后转为 superseded，
    // updatedAt 会被再次推进，ADR 编号排序因此可能随取代动作发生的顺序而非首次接受顺序
    // 轻微漂移——这是已知的、可接受的近似，真正精确的排序需要后端补一个 acceptedAt 字段）。
    ...(status === "accepted" || status === "superseded" ? { decidedAt: decision.updatedAt } : {}),
  };
}

function mapTopicStatus(detail: ApiTopicDetail, decision: ApiDecision | undefined): TopicStatus {
  if (detail.topic.status === "decided" || detail.topic.status === "closed") {
    return "decided";
  }
  if (decision?.status === "accepted" || decision?.status === "superseded") {
    return "decided";
  }
  if (detail.messages.at(-1)?.kind === "synthesis") {
    return "synthesis";
  }
  return detail.messages.length > 0 ? "discussing" : "proposed";
}

function mapSummaryStatus(topic: ApiTopic): TopicStatus {
  return topic.status === "open" ? "open" : "decided";
}

export function mapApiTopicSummary(topic: ApiTopic): TopicDetail {
  const owner = mapApiAuthor(topic.createdBy);
  return {
    id: topic.id,
    title: topic.title,
    status: mapSummaryStatus(topic),
    updatedLabel: formatTimestamp(topic.updatedAt),
    question: topic.question,
    createdLabel: formatTimestamp(topic.createdAt),
    owner,
    participants: [owner],
    messages: [],
    constraints: topic.constraints.map((label, index) => ({
      id: `${topic.id}-constraint-${String(index)}`,
      label,
      tone: "positive" as const,
    })),
    evidence: [],
    alternatives: [],
  };
}

export function mapApiTopicDetail(detail: ApiTopicDetail): TopicDetail {
  const decision = findCurrentDecision(detail.decisions);
  const owner = mapApiAuthor(detail.topic.createdBy);
  const participantIds = new Set<AgentId>([
    owner,
    ...detail.messages.map((message) => mapApiAuthor(message.author)),
    ...detail.decisions.map((item) => mapApiAuthor(item.createdBy)),
  ]);

  return {
    id: detail.topic.id,
    title: detail.topic.title,
    status: mapTopicStatus(detail, decision),
    updatedLabel: formatTimestamp(detail.topic.updatedAt),
    question: detail.topic.question,
    createdLabel: formatTimestamp(detail.topic.createdAt),
    owner,
    participants: [...participantIds],
    messages: detail.messages.map(mapMessage),
    messageTotal: detail.messageTotal,
    constraints: detail.topic.constraints.map((label, index) => ({
      id: `${detail.topic.id}-constraint-${String(index)}`,
      label,
      tone: "positive" as const,
    })),
    evidence: [],
    alternatives: (decision?.alternatives ?? []).map((title, index) => ({
      id: `${decision?.id ?? detail.topic.id}-alternative-${String(index)}`,
      title,
      author: decision ? mapApiAuthor(decision.createdBy) : owner,
      createdLabel: decision ? formatTimestamp(decision.createdAt) : "",
    })),
    ...(decision ? { decision: mapDecision(decision) } : {}),
  };
}

function getProjectName(topics: ApiTopic[]): string {
  const paths = [
    ...new Set(
      topics
        .map((topic) => topic.projectPath)
        .filter((path): path is string => Boolean(path)),
    ),
  ];
  if (paths.length !== 1) {
    return "Council workspace";
  }
  const pathParts = paths[0]?.split(/[\\/]/).filter(Boolean) ?? [];
  return pathParts.at(-1) ?? "Council workspace";
}

export function mapWorkspaceSnapshot(
  details: ApiTopicDetail[],
  sync: WorkspaceSnapshot["sync"],
): WorkspaceSnapshot {
  const topics = details.map((detail) => detail.topic);
  return {
    project: {
      id: topics.some((topic) => topic.projectPath) ? "project-scoped" : "project-all",
      name: getProjectName(topics),
    },
    ...(details[0] ? { activeTopicId: details[0].topic.id } : {}),
    topics: details.map(mapApiTopicDetail),
    participants: PARTICIPANTS.map((participant) => ({ ...participant })),
    sync,
  };
}

export function mapWorkspaceFromTopics(
  topics: ApiTopic[],
  activeDetail: ApiTopicDetail | undefined,
  sync: WorkspaceSnapshot["sync"],
): WorkspaceSnapshot {
  return {
    project: {
      id: topics.some((topic) => topic.projectPath) ? "project-scoped" : "project-all",
      name: getProjectName(topics),
    },
    ...(activeDetail ? { activeTopicId: activeDetail.topic.id } : {}),
    topics: topics.map((topic) =>
      activeDetail?.topic.id === topic.id
        ? mapApiTopicDetail(activeDetail)
        : mapApiTopicSummary(topic),
    ),
    participants: PARTICIPANTS.map((participant) => ({ ...participant })),
    sync,
  };
}
