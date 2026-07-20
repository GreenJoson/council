/**
 * @input  依赖：CouncilDatabase、ClaudeClient、MCP SDK 与 Zod
 * @output 导出：createCouncilServer 工厂和全部 council_* 工具
 * @pos    本地架构委员会对 Codex App 与 Claude Desktop 的协议入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { ClaudeClient } from "./claude-client.js";
import {
  AUTHORS,
  DECISION_STATUSES,
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
  MESSAGE_KINDS,
  SERVER_NAME,
  SERVER_VERSION,
  TOPIC_STATUSES,
} from "./constants.js";
import { CouncilDatabase } from "./database.js";
import { CouncilValidationError } from "./errors.js";
import { logger } from "./logger.js";
import { normalizeProjectPath } from "./project-path.js";
import type {
  CouncilConfig,
  CouncilMessage,
  Decision,
  PaginatedTopics,
  Topic,
  TopicDetail,
} from "./types.js";

const topicIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^topic_[A-Za-z0-9-]+$/, "topic_id 格式无效")
  .describe("Council 议题 ID，例如 topic_<uuid>");
const messageKindField = z.enum(MESSAGE_KINDS);
const authorField = z.enum(AUTHORS);
const topicStatusField = z.enum(TOPIC_STATUSES);
const decisionStatusField = z.enum(DECISION_STATUSES);

const topicOutput = z.object({
  id: z.string(),
  title: z.string(),
  question: z.string(),
  constraints: z.array(z.string()),
  projectPath: z.string().optional(),
  status: topicStatusField,
  createdBy: authorField,
  createdAt: z.string(),
  updatedAt: z.string(),
});
const messageOutput = z.object({
  id: z.string(),
  topicId: z.string(),
  author: authorField,
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
  createdBy: authorField,
  createdAt: z.string(),
  updatedAt: z.string(),
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
    `## ${message.author} · ${message.kind}`,
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

export function createCouncilServer(config: CouncilConfig): CouncilServerBundle {
  const database = new CouncilDatabase(config.databasePath, config.sqliteBusyTimeoutMs);
  const claudeClient = new ClaudeClient(config, database);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "council_create_topic",
    {
      title: "创建架构议题",
      description:
        "创建一个供 Claude、Codex 和用户共享的架构讨论议题。project_path 应传绝对本地项目目录；本工具只写本地 SQLite。",
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
        created_by: authorField.default("human").describe("发起者身份"),
      },
      outputSchema: { topic: topicOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, question, constraints, project_path, created_by }) =>
      await executeTool("council_create_topic", () => {
        const normalizedProjectPath = normalizeProjectPath(project_path);
        const topic = database.createTopic({
          title,
          question,
          constraints,
          ...(normalizedProjectPath ? { projectPath: normalizedProjectPath } : {}),
          createdBy: created_by,
        });
        return success(formatTopic(topic), { topic });
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
        author: authorField,
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
    async ({ topic_id, author, kind, content, parent_message_id }) =>
      await executeTool("council_post_message", () => {
        const message = database.createMessage({
          topicId: topic_id,
          author,
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
        "在议题中记录结构化决策、理由和替代方案。用户尚未接受时必须使用 proposed 状态。",
      inputSchema: {
        topic_id: topicIdField,
        title: z.string().min(1).max(MAX_TITLE_CHARS),
        decision: z.string().min(1).max(MAX_MESSAGE_CHARS),
        rationale: z.string().min(1).max(MAX_MESSAGE_CHARS),
        alternatives: z
          .array(z.string().min(1).max(MAX_CONSTRAINT_CHARS))
          .max(MAX_ALTERNATIVE_COUNT)
          .default([]),
        status: decisionStatusField.default("proposed"),
        created_by: authorField,
      },
      outputSchema: { decision: decisionOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, title, decision, rationale, alternatives, status, created_by }) =>
      await executeTool("council_record_decision", () => {
        const recorded = database.createDecision({
          topicId: topic_id,
          title,
          decision,
          rationale,
          alternatives,
          status,
          createdBy: created_by,
        });
        return success(formatDecision(recorded), { decision: recorded });
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
          `Council 状态：${String(counts.topics)} 个议题，${String(counts.messages)} 条消息，${String(counts.decisions)} 个决策。`,
          counts,
        );
      }),
  );

  return { server, database, claudeClient };
}
