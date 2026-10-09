/**
 * @input  依赖：MCP SDK CallToolResult、Zod、共享常量、委派状态枚举、CouncilValidationError、logger 与领域类型
 * @output 导出：council_* 工具共用的 Zod 字段/输出 schema（实施项含 v18 任务字段、委派 topicId 可选）、success/publicError/executeTool 包装与文本格式化函数（含任务与委派）
 * @pos    MCP 工具模块的共享件，不注册任何工具
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import {
  MAX_ID_CHARS,
  MESSAGE_KINDS,
  TOPIC_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_ORIGINS,
  WORK_ITEM_SEVERITIES,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
} from "../constants.js";
import { CouncilValidationError } from "../errors.js";
import {
  WORK_ITEM_DELEGATION_STATUSES,
  type WorkItemDelegation,
} from "../orchestration/work-item-delegation-store.js";
import { logger } from "../logger.js";
import type {
  CouncilMessage,
  Decision,
  PaginatedTopics,
  Topic,
  TopicDetail,
  WorkItem,
} from "../types.js";

export const topicIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^topic_[A-Za-z0-9-]+$/, "topic_id 格式无效")
  .describe("Council 议题 ID，例如 topic_<uuid>");
export const messageKindField = z.enum(MESSAGE_KINDS);
export const topicStatusField = z.enum(TOPIC_STATUSES);
export const decisionStatusField = z.enum(["proposed", "accepted", "rejected", "superseded"]);
export const workItemStatusField = z.enum(WORK_ITEM_STATUSES);

export const actorSnapshotOutput = z.object({
  schemaVersion: z.literal(1),
  actorId: z.string(),
  slug: z.string(),
  displayName: z.string(),
  shortName: z.string(),
  role: z.string(),
});
export const workItemProgressOutput = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  openBlockingFindings: z.number().int().nonnegative(),
});
export const topicOutput = z.object({
  id: z.string(),
  title: z.string(),
  question: z.string(),
  constraints: z.array(z.string()),
  projectPath: z.string().optional(),
  status: topicStatusField,
  createdByActorId: z.string(),
  createdBySnapshot: actorSnapshotOutput,
  createdAt: z.string(),
  updatedAt: z.string(),
  workItemProgress: workItemProgressOutput.optional(),
});
export const messageOutput = z.object({
  id: z.string(),
  topicId: z.string(),
  actorId: z.string(),
  actorSnapshot: actorSnapshotOutput,
  kind: messageKindField,
  content: z.string(),
  parentMessageId: z.string().optional(),
  createdAt: z.string(),
});
export const decisionOutput = z.object({
  id: z.string(),
  topicId: z.string(),
  title: z.string(),
  decision: z.string(),
  rationale: z.string(),
  alternatives: z.array(z.string()),
  status: decisionStatusField,
  createdByActorId: z.string(),
  createdBySnapshot: actorSnapshotOutput,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const workItemOutput = z.object({
  id: z.string(),
  // v18 起非议题任务没有议题；议题内工具返回的实施项仍总是带 topicId。
  topicId: z.string().optional(),
  kind: z.enum(WORK_ITEM_KINDS),
  source: z.enum(WORK_ITEM_SOURCES),
  priority: z.number().int(),
  projectPath: z.string().optional(),
  brief: z.record(z.string(), z.unknown()).optional(),
  // 审核发现可以先于决策存在，所以锚点是可选的。
  decisionId: z.string().optional(),
  parentId: z.string().optional(),
  title: z.string(),
  details: z.string(),
  status: workItemStatusField,
  statusNote: z.string().optional(),
  version: z.number().int().positive(),
  sortOrder: z.number().int().nonnegative(),
  origin: z.enum(WORK_ITEM_ORIGINS),
  severity: z.enum(WORK_ITEM_SEVERITIES).optional(),
  sourceMessageId: z.string().optional(),
  sourceCycleId: z.string().optional(),
  reviewRound: z.number().int().positive().optional(),
  fixCommit: z.string().optional(),
  assigneeActorId: z.string().optional(),
  claimedAt: z.string().optional(),
  createdByActorId: z.string(),
  createdBySnapshot: actorSnapshotOutput,
  updatedByActorId: z.string(),
  updatedBySnapshot: actorSnapshotOutput,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

/** 委派公开 DTO：直接任务的委派没有议题，topicId 可选；本机 worktree 路径不在 DTO 中。 */
export const delegationOutput = z.object({
  id: z.string(),
  topicId: z.string().optional(),
  workItemId: z.string(),
  supervisorAgentId: z.string(),
  executorAgentId: z.string(),
  permissionProfile: z.enum(["workspace_write", "danger_full_access"]),
  resumedFromId: z.string().optional(),
  failureCode: z.string().optional(),
  completionPolicy: z.enum(["review", "human"]),
  acceptanceCriteria: z.string(),
  status: z.enum(WORK_ITEM_DELEGATION_STATUSES),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  baseCommit: z.string().optional(),
  headCommit: z.string().optional(),
  branchName: z.string().optional(),
  summary: z.string().optional(),
  review: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  kind: z.enum(WORK_ITEM_KINDS),
  inputAssetIds: z.array(z.string()),
  outputManifest: z.record(z.string(), z.unknown()).optional(),
  execution: z.record(z.string(), z.unknown()).optional(),
});

export function toStructured(value: object): Record<string, unknown> {
  return { ...value };
}

export function success(text: string, data: object): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: toStructured(data),
  };
}

export function publicError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "操作失败，请查看本地 MCP 日志。";
  }
  if (error instanceof CouncilValidationError) {
    return error.message;
  }
  const safePrefixes = [
    "议题 ",
    "后台 Claude",
    "Claude Code",
    "找不到 Claude",
    "无法启动 Claude",
    "缺少环境变量",
    "环境变量",
    "COUNCIL_",
    "实施项",
    "任务",
    "直接任务",
    "当前议题没有可绑定的 Accepted 决策",
  ];
  return safePrefixes.some((prefix) => error.message.startsWith(prefix))
    ? error.message
    : "操作失败，请查看本地 MCP 日志。";
}

export async function executeTool(
  name: string,
  operation: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      logger.error("mcp-tool", `${name} 执行失败`, error);
    }
    return {
      isError: true,
      content: [{ type: "text", text: publicError(error) }],
    };
  }
}

export function formatTopic(topic: Topic): string {
  return [
    `# ${topic.title}`,
    `- 议题 ID：${topic.id}`,
    `- 状态：${topic.status}`,
    topic.projectPath ? `- 项目：${topic.projectPath}` : "- 项目：未指定",
    "",
    topic.question,
    ...(topic.constraints.length > 0
      ? ["", "## 约束", ...topic.constraints.map((item) => `- ${item}`)]
      : []),
  ].join("\n");
}

export function formatMessage(message: CouncilMessage): string {
  return [
    `## ${message.actorSnapshot.displayName} · ${message.kind}`,
    `消息 ID：${message.id}`,
    "",
    message.content,
  ].join("\n");
}

export function formatDecision(decision: Decision): string {
  return [
    `## 决策：${decision.title}`,
    `- 状态：${decision.status}`,
    `- 决策 ID：${decision.id}`,
    "",
    decision.decision,
    "",
    `理由：${decision.rationale}`,
    ...(decision.alternatives.length > 0
      ? ["", "替代方案：", ...decision.alternatives.map((item) => `- ${item}`)]
      : []),
  ].join("\n");
}

export function formatWorkItem(workItem: WorkItem): string {
  return [
    `- [${workItem.status === "completed" ? "x" : " "}] **${workItem.title}** · ${workItem.status} · v${String(workItem.version)}`
    + (workItem.severity ? ` · ${workItem.severity}` : "")
    + (workItem.parentId ? " · 子任务" : ""),
    ...(workItem.details ? [`  ${workItem.details}`] : []),
    ...(workItem.statusNote ? [`  状态说明：${workItem.statusNote}`] : []),
    ...(workItem.fixCommit ? [`  修复提交：${workItem.fixCommit}`] : []),
    ...(workItem.assigneeActorId ? [`  执行者：${workItem.assigneeActorId}`] : []),
    `  实施项 ID：${workItem.id}`,
  ].join("\n");
}

/** 任务入口的单行摘要：比实施项多出 kind/source/优先级与项目归属。 */
export function formatTask(task: WorkItem): string {
  return [
    formatWorkItem(task).replace(`  实施项 ID：${task.id}`, `  任务 ID：${task.id}`),
    `  类型：${task.kind} · 来源：${task.source} · 优先级：${String(task.priority)}`
      + (task.topicId ? ` · 议题：${task.topicId}` : "")
      + (task.projectPath ? ` · 项目：${task.projectPath}` : ""),
  ].join("\n");
}

export function formatDelegation(delegation: WorkItemDelegation): string {
  return [
    `- 委派 ${delegation.id} · ${delegation.status} · 第 ${String(delegation.attempt)}/${String(delegation.maxAttempts)} 轮`,
    `  执行：${delegation.executorAgentId} · 审核：${delegation.supervisorAgentId} · 权限：${delegation.permissionProfile}`,
    ...(delegation.headCommit ? [`  提交：${delegation.headCommit}`] : []),
    ...(delegation.error ? [`  错误：${delegation.error}`] : []),
  ].join("\n");
}

export function formatTopicDetail(detail: TopicDetail): string {
  const pagination = detail.hasMoreMessages
    ? `当前显示 ${detail.messages.length}/${detail.messageTotal} 条；使用 message_offset=${String(detail.nextMessageOffset)} 读取更早记录。`
    : `当前显示 ${detail.messages.length}/${detail.messageTotal} 条。`;
  return [
    formatTopic(detail.topic),
    "",
    `> ${pagination}`,
    "",
    "# 讨论记录",
    detail.messages.length > 0
      ? detail.messages.map(formatMessage).join("\n\n")
      : "暂无消息。",
    "",
    "# 决策记录",
    detail.decisions.length > 0
      ? detail.decisions.map(formatDecision).join("\n\n")
      : "暂无决策。",
    "",
    "# 实施进度",
    detail.workItems.length > 0
      ? detail.workItems.map(formatWorkItem).join("\n")
      : "暂无实施项。",
  ].join("\n");
}

export function formatTopicList(page: PaginatedTopics): string {
  if (page.topics.length === 0) {
    return "没有符合条件的 Council 议题。";
  }
  return [
    `# Council 议题（${page.count}/${page.total}）`,
    "",
    ...page.topics.map(
      (topic) =>
        `- **${topic.title}** · ${topic.status} · ${topic.id} · ${topic.updatedAt}`,
    ),
    ...(page.hasMore ? ["", `下一页 offset：${String(page.nextOffset)}`] : []),
  ].join("\n");
}
