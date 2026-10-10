#!/usr/bin/env node
/**
 * @input  依赖：stdio-mcp.ts 的 runStdioMcp
 * @output 导出：迁移成功后运行的 council MCP 服务
 * @pos    Codex App 与 Claude Desktop 共用的本地进程入口（dev/源码安装）；桌面 sidecar 改走 http-index.ts 的 --council-stdio-mcp
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { logger } from "./logger.js";
import { runStdioMcp } from "./stdio-mcp.js";

runStdioMcp().catch((error: unknown) => {
  logger.error("server", "Council MCP 启动失败", error);
  process.exit(1);
});
