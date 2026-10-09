/**
 * @input  依赖：McpToolContext、Zod、共享常量与 tool-support 共享件
 * @output 导出：registerMessageTools，注册 council_post_message / council_record_decision
 * @pos    议题内公开消息与 proposed 决策记录的 MCP 工具模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { z } from "zod/v4";
import {
  MAX_ALTERNATIVE_COUNT,
  MAX_CONSTRAINT_CHARS,
  MAX_ID_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_TITLE_CHARS,
} from "../../constants.js";
import type { McpToolContext } from "../tool-context.js";
import {
  decisionOutput,
  executeTool,
  formatDecision,
  formatMessage,
  messageKindField,
  messageOutput,
  success,
  topicIdField,
} from "../tool-support.js";

export function registerMessageTools(context: McpToolContext): void {
  const { server, database, caller } = context;

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
}
