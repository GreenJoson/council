/**
 * @input  依赖：CouncilDatabase、绑定调用者身份的 MCP 配置、ClaudeClient、MCP SDK 与 Zod
 * @output 导出：迁移完成后创建身份不可伪造、可更正/关闭议题的 server 工厂和全部 council_* 工具
 * @pos    本地架构委员会对 Codex App 与 Claude Desktop 的协议入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_FIX_REPOSITORY_CHARS,
  MAX_FIX_SUMMARY_CHARS,
  MAX_FIX_TARGETS,
} from "council-orchestrator";
import { z } from "zod/v4";
import { ClaudeClient } from "./claude-client.js";
import {
  MAX_ALTERNATIVE_COUNT,
  MAX_CONSTRAINT_CHARS,
  MAX_CONSTRAINT_COUNT,
  MAX_INSTRUCTION_CHARS,
  MAX_ID_CHARS,
  MAX_LIST_LIMIT,
  MAX_MESSAGE_CHARS,
  MAX_PATH_CHARS,
  MAX_QUESTION_CHARS,
  MAX_TITLE_CHARS,
  MAX_WORK_ITEM_BATCH,
  MAX_WORK_ITEM_DETAILS_CHARS,
  MAX_WORK_ITEM_STATUS_NOTE_CHARS,
  MESSAGE_KINDS,
  SERVER_NAME,
  SERVER_VERSION,
  TOPIC_STATUSES,
  WORK_ITEM_ORIGINS,
  WORK_ITEM_SEVERITIES,
  WORK_ITEM_STATUSES,
} from "./constants.js";
import { CouncilDatabase } from "./database.js";
import { CouncilValidationError } from "./errors.js";
import { logger } from "./logger.js";
import { normalizeProjectPath } from "./project-path.js";
import type {
  CouncilMessage,
  Decision,
  McpCouncilConfig,
  PaginatedTopics,
  Topic,
  TopicDetail,
  WorkItem,
} from "./types.js";

const topicIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^topic_[A-Za-z0-9-]+$/, "topic_id 格式无效")
  .describe("Council 议题 ID，例如 topic_<uuid>");
const messageKindField = z.enum(MESSAGE_KINDS);
const topicStatusField = z.enum(TOPIC_STATUSES);
const decisionStatusField = z.enum(["proposed", "accepted", "rejected", "superseded"]);
const workItemStatusField = z.enum(WORK_ITEM_STATUSES);

const actorSnapshotOutput = z.object({
  schemaVersion: z.literal(1),
  actorId: z.string(),
  slug: z.string(),
  displayName: z.string(),
  shortName: z.string(),
  role: z.string(),
});
const workItemProgressOutput = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  openBlockingFindings: z.number().int().nonnegative(),
});
const topicOutput = z.object({
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
const messageOutput = z.object({
  id: z.string(),
  topicId: z.string(),
  actorId: z.string(),
  actorSnapshot: actorSnapshotOutput,
  kind: messageKindField,
  content: z.string(),
  parentMessageId: z.string().optional(),
  createdAt: z.string(),
});
const decisionOutput = z.object({
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
const workItemOutput = z.object({
  id: z.string(),
  topicId: z.string(),
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

function toStructured(value: object): Record<string, unknown> {
  return { ...value };
}

function success(text: string, data: object): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: toStructured(data),
  };
}

function publicError(error: unknown): string {
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
    "当前议题没有可绑定的 Accepted 决策",
  ];
  return safePrefixes.some((prefix) => error.message.startsWith(prefix))
    ? error.message
    : "操作失败，请查看本地 MCP 日志。";
}

async function executeTool(
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

function formatTopic(topic: Topic): string {
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

function formatMessage(message: CouncilMessage): string {
  return [
    `## ${message.actorSnapshot.displayName} · ${message.kind}`,
    `消息 ID：${message.id}`,
    "",
    message.content,
  ].join("\n");
}

function formatDecision(decision: Decision): string {
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

function formatWorkItem(workItem: WorkItem): string {
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

function formatTopicDetail(detail: TopicDetail): string {
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

function formatTopicList(page: PaginatedTopics): string {
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

export interface CouncilServerBundle {
  server: McpServer;
  database: CouncilDatabase;
  claudeClient: ClaudeClient;
}

export async function createCouncilServer(config: McpCouncilConfig): Promise<CouncilServerBundle> {
  const database = await CouncilDatabase.open(
    config.databasePath,
    config.sqliteBusyTimeoutMs,
    { maxAttempts: config.schemaMigrationMaxAttempts },
  );
  const caller = database.resolveActorAlias(config.callerActorAlias);
  const claudeClient = new ClaudeClient(config, database);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "council_create_topic",
    {
      title: "创建架构议题",
      description:
        "创建一个供 Claude、Codex 和用户共享的架构讨论议题。question 只写精炼的问题框架、预期与验收标准；分析、证据、日志和代码必须另用 council_post_message 发布，禁止整段塞进议题正文。project_path 应传绝对本地项目目录；本工具只写本地 SQLite。",
      inputSchema: {
        title: z.string().min(1).max(MAX_TITLE_CHARS).describe("清晰、单一的议题标题"),
        question: z
          .string()
          .min(1)
          .max(MAX_QUESTION_CHARS)
          .describe("待解决的问题、预期行为和失败条件；支持 GFM Markdown 排版"),
        constraints: z
          .array(z.string().min(1).max(MAX_CONSTRAINT_CHARS))
          .max(MAX_CONSTRAINT_COUNT)
          .default([])
          .describe("明确的不变量、限制和验收标准"),
        project_path: z
          .string()
          .min(1)
          .max(MAX_PATH_CHARS)
          .optional()
          .describe("绝对项目目录；后台 Claude 顾问模式必须提供"),
      },
      outputSchema: { topic: topicOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, question, constraints, project_path }) =>
      await executeTool("council_create_topic", () => {
        const normalizedProjectPath = normalizeProjectPath(project_path);
        const topic = database.createTopicAsActor({
          title,
          question,
          constraints,
          ...(normalizedProjectPath ? { projectPath: normalizedProjectPath } : {}),
          actorId: caller.actorId,
        });
        return success(formatTopic(topic), { topic });
      }),
  );

  server.registerTool(
    "council_update_topic",
    {
      title: "更正架构议题",
      description:
        "更正仍为 open 的议题标题、问题框架或约束。先调用 council_get_topic 取得最新 updatedAt，并原样传入 expected_updated_at；详细分析仍应发布为消息，不能借更新工具把议题正文变成长篇分析。",
      inputSchema: {
        topic_id: topicIdField,
        title: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
        question: z.string().trim().min(1).max(MAX_QUESTION_CHARS).optional(),
        constraints: z
          .array(z.string().trim().min(1).max(MAX_CONSTRAINT_CHARS))
          .max(MAX_CONSTRAINT_COUNT)
          .optional(),
        expected_updated_at: z.iso.datetime().describe("最近一次读取到的 topic.updatedAt"),
      },
      outputSchema: { topic: topicOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, title, question, constraints, expected_updated_at }) =>
      await executeTool("council_update_topic", () => {
        if (title === undefined && question === undefined && constraints === undefined) {
          throw new CouncilValidationError(
            "至少提供 title、question 或 constraints 中的一项。",
          );
        }
        const topic = database.updateTopicAsActor({
          topicId: topic_id,
          ...(title !== undefined ? { title } : {}),
          ...(question !== undefined ? { question } : {}),
          ...(constraints !== undefined ? { constraints } : {}),
          expectedUpdatedAt: expected_updated_at,
          actorId: caller.actorId,
        });
        return success(formatTopic(topic), { topic });
      }),
  );

  server.registerTool(
    "council_close_topic",
    {
      title: "关闭架构议题",
      description:
        "关闭不再继续的议题并保留全部审计历史，不会物理删除。重复关闭是幂等的；若仍有活动圆桌或 Agent 会话，会拒绝并要求先在桌面端停止运行。",
      inputSchema: { topic_id: topicIdField },
      outputSchema: { topic: topicOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic_id }) =>
      await executeTool("council_close_topic", () => {
        const topic = database.closeTopicAsActor({
          topicId: topic_id,
          actorId: caller.actorId,
        });
        return success(`议题已关闭并保留历史。\n\n${formatTopic(topic)}`, { topic });
      }),
  );

  server.registerTool(
    "council_get_topic",
    {
      title: "读取架构议题",
      description:
        "读取一个议题、最近的共享消息和全部决策。message_offset 从最新消息向更早记录分页。",
      inputSchema: {
        topic_id: topicIdField,
        message_limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
        message_offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        topic: topicOutput,
        messages: z.array(messageOutput),
        decisions: z.array(decisionOutput),
        workItems: z.array(workItemOutput),
        messageTotal: z.number().int(),
        messageLimit: z.number().int(),
        messageOffset: z.number().int(),
        hasMoreMessages: z.boolean(),
        nextMessageOffset: z.number().int().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic_id, message_limit, message_offset }) =>
      await executeTool("council_get_topic", () => {
        const detail = database.getTopicDetail(
          topic_id,
          message_limit ?? config.defaultMessageLimit,
          message_offset,
        );
        return success(formatTopicDetail(detail), detail);
      }),
  );

  server.registerTool(
    "council_list_topics",
    {
      title: "列出架构议题",
      description: "按项目路径或状态列出本地 Council 议题，支持 offset 分页。",
      inputSchema: {
        project_path: z.string().min(1).max(MAX_PATH_CHARS).optional(),
        status: topicStatusField.optional(),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        total: z.number().int(),
        count: z.number().int(),
        offset: z.number().int(),
        hasMore: z.boolean(),
        nextOffset: z.number().int().optional(),
        topics: z.array(topicOutput),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path, status, limit, offset }) =>
      await executeTool("council_list_topics", () => {
        const page = database.listTopics({
          ...(project_path ? { projectPath: normalizeProjectPath(project_path) } : {}),
          ...(status ? { status } : {}),
          limit: limit ?? config.defaultMessageLimit,
          offset,
        });
        return success(formatTopicList(page), page);
      }),
  );

  server.registerTool(
    "council_post_message",
    {
      title: "发布架构消息",
      description:
        "向议题发布一条可供另一模型读取的公开消息。只发布结论、证据、批评或回应；不得写入秘密和隐藏推理。" +
        "content 必须是规范 GFM Markdown 排版：首段先给一句话结论；正文用「## 」小节组织（按需选用 方案/理由/风险/失败条件/验证）；" +
        "要点用「- 」列表；代码、命令与目录结构放 ``` 围栏；对比用表格；段落之间留空行；禁止把全文挤成单个长段落。" +
        "架构图、模块依赖图、业务流程或时序图用 ```mermaid 围栏描述，UI 会渲染成图并归档到架构视图。",
      inputSchema: {
        topic_id: topicIdField,
        kind: messageKindField,
        content: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_CHARS)
          .describe("GFM Markdown 正文；遵守工具描述中的排版规范"),
        parent_message_id: z.string().max(MAX_ID_CHARS).optional(),
      },
      outputSchema: { message: messageOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, kind, content, parent_message_id }) =>
      await executeTool("council_post_message", () => {
        const message = database.createMessageAsActor({
          topicId: topic_id,
          actorId: caller.actorId,
          kind,
          content,
          ...(parent_message_id ? { parentMessageId: parent_message_id } : {}),
        });
        return success(formatMessage(message), { message });
      }),
  );

  server.registerTool(
    "council_record_decision",
    {
      title: "记录架构决策",
      description:
        "在议题中记录结构化决策提案、理由和替代方案。MCP 只能创建 proposed；用户接受必须通过桌面或 HTTP 入口。",
      inputSchema: {
        topic_id: topicIdField,
        title: z.string().min(1).max(MAX_TITLE_CHARS),
        decision: z.string().min(1).max(MAX_MESSAGE_CHARS),
        rationale: z.string().min(1).max(MAX_MESSAGE_CHARS),
        alternatives: z
          .array(z.string().min(1).max(MAX_CONSTRAINT_CHARS))
          .max(MAX_ALTERNATIVE_COUNT)
          .default([]),
      },
      outputSchema: { decision: decisionOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, title, decision, rationale, alternatives }) =>
      await executeTool("council_record_decision", () => {
        const recorded = database.createDecisionAsActor({
          topicId: topic_id,
          title,
          decision,
          rationale,
          alternatives,
          status: "proposed",
          actorId: caller.actorId,
        });
        return success(formatDecision(recorded), { decision: recorded });
      }),
  );

  server.registerTool(
    "council_add_work_items",
    {
      title: "拆分决策实施项",
      description:
        "为议题最新的 Accepted 决策添加可追踪实施项。仅记录真实计划，不得把尚未实现的功能标成已完成；同一决策内标题不允许重复。",
      inputSchema: {
        topic_id: topicIdField,
        decision_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^decision_[A-Za-z0-9-]+$/, "decision_id 格式无效")
          .optional()
          .describe("省略时绑定该议题最新的 Accepted 决策"),
        parent_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^work_item_[A-Za-z0-9-]+$/, "parent_id 格式无效")
          .optional()
          .describe(
            "挂到这个父任务下形成子任务；父任务状态由子任务派生，不能手动更新",
          ),
        items: z
          .array(z.object({
            title: z.string().min(1).max(MAX_TITLE_CHARS),
            details: z.string().max(MAX_WORK_ITEM_DETAILS_CHARS).default(""),
          }))
          .min(1)
          .max(MAX_WORK_ITEM_BATCH),
      },
      outputSchema: { workItems: z.array(workItemOutput) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, decision_id, parent_id, items }) =>
      await executeTool("council_add_work_items", () => {
        const workItems = database.createWorkItemsAsActor({
          topicId: topic_id,
          ...(decision_id ? { decisionId: decision_id } : {}),
          ...(parent_id ? { parentId: parent_id } : {}),
          items,
          actorId: caller.actorId,
        });
        return success(
          [`已添加 ${String(workItems.length)} 个实施项。`, ...workItems.map(formatWorkItem)].join("\n"),
          { workItems },
        );
      }),
  );

  server.registerTool(
    "council_update_work_item",
    {
      title: "更新实施进度",
      description:
        "更新一个实施项的待开始、进行中、阻塞或完成状态。只有在代码、验证或交付结果确实完成后才能标记 completed；status_note 应简述证据或阻塞原因。expected_version 用于拒绝并发覆盖。",
      inputSchema: {
        topic_id: topicIdField,
        work_item_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^work_item_[A-Za-z0-9-]+$/, "work_item_id 格式无效"),
        status: workItemStatusField,
        expected_version: z.number().int().positive(),
        status_note: z.string().max(MAX_WORK_ITEM_STATUS_NOTE_CHARS).optional(),
        fix_commit: z
          .string()
          .max(MAX_ID_CHARS)
          .optional()
          .describe("标记完成时附上修复所在的 commit，作为复审的证据入口"),
      },
      outputSchema: { workItem: workItemOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, work_item_id, status, expected_version, status_note, fix_commit }) =>
      await executeTool("council_update_work_item", () => {
        const workItem = database.updateWorkItemAsActor({
          topicId: topic_id,
          workItemId: work_item_id,
          status,
          expectedVersion: expected_version,
          ...(status_note !== undefined ? { statusNote: status_note } : {}),
          ...(fix_commit !== undefined ? { fixCommit: fix_commit } : {}),
          actorId: caller.actorId,
        });
        return success(formatWorkItem(workItem), { workItem });
      }),
  );

  server.registerTool(
    "council_list_work_items",
    {
      title: "查看实施项清单",
      description:
        "列出议题的实施项待办，可按状态、来源或「只看我认领的」过滤。开工前先读这里，"
        + "认领一条再动手，不要凭记忆猜自己在做哪一项。",
      inputSchema: {
        topic_id: topicIdField,
        status: workItemStatusField.optional(),
        origin: z
          .enum(WORK_ITEM_ORIGINS)
          .optional()
          .describe("review_finding 只看审核发现，manual 只看手工拆解的交付项"),
        mine: z
          .boolean()
          .optional()
          .describe("只返回自己已认领的条目"),
      },
      outputSchema: { workItems: z.array(workItemOutput) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic_id, status, origin, mine }) =>
      await executeTool("council_list_work_items", () => {
        const workItems = database.listWorkItems({
          topicId: topic_id,
          ...(status ? { status } : {}),
          ...(origin ? { origin } : {}),
          ...(mine ? { assigneeActorId: caller.actorId } : {}),
        });
        return success(
          workItems.length > 0
            ? workItems.map(formatWorkItem).join("\n")
            : "没有匹配的实施项。",
          { workItems },
        );
      }),
  );

  server.registerTool(
    "council_claim_work_item",
    {
      title: "认领实施项",
      description:
        "在开始修复之前认领一条实施项：写上执行者并置为进行中。这是界面上「谁正在做哪一条」"
        + "的唯一来源——不认领就动手，用户只会看到一个跑了很久却不知道在干什么的 Agent。"
        + "父任务不能被认领，只能认领叶子任务。",
      inputSchema: {
        topic_id: topicIdField,
        work_item_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^work_item_[A-Za-z0-9-]+$/, "work_item_id 格式无效"),
        expected_version: z.number().int().positive(),
        status_note: z
          .string()
          .max(MAX_WORK_ITEM_STATUS_NOTE_CHARS)
          .optional()
          .describe("打算怎么修，一句话即可"),
      },
      outputSchema: { workItem: workItemOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, work_item_id, expected_version, status_note }) =>
      await executeTool("council_claim_work_item", () => {
        const workItem = database.claimWorkItemAsActor({
          topicId: topic_id,
          workItemId: work_item_id,
          expectedVersion: expected_version,
          ...(status_note !== undefined ? { statusNote: status_note } : {}),
          actorId: caller.actorId,
        });
        return success(formatWorkItem(workItem), { workItem });
      }),
  );

  server.registerTool(
    "council_submit_fixes",
    {
      title: "提交修复并请求复审",
      description:
        "改完代码、提交之后调用：把这一批修复的仓库与 commit 公开自述出来，交回圆桌复审。"
        + "不要自己宣布问题已解决——条目是否关闭由复审者读真实 diff 判定，"
        + "你只负责把改动摆到台面上。commit 必须是已经存在的对象名（7 位以上十六进制），"
        + "不能填分支名或 tag，否则复审者过几分钟读到的就不是你改的那份 diff。"
        + "调用后请在界面上开始复审，或等待用户触发。",
      inputSchema: {
        topic_id: topicIdField,
        summary: z
          .string()
          .min(1)
          .max(MAX_FIX_SUMMARY_CHARS)
          .describe("这批改动解决了哪些条目，一句话"),
        targets: z
          .array(
            z.object({
              repository: z
                .string()
                .min(1)
                .max(MAX_FIX_REPOSITORY_CHARS)
                .describe("相对议题项目目录的仓库路径；当前仓库写 ."),
              commit: z
                .string()
                .regex(/^[0-9a-f]{7,40}$/u, "commit 必须是 7 位以上的十六进制对象名"),
            }),
          )
          .min(1)
          .max(MAX_FIX_TARGETS),
      },
      outputSchema: { message: messageOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, summary, targets }) =>
      await executeTool("council_submit_fixes", () => {
        const message = database.createMessageAsActor({
          topicId: topic_id,
          actorId: caller.actorId,
          kind: "note",
          content: [
            "已提交一批修复，请复审。",
            "",
            `修复摘要：${summary}`,
            "",
            "```council-fix",
            JSON.stringify({ targets, summary }),
            "```",
          ].join("\n"),
        });
        return success(formatMessage(message), { message });
      }),
  );

  server.registerTool(
    "council_check_claude",
    {
      title: "检查 Claude 顾问",
      description: "只运行版本检查，验证后台 Claude Code 可执行程序是否可用，不消耗模型调用。",
      inputSchema: {},
      outputSchema: {
        available: z.boolean(),
        authenticated: z.boolean(),
        version: z.string().optional(),
        authMethod: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      await executeTool("council_check_claude", async () => {
        const status = await claudeClient.checkAvailability();
        const text = status.available && status.authenticated
          ? `Claude 顾问可用且已登录：${status.version ?? "版本未知"}`
          : status.available
            ? `Claude 顾问已安装但未登录：${status.version ?? "版本未知"}`
          : `Claude 顾问不可用：${status.error ?? "未知原因"}`;
        return success(text, status);
      }),
  );

  server.registerTool(
    "council_ask_claude",
    {
      title: "询问后台 Claude 顾问",
      description:
        "在议题对应的绝对项目目录中，以只规划权限调用可恢复的 Claude Code 顾问会话，并将公开回复写回议题。",
      inputSchema: {
        topic_id: topicIdField,
        instruction: z.string().min(1).max(MAX_INSTRUCTION_CHARS),
        message_kind: z
          .enum(["proposal", "rebuttal", "note"] as const)
          .default("proposal"),
        force_new_session: z.boolean().default(false),
        model: z.string().min(1).max(200).optional(),
      },
      outputSchema: {
        message: messageOutput,
        sessionId: z.string().optional(),
        model: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ topic_id, instruction, message_kind, force_new_session, model }, extra) =>
      await executeTool("council_ask_claude", async () => {
        const result = await claudeClient.ask({
          topicId: topic_id,
          instruction,
          messageKind: message_kind,
          forceNewSession: force_new_session,
          ...(model ? { model } : {}),
          signal: extra.signal,
        });
        return success(formatMessage(result.message), {
          message: result.message,
          ...(result.response.sessionId ? { sessionId: result.response.sessionId } : {}),
          ...(result.response.model ? { model: result.response.model } : {}),
        });
      }),
  );

  server.registerTool(
    "council_reset_claude_session",
    {
      title: "重置 Claude 顾问会话",
      description:
        "删除某个议题保存的后台 Claude session ID。不会删除议题和消息；下一次询问将创建新会话。",
      inputSchema: { topic_id: topicIdField },
      outputSchema: { removed: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic_id }) =>
      await executeTool("council_reset_claude_session", () => {
        const removed = database.deleteAgentSession(topic_id, "claude");
        return success(removed ? "已重置 Claude 顾问会话。" : "该议题没有已保存的 Claude 会话。", {
          removed,
        });
      }),
  );

  server.registerTool(
    "council_get_status",
    {
      title: "读取 Council 状态",
      description: "读取本地数据库中的议题、消息和决策数量，不返回本地敏感路径。",
      inputSchema: {},
      outputSchema: {
        topics: z.number().int(),
        messages: z.number().int(),
        decisions: z.number().int(),
        workItems: z.number().int(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      await executeTool("council_get_status", () => {
        const counts = database.getCounts();
        return success(
          `Council 状态：${String(counts.topics)} 个议题，${String(counts.messages)} 条消息，${String(counts.decisions)} 个决策，${String(counts.workItems)} 个实施项。`,
          counts,
        );
      }),
  );

  return { server, database, claudeClient };
}
