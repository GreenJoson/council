/**
 * @input  依赖：McpToolContext、Zod 与 tool-support 共享件
 * @output 导出：registerStatusTools，注册 council_get_status
 * @pos    本地数据库议题/消息/决策/实施项计数的只读状态 MCP 工具模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { z } from "zod/v4";
import type { McpToolContext } from "../tool-context.js";
import { executeTool, success } from "../tool-support.js";

export function registerStatusTools(context: McpToolContext): void {
  const { server, database } = context;

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
}
