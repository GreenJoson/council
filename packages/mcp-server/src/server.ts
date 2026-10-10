/**
 * @input  依赖：CouncilDatabase、绑定调用者身份的 MCP 配置、ClaudeClient、MCP SDK 与 mcp/ 下各工具注册模块
 * @output 导出：迁移完成后创建身份不可伪造、可更正/关闭议题的 server 工厂，按固定顺序装配全部 council_* 工具（含任务入口、资产库、P3 流水线与
 *         P4 Worker 团队）；带 COUNCIL_TEAM_LEAD_DELEGATION_ID 启动（团队 Lead 注入）时只装配六个团队工具
 * @pos    本地架构委员会对 Codex App 与 Claude Desktop 的协议入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClaudeClient } from "./claude-client.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { CouncilDatabase } from "./database.js";
import type { McpToolContext } from "./mcp/tool-context.js";
import { registerClaudeTools } from "./mcp/tools/claude-tools.js";
import { registerMessageTools } from "./mcp/tools/message-tools.js";
import { registerStatusTools } from "./mcp/tools/status-tools.js";
import { registerTaskTools } from "./mcp/tools/task-tools.js";
import { registerAssetTools } from "./mcp/tools/asset-tools.js";
import { registerPipelineTools } from "./mcp/tools/pipeline-tools.js";
import { registerTeamTools } from "./mcp/tools/team-tools.js";
import { registerTopicTools } from "./mcp/tools/topic-tools.js";
import { registerWorkItemTools } from "./mcp/tools/work-item-tools.js";
import type { McpCouncilConfig } from "./types.js";

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
  const context: McpToolContext = { server, database, caller, claudeClient, config };

  // 团队 Lead 的执行进程只拿团队工具：不让 Lead 改议题/任务、发起委派或调 Claude 顾问，工具面越小越不易越权。
  if (config.teamLeadDelegationId) {
    registerTeamTools(context);
    return { server, database, claudeClient };
  }

  // 注册顺序决定 tools/list 的输出顺序，必须与拆分前保持一致：
  // 议题 → 消息/决策 → 实施项 → 任务 → 资产 → 流水线 → Claude 顾问 → 状态 → Worker 团队（P4 追加在末尾）。
  registerTopicTools(context);
  registerMessageTools(context);
  registerWorkItemTools(context);
  registerTaskTools(context);
  registerAssetTools(context);
  registerPipelineTools(context);
  registerClaudeTools(context);
  registerStatusTools(context);
  registerTeamTools(context);

  return { server, database, claudeClient };
}
