/**
 * @input  依赖：COUNCIL_* 环境变量（loadMcpConfig）、Node schema 迁移器和 stdio MCP 客户端
 * @output 导出：运行 council stdio MCP 服务的 runStdioMcp 与桌面 sidecar 内分派用的 COUNCIL_STDIO_MCP_FLAG
 * @pos    dev 入口 index.ts 与桌面 sidecar（http-index.ts 带标记启动）共用的 stdio MCP 启动逻辑
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 本模块只导出函数，不在导入时启动；由入口决定何时运行。
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpConfig } from "./config.js";
import { logger } from "./logger.js";
import { createCouncilServer } from "./server.js";

/** 桌面 sidecar 是单文件可执行程序，没有独立 index.js；客户端注册用此标记让同一程序跑 stdio MCP。 */
export const COUNCIL_STDIO_MCP_FLAG = "--council-stdio-mcp";

export async function runStdioMcp(): Promise<void> {
  const config = loadMcpConfig();
  const bundle = await createCouncilServer(config);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("server", `收到 ${signal}，正在关闭。`);
    await bundle.server.close();
    bundle.database.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await bundle.server.connect(transport);
  logger.info("server", "Council MCP 已通过 stdio 启动。 ");
}
