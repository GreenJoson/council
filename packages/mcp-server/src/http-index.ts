#!/usr/bin/env node
/**
 * @input  依赖：COUNCIL_HTTP_* 配置、Node schema 迁移器与本地 HTTP 客户端
 * @output 导出：迁移成功后运行的 Council REST 与 SSE 服务
 * @pos    独立于 stdio MCP 生命周期、对外暴露 ready 状态的 WebUI 后端入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { CouncilDatabase } from "./database.js";
import { createCouncilHttpApp } from "./http/app.js";
import { loadHttpConfig } from "./http/config.js";
import { logger } from "./logger.js";
import { createProductionOrchestrationService } from "./orchestration/service.js";

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const councilConfig = loadConfig();
  const database = await CouncilDatabase.open(
    config.databasePath,
    config.sqliteBusyTimeoutMs,
    { maxAttempts: config.schemaMigrationMaxAttempts },
  );
  let orchestration;
  try {
    orchestration = createProductionOrchestrationService(
      config,
      councilConfig,
    );
    await orchestration.initialize();
  } catch (error) {
    await orchestration?.shutdown();
    orchestration?.close();
    database.close();
    throw error;
  }
  const bundle = createCouncilHttpApp(config, database, orchestration);
  const server = createServer(bundle.app);
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("http-server", `收到 ${signal}，正在关闭。`);
    bundle.events.close();
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
    }, config.shutdownTimeoutMs);
    forceClose.unref();
    await Promise.all([serverClosed, orchestration.shutdown()]);
    clearTimeout(forceClose);
    orchestration.close();
    database.close();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  server.on("error", (error) => {
    logger.error("http-server", "Council HTTP 启动失败", error);
    process.exitCode = 1;
    if (!shuttingDown) {
      shuttingDown = true;
      bundle.events.close();
      void orchestration.shutdown().finally(() => {
        orchestration.close();
        database.close();
      });
    }
  });
  server.listen(config.port, config.host, () => {
    logger.info(
      "http-cors",
      `allowed origins (${String(config.allowedOrigins.length)}): ${config.allowedOrigins.join(", ")}`,
    );
    logger.info("http-server", `Council HTTP 已监听配置的主机和端口 ${String(config.port)}。`);
  });
}

void main().catch((error: unknown) => {
  logger.error("http-server", "Council HTTP 启动失败", error);
  process.exitCode = 1;
});
