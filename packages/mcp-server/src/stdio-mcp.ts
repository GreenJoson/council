/**
 * @input  依赖：COUNCIL_* 环境变量（loadMcpConfig）、Node schema 迁移器和 stdio MCP 客户端、node:sea（sidecar 判定）
 * @output 导出：运行 council stdio MCP 服务的 runStdioMcp、桌面 sidecar 内分派用的 COUNCIL_STDIO_MCP_FLAG，
 *         以及定位本机 stdio MCP 启动命令的 resolveStdioMcpLaunch（客户端接入写入与团队 Lead 注入共用）
 * @pos    dev 入口 index.ts 与桌面 sidecar（http-index.ts 带标记启动）共用的 stdio MCP 启动逻辑；「本机怎么拉起 council MCP」的唯一真源
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 本模块只导出函数，不在导入时启动；由入口决定何时运行。
 * sidecar 内 import.meta.url 不可用（esbuild 打成 CJS），因此 isSea() 分支必须先于任何 import.meta 访问。
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { loadMcpConfig } from "./config.js";
import { CouncilConflictError } from "./errors.js";
import { logger } from "./logger.js";
import { createCouncilServer } from "./server.js";

/** 桌面 sidecar 是单文件可执行程序，没有独立 index.js；客户端注册用此标记让同一程序跑 stdio MCP。 */
export const COUNCIL_STDIO_MCP_FLAG = "--council-stdio-mcp";

export interface StdioMcpLaunch {
  command: string;
  args: readonly string[];
}

function moduleUrl(): string {
  return import.meta.url;
}

/**
 * 本机 stdio MCP 的启动命令：sidecar 用自身可执行 + 标记；dist 运行时用同目录 index.js；tsx 跑源码时指向构建产物
 * dist/src/index.js（客户端与 Lead 子进程都以纯 node 启动，跑不了 .ts）。找不到入口抛 409，由调用方决定是拒绝还是降级。
 */
export function resolveStdioMcpLaunch(): StdioMcpLaunch {
  if (isSea()) {
    return { command: process.execPath, args: [COUNCIL_STDIO_MCP_FLAG] };
  }
  const here = moduleUrl();
  const entryUrl = here.endsWith(".ts") ? new URL("../dist/src/index.js", here) : new URL("./index.js", here);
  const entry = fileURLToPath(entryUrl);
  if (!existsSync(entry)) {
    throw new CouncilConflictError("找不到 MCP stdio 入口 dist/src/index.js；请先构建 mcp-server（npm run build）。");
  }
  return { command: process.execPath, args: [entry] };
}

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
