/**
 * @input  依赖：McpToolContext、Zod、共享常量与 tool-support 共享件
 * @output 导出：registerClaudeTools，注册 council_check_claude / council_ask_claude / council_reset_claude_session
 * @pos    后台 Claude 顾问可用性检查、可传递请求取消的询问与会话重置的 MCP 工具模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { z } from "zod/v4";
import { MAX_INSTRUCTION_CHARS } from "../../constants.js";
import type { McpToolContext } from "../tool-context.js";
import {
  executeTool,
  formatMessage,
  messageOutput,
  success,
  topicIdField,
} from "../tool-support.js";

export function registerClaudeTools(context: McpToolContext): void {
  const { server, database, claudeClient } = context;

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
}
