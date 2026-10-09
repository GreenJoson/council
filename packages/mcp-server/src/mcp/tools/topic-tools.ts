/**
 * @input  依赖：McpToolContext、Zod、共享常量、CouncilValidationError、normalizeProjectPath 与 tool-support 共享件
 * @output 导出：registerTopicTools，注册 council_create_topic / council_update_topic / council_close_topic / council_get_topic / council_list_topics
 * @pos    议题生命周期（创建、更正、关闭、读取、列表）的 MCP 工具模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { z } from "zod/v4";
import {
  MAX_CONSTRAINT_CHARS,
  MAX_CONSTRAINT_COUNT,
  MAX_LIST_LIMIT,
  MAX_PATH_CHARS,
  MAX_QUESTION_CHARS,
  MAX_TITLE_CHARS,
} from "../../constants.js";
import { CouncilValidationError } from "../../errors.js";
import { normalizeProjectPath } from "../../project-path.js";
import type { McpToolContext } from "../tool-context.js";
import {
  decisionOutput,
  executeTool,
  formatTopic,
  formatTopicDetail,
  formatTopicList,
  messageOutput,
  success,
  topicIdField,
  topicOutput,
  topicStatusField,
  workItemOutput,
} from "../tool-support.js";

export function registerTopicTools(context: McpToolContext): void {
  const { server, database, caller, config } = context;

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
}
