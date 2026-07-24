/**
 * @input  依赖：严格解析后的 API Actor 快照、议题详情和 Web 领域模型
 * @output 导出：动态参与者、Topic 摘要、TopicDetail 与 WorkspaceSnapshot 映射函数
 * @pos    后端 ActorIdentity 协议和 Operator Console 展示模型之间的纯转换层；
 *         决策状态原样透传 accepted/superseded（只丢弃 rejected）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApiActorSnapshot,
  ApiDecision,
  ApiMessage,
  ApiTopic,
  ApiTopicDetail,
} from "./api-types";
import type {
  CouncilDecision,
  CouncilMessage,
  ActorSnapshot,
  DecisionStatus,
  MessageKind,
  Participant,
  TopicDetail,
  TopicStatus,
  WorkspaceSnapshot,
} from "../types/council";

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

function participantFromSnapshot(snapshot: ApiActorSnapshot): Participant {
  return {
    id: snapshot.actorId,
    slug: snapshot.slug,
    name: snapshot.displayName,
    shortName: snapshot.shortName,
    role: snapshot.role,
  };
}

function actorSnapshotFromApi(snapshot: ApiActorSnapshot): ActorSnapshot {
  return {
    schemaVersion: 1,
    actorId: snapshot.actorId,
    slug: snapshot.slug,
    displayName: snapshot.displayName,
    shortName: snapshot.shortName,
    role: snapshot.role,
  };
}

function collectParticipants(
  topics: readonly ApiTopic[],
  details: readonly ApiTopicDetail[],
): Participant[] {
  const participants = new Map<string, Participant>();
  const remember = (snapshot: ApiActorSnapshot): void => {
    participants.set(snapshot.actorId, participantFromSnapshot(snapshot));
  };
  for (const topic of topics) {
    remember(topic.createdBySnapshot);
  }
  for (const detail of details) {
    remember(detail.topic.createdBySnapshot);
    for (const message of detail.messages) {
      remember(message.actorSnapshot);
    }
    for (const decision of detail.decisions) {
      remember(decision.createdBySnapshot);
    }
  }
  return [...participants.values()];
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
    author: message.actorId,
    actorSnapshot: actorSnapshotFromApi(message.actorSnapshot),
    kind: mapMessageKind(message.kind),
    title: MESSAGE_TITLES[message.kind],
    content: message.content,
    createdLabel: formatTimestamp(message.createdAt),
  };
}

/**
 * 只有 rejected 决策整条丢弃；proposed/accepted/superseded 都需要进入决策档案。
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
    proposedBy: decision.createdByActorId,
    proposedBySnapshot: actorSnapshotFromApi(decision.createdBySnapshot),
    // 后端尚无 acceptedAt，当前用 updatedAt 作为可审计的最佳近似。
    ...(status === "accepted" || status === "superseded"
      ? { decidedAt: decision.updatedAt }
      : {}),
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
  const owner = topic.createdByActorId;
  return {
    id: topic.id,
    title: topic.title,
    status: mapSummaryStatus(topic),
    updatedLabel: formatTimestamp(topic.updatedAt),
    question: topic.question,
    createdLabel: formatTimestamp(topic.createdAt),
    owner,
    ownerSnapshot: actorSnapshotFromApi(topic.createdBySnapshot),
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
  const owner = detail.topic.createdByActorId;
  const participantIds = new Set<string>([
    owner,
    ...detail.messages.map((message) => message.actorId),
    ...detail.decisions.map((item) => item.createdByActorId),
  ]);

  return {
    id: detail.topic.id,
    title: detail.topic.title,
    status: mapTopicStatus(detail, decision),
    updatedLabel: formatTimestamp(detail.topic.updatedAt),
    question: detail.topic.question,
    createdLabel: formatTimestamp(detail.topic.createdAt),
    owner,
    ownerSnapshot: actorSnapshotFromApi(detail.topic.createdBySnapshot),
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
      author: decision?.createdByActorId ?? owner,
      ...(decision
        ? { authorSnapshot: actorSnapshotFromApi(decision.createdBySnapshot) }
        : { authorSnapshot: actorSnapshotFromApi(detail.topic.createdBySnapshot) }),
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
        .filter((projectPath): projectPath is string => Boolean(projectPath)),
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
    participants: collectParticipants(topics, details),
    sync,
  };
}

export function mapWorkspaceFromTopics(
  topics: ApiTopic[],
  activeDetail: ApiTopicDetail | undefined,
  sync: WorkspaceSnapshot["sync"],
): WorkspaceSnapshot {
  const details = activeDetail ? [activeDetail] : [];
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
    participants: collectParticipants(topics, details),
    sync,
  };
}
