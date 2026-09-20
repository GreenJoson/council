/**
 * @input  依赖：严格解析后的 API Actor 快照、议题详情和 Web 领域模型
 * @output 导出：动态参与者、实施项、Topic 摘要、TopicDetail 与 WorkspaceSnapshot 映射函数
 * @pos    后端 ActorIdentity 协议和 Operator Console 展示模型之间的纯转换层；
 *         决策数组与 proposed/accepted/rejected/superseded 四态原样透传
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApiActorSnapshot,
  ApiDecision,
  ApiMessage,
  ApiTopic,
  ApiTopicDetail,
  ApiWorkItem,
} from "./api-types";
import type {
  CouncilDecision,
  CouncilMessage,
  CouncilWorkItem,
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
    for (const item of detail.workItems) {
      remember(item.createdBySnapshot);
      remember(item.updatedBySnapshot);
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

function mapWorkItem(item: ApiWorkItem): CouncilWorkItem {
  return {
    id: item.id,
    ...(item.decisionId ? { decisionId: item.decisionId } : {}),
    ...(item.parentId ? { parentId: item.parentId } : {}),
    title: item.title,
    details: item.details,
    status: item.status,
    ...(item.statusNote ? { statusNote: item.statusNote } : {}),
    version: item.version,
    sortOrder: item.sortOrder,
    origin: item.origin,
    ...(item.severity ? { severity: item.severity } : {}),
    ...(item.sourceMessageId ? { sourceMessageId: item.sourceMessageId } : {}),
    ...(item.reviewRound === undefined ? {} : { reviewRound: item.reviewRound }),
    ...(item.fixCommit ? { fixCommit: item.fixCommit } : {}),
    ...(item.assigneeActorId ? { assignee: item.assigneeActorId } : {}),
    ...(item.claimedAt ? { claimedLabel: formatTimestamp(item.claimedAt) } : {}),
    createdBy: item.createdByActorId,
    createdBySnapshot: actorSnapshotFromApi(item.createdBySnapshot),
    updatedBy: item.updatedByActorId,
    updatedBySnapshot: actorSnapshotFromApi(item.updatedBySnapshot),
    createdLabel: formatTimestamp(item.createdAt),
    updatedLabel: formatTimestamp(item.updatedAt),
    ...(item.completedAt ? { completedLabel: formatTimestamp(item.completedAt) } : {}),
  };
}

function mapDecisionStatus(status: ApiDecision["status"]): DecisionStatus {
  return status;
}

function mapDecision(decision: ApiDecision): CouncilDecision {
  const status = mapDecisionStatus(decision.status);
  return {
    id: decision.id,
    title: decision.title,
    summary: decision.decision,
    rationale: decision.rationale,
    status,
    proposedBy: decision.createdByActorId,
    proposedBySnapshot: actorSnapshotFromApi(decision.createdBySnapshot),
    createdAt: decision.createdAt,
    // 后端尚无 acceptedAt，当前用 updatedAt 作为可审计的最佳近似。
    ...(status === "accepted" || status === "superseded"
      ? { decidedAt: decision.updatedAt }
      : {}),
  };
}

function mapTopicStatus(detail: ApiTopicDetail): TopicStatus {
  if (detail.topic.status === "closed") {
    return "closed";
  }
  if (detail.topic.status === "decided") {
    return "decided";
  }
  if (
    detail.decisions.some((decision) => decision.status === "accepted")
    && !detail.decisions.some((decision) => decision.status === "proposed")
  ) {
    return "decided";
  }
  if (detail.messages.at(-1)?.kind === "synthesis") {
    return "synthesis";
  }
  return detail.messages.length > 0 ? "discussing" : "proposed";
}

function mapSummaryStatus(topic: ApiTopic): TopicStatus {
  return topic.status === "open" ? "open" : topic.status;
}

export function mapApiTopicSummary(topic: ApiTopic): TopicDetail {
  const owner = topic.createdByActorId;
  return {
    id: topic.id,
    title: topic.title,
    status: mapSummaryStatus(topic),
    updatedLabel: formatTimestamp(topic.updatedAt),
    ...(topic.workItemProgress ? { workItemProgress: topic.workItemProgress } : {}),
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
    workItems: [],
    decisions: [],
  };
}

export function mapApiTopicDetail(detail: ApiTopicDetail): TopicDetail {
  const referenceDecision = [...detail.decisions]
    .reverse()
    .find((decision) => decision.status === "proposed" || decision.status === "accepted");
  const owner = detail.topic.createdByActorId;
  const participantIds = new Set<string>([
    owner,
    ...detail.messages.map((message) => message.actorId),
    ...detail.decisions.map((item) => item.createdByActorId),
    ...detail.workItems.flatMap((item) => [item.createdByActorId, item.updatedByActorId]),
  ]);

  return {
    id: detail.topic.id,
    title: detail.topic.title,
    status: mapTopicStatus(detail),
    updatedLabel: formatTimestamp(detail.topic.updatedAt),
    ...(detail.topic.workItemProgress
      ? { workItemProgress: detail.topic.workItemProgress }
      : {}),
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
    alternatives: (referenceDecision?.alternatives ?? []).map((title, index) => ({
      id: `${referenceDecision?.id ?? detail.topic.id}-alternative-${String(index)}`,
      title,
      author: referenceDecision?.createdByActorId ?? owner,
      ...(referenceDecision
        ? { authorSnapshot: actorSnapshotFromApi(referenceDecision.createdBySnapshot) }
        : { authorSnapshot: actorSnapshotFromApi(detail.topic.createdBySnapshot) }),
      createdLabel: referenceDecision ? formatTimestamp(referenceDecision.createdAt) : "",
    })),
    workItems: detail.workItems.map(mapWorkItem),
    decisions: detail.decisions.map(mapDecision),
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
