#!/usr/bin/env node
/**
 * @input  依赖：COUNCIL_* 环境变量和 stdio MCP 客户端
 * @output 导出：运行中的 council MCP 服务
 * @pos    Codex App 与 Claude Desktop 共用的本地进程入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createCouncilServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const bundle = createCouncilServer(config);
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

main().catch((error: unknown) => {
  logger.error("server", "Council MCP 启动失败", error);
  process.exit(1);
});
