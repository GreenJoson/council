/**
 * @input  依赖：MCP SDK McpServer、CouncilDatabase、ActorIdentity、ClaudeClient 与 MCP 配置
 * @output 导出：各 council_* 工具注册函数共享的上下文接口 McpToolContext
 * @pos    server 工厂与各工具模块之间的依赖传递契约
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActorIdentity } from "../actor-identity.js";
import type { ClaudeClient } from "../claude-client.js";
import type { CouncilDatabase } from "../database.js";
import type { McpCouncilConfig } from "../types.js";

export interface McpToolContext {
  server: McpServer;
  database: CouncilDatabase;
  /** 由 config.callerActorAlias 解析出的调用者身份，工具内只能以它落笔，不可伪造作者。 */
  caller: ActorIdentity;
  claudeClient: ClaudeClient;
  config: McpCouncilConfig;
}
