/**
 * @input  依赖：Council REST API 返回的未知 JSON 值
 * @output 导出：含动态 Actor 快照、完整 decisions[] 与实施项的后端协议类型及严格运行时解析函数
 * @pos    HTTP 边界的唯一数据校验入口，禁止未验证数据进入 UI
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type ApiTopicStatus = "open" | "decided" | "closed";
export type ApiMessageKind =
  | "brief"
  | "proposal"
  | "critique"
  | "rebuttal"
  | "synthesis"
  | "note";
export type ApiDecisionStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type ApiWorkItemStatus = "pending" | "in_progress" | "blocked" | "completed";
export type ApiWorkItemOrigin = "manual" | "review_finding";
export type ApiWorkItemSeverity = "blocking" | "non_blocking";

export interface ApiWorkItemProgress {
  total: number;
  completed: number;
  blocked: number;
  openBlockingFindings: number;
}

export interface ApiActorSnapshot {
  schemaVersion: 1;
  actorId: string;
  slug: string;
  displayName: string;
  shortName: string;
  role: string;
}

export interface ApiTopic {
  id: string;
  title: string;
  question: string;
  constraints: string[];
  projectPath?: string;
  status: ApiTopicStatus;
  createdByActorId: string;
  createdBySnapshot: ApiActorSnapshot;
  createdAt: string;
  updatedAt: string;
  /** 列表查询顺带聚合出来的完成度；没有实施项的议题不带这个字段。 */
  workItemProgress?: ApiWorkItemProgress;
}

export interface ApiMessage {
  id: string;
  topicId: string;
  actorId: string;
  actorSnapshot: ApiActorSnapshot;
  kind: ApiMessageKind;
  content: string;
  parentMessageId?: string;
  createdAt: string;
}

export interface ApiDecision {
  id: string;
  topicId: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  status: ApiDecisionStatus;
  createdByActorId: string;
  createdBySnapshot: ApiActorSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface ApiWorkItem {
  id: string;
  topicId: string;
  decisionId?: string;
  parentId?: string;
  title: string;
  details: string;
  status: ApiWorkItemStatus;
  statusNote?: string;
  sortOrder: number;
  origin: ApiWorkItemOrigin;
  severity?: ApiWorkItemSeverity;
  sourceMessageId?: string;
  sourceCycleId?: string;
  reviewRound?: number;
  fixCommit?: string;
  assigneeActorId?: string;
  claimedAt?: string;
  version: number;
  createdByActorId: string;
  createdBySnapshot: ApiActorSnapshot;
  updatedByActorId: string;
  updatedBySnapshot: ApiActorSnapshot;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ApiTopicDetail {
  topic: ApiTopic;
  messages: ApiMessage[];
  decisions: ApiDecision[];
  workItems: ApiWorkItem[];
  messageTotal: number;
  messageLimit: number;
  messageOffset: number;
  hasMoreMessages: boolean;
  nextMessageOffset?: number;
}

export interface ApiPaginatedTopics {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  topics: ApiTopic[];
}

export interface ApiEnvelope {
  code: number;
  message: string;
  data?: unknown;
  timestamp: string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} 必须是字符串`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} 必须是字符串`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} 必须是有限数字`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} 必须是有限数字`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} 必须是布尔值`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} 必须是字符串数组`);
  }
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = readString(record, key);
  if (!allowed.includes(value as T)) {
    throw new Error(`${key} 包含不支持的值`);
  }
  return value as T;
}

function readArray<T>(
  record: Record<string, unknown>,
  key: string,
  parser: (value: unknown, index: number) => T,
): T[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} 必须是数组`);
  }
  return value.map(parser);
}

const TOPIC_STATUSES: readonly ApiTopicStatus[] = ["open", "decided", "closed"];
const MESSAGE_KINDS: readonly ApiMessageKind[] = [
  "brief",
  "proposal",
  "critique",
  "rebuttal",
  "synthesis",
  "note",
];
const DECISION_STATUSES: readonly ApiDecisionStatus[] = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
];
const WORK_ITEM_STATUSES: readonly ApiWorkItemStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
];
const WORK_ITEM_ORIGINS: readonly ApiWorkItemOrigin[] = ["manual", "review_finding"];
const WORK_ITEM_SEVERITIES: readonly ApiWorkItemSeverity[] = ["blocking", "non_blocking"];

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = readNumber(record, key);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} 必须是非负整数`);
  }
  return value;
}

function parseApiWorkItemProgress(value: unknown): ApiWorkItemProgress {
  const record = readRecord(value, "work item progress");
  return {
    total: readNonNegativeInteger(record, "total"),
    completed: readNonNegativeInteger(record, "completed"),
    blocked: readNonNegativeInteger(record, "blocked"),
    openBlockingFindings: readNonNegativeInteger(record, "openBlockingFindings"),
  };
}

export function parseApiEnvelope(value: unknown): ApiEnvelope {
  const record = readRecord(value, "响应");
  const timestamp = record.timestamp;
  if (typeof timestamp !== "string" && typeof timestamp !== "number") {
    throw new Error("timestamp 必须是字符串或数字");
  }
  return {
    code: readNumber(record, "code"),
    message: readString(record, "message"),
    ...(record.data !== undefined ? { data: record.data } : {}),
    timestamp,
  };
}

export function parseApiActorSnapshot(value: unknown): ApiActorSnapshot {
  const record = readRecord(value, "actor snapshot");
  const schemaVersion = readNumber(record, "schemaVersion");
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion !== 1) {
    throw new Error("schemaVersion 必须是受支持的 Actor 快照版本");
  }
  return {
    schemaVersion: 1,
    actorId: readString(record, "actorId"),
    slug: readString(record, "slug"),
    displayName: readString(record, "displayName"),
    shortName: readString(record, "shortName"),
    role: readString(record, "role"),
  };
}

export function parseApiTopic(value: unknown): ApiTopic {
  const record = readRecord(value, "topic");
  const projectPath = readOptionalString(record, "projectPath");
  const createdByActorId = readString(record, "createdByActorId");
  const createdBySnapshot = parseApiActorSnapshot(record.createdBySnapshot);
  if (createdBySnapshot.actorId !== createdByActorId) {
    throw new Error("topic Actor snapshot 与索引身份不一致");
  }
  return {
    id: readString(record, "id"),
    title: readString(record, "title"),
    question: readString(record, "question"),
    constraints: readStringArray(record, "constraints"),
    ...(projectPath ? { projectPath } : {}),
    status: readEnum(record, "status", TOPIC_STATUSES),
    createdByActorId,
    createdBySnapshot,
    createdAt: readString(record, "createdAt"),
    updatedAt: readString(record, "updatedAt"),
    ...(record.workItemProgress === undefined
      ? {}
      : { workItemProgress: parseApiWorkItemProgress(record.workItemProgress) }),
  };
}

export function parseApiMessage(value: unknown): ApiMessage {
  const record = readRecord(value, "message");
  const parentMessageId = readOptionalString(record, "parentMessageId");
  const actorId = readString(record, "actorId");
  const actorSnapshot = parseApiActorSnapshot(record.actorSnapshot);
  if (actorSnapshot.actorId !== actorId) {
    throw new Error("message Actor snapshot 与索引身份不一致");
  }
  return {
    id: readString(record, "id"),
    topicId: readString(record, "topicId"),
    actorId,
    actorSnapshot,
    kind: readEnum(record, "kind", MESSAGE_KINDS),
    content: readString(record, "content"),
    ...(parentMessageId ? { parentMessageId } : {}),
    createdAt: readString(record, "createdAt"),
  };
}

export function parseApiDecision(value: unknown): ApiDecision {
  const record = readRecord(value, "decision");
  const createdByActorId = readString(record, "createdByActorId");
  const createdBySnapshot = parseApiActorSnapshot(record.createdBySnapshot);
  if (createdBySnapshot.actorId !== createdByActorId) {
    throw new Error("decision Actor snapshot 与索引身份不一致");
  }
  return {
    id: readString(record, "id"),
    topicId: readString(record, "topicId"),
    title: readString(record, "title"),
    decision: readString(record, "decision"),
    rationale: readString(record, "rationale"),
    alternatives: readStringArray(record, "alternatives"),
    status: readEnum(record, "status", DECISION_STATUSES),
    createdByActorId,
    createdBySnapshot,
    createdAt: readString(record, "createdAt"),
    updatedAt: readString(record, "updatedAt"),
  };
}

export function parseApiWorkItem(value: unknown): ApiWorkItem {
  const record = readRecord(value, "work item");
  const createdByActorId = readString(record, "createdByActorId");
  const createdBySnapshot = parseApiActorSnapshot(record.createdBySnapshot);
  const updatedByActorId = readString(record, "updatedByActorId");
  const updatedBySnapshot = parseApiActorSnapshot(record.updatedBySnapshot);
  if (createdBySnapshot.actorId !== createdByActorId) {
    throw new Error("work item creator snapshot 与索引身份不一致");
  }
  if (updatedBySnapshot.actorId !== updatedByActorId) {
    throw new Error("work item updater snapshot 与索引身份不一致");
  }
  const statusNote = readOptionalString(record, "statusNote");
  const completedAt = readOptionalString(record, "completedAt");
  const decisionId = readOptionalString(record, "decisionId");
  const parentId = readOptionalString(record, "parentId");
  const severity = record.severity === undefined
    ? undefined
    : readEnum(record, "severity", WORK_ITEM_SEVERITIES);
  const sourceMessageId = readOptionalString(record, "sourceMessageId");
  const sourceCycleId = readOptionalString(record, "sourceCycleId");
  const reviewRound = readOptionalNumber(record, "reviewRound");
  const fixCommit = readOptionalString(record, "fixCommit");
  const assigneeActorId = readOptionalString(record, "assigneeActorId");
  const claimedAt = readOptionalString(record, "claimedAt");
  const version = readNumber(record, "version");
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("work item version 必须是正整数");
  }
  return {
    id: readString(record, "id"),
    topicId: readString(record, "topicId"),
    ...(decisionId ? { decisionId } : {}),
    ...(parentId ? { parentId } : {}),
    title: readString(record, "title"),
    details: readString(record, "details"),
    status: readEnum(record, "status", WORK_ITEM_STATUSES),
    ...(statusNote ? { statusNote } : {}),
    sortOrder: readNonNegativeInteger(record, "sortOrder"),
    origin: readEnum(record, "origin", WORK_ITEM_ORIGINS),
    ...(severity ? { severity } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(sourceCycleId ? { sourceCycleId } : {}),
    ...(reviewRound === undefined ? {} : { reviewRound }),
    ...(fixCommit ? { fixCommit } : {}),
    ...(assigneeActorId ? { assigneeActorId } : {}),
    ...(claimedAt ? { claimedAt } : {}),
    version,
    createdByActorId,
    createdBySnapshot,
    updatedByActorId,
    updatedBySnapshot,
    createdAt: readString(record, "createdAt"),
    updatedAt: readString(record, "updatedAt"),
    ...(completedAt ? { completedAt } : {}),
  };
}

export function parseApiWorkItems(value: unknown): ApiWorkItem[] {
  if (!Array.isArray(value)) {
    throw new Error("work items 必须是数组");
  }
  return value.map((item) => parseApiWorkItem(item));
}

export function parseApiDecisions(value: unknown): ApiDecision[] {
  if (!Array.isArray(value)) {
    throw new Error("decisions 必须是数组");
  }
  return value.map((item) => parseApiDecision(item));
}

export function parseApiTopicDetail(value: unknown): ApiTopicDetail {
  const record = readRecord(value, "topic detail");
  const nextMessageOffset = readOptionalNumber(record, "nextMessageOffset");
  return {
    topic: parseApiTopic(record.topic),
    messages: readArray(record, "messages", (item) => parseApiMessage(item)),
    decisions: readArray(record, "decisions", (item) => parseApiDecision(item)),
    workItems: readArray(record, "workItems", (item) => parseApiWorkItem(item)),
    messageTotal: readNumber(record, "messageTotal"),
    messageLimit: readNumber(record, "messageLimit"),
    messageOffset: readNumber(record, "messageOffset"),
    hasMoreMessages: readBoolean(record, "hasMoreMessages"),
    ...(nextMessageOffset !== undefined ? { nextMessageOffset } : {}),
  };
}

export function parseApiPaginatedTopics(value: unknown): ApiPaginatedTopics {
  const record = readRecord(value, "topics page");
  const nextOffset = readOptionalNumber(record, "nextOffset");
  return {
    total: readNumber(record, "total"),
    count: readNumber(record, "count"),
    offset: readNumber(record, "offset"),
    hasMore: readBoolean(record, "hasMore"),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    topics: readArray(record, "topics", (item) => parseApiTopic(item)),
  };
}
