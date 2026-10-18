#!/usr/bin/env node
/**
 * @input  依赖：COUNCIL_HTTP_* 配置、内部只读 Git MCP 标记、council stdio MCP 标记（客户端接入注册）、Node schema 迁移器与本地客户端
 * @output 导出：先取得单实例锁和端口，再迁移、驱动任务和 REST/SSE（关闭时一并关闭 HTML 页面视图端口）；另支持只读 Git stdio MCP 与 council stdio MCP
 * @pos    独立后台 Worker 与 delegated Git 工具共用入口；桌面只连接控制面
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createServer, type RequestListener } from "node:http";
import { ServiceWorker } from "./service-worker.js";
import { EXECUTION_DEFAULTS, loadConfig } from "./config.js";
import { CouncilDatabase } from "./database.js";
import { createCouncilHttpApp } from "./http/app.js";
import { loadHttpConfig } from "./http/config.js";
import { logger } from "./logger.js";
import { createCycleDecisionWriter } from "./orchestration/cycle-decisions.js";
import { createReviewLedgerWriter } from "./orchestration/review-ledger.js";
import { createProductionOrchestrationService } from "./orchestration/service.js";
import {
  READ_ONLY_GIT_MCP_FLAG,
  runReadOnlyGitMcp,
} from "./read-only-git-mcp.js";
import { COUNCIL_STDIO_MCP_FLAG, runStdioMcp } from "./stdio-mcp.js";

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const councilConfig = loadConfig();
  const worker = new ServiceWorker(config.databasePath, councilConfig.workerHeartbeatMs ?? EXECUTION_DEFAULTS.workerHeartbeatMs, councilConfig.workerIdleTimeoutMs ?? EXECUTION_DEFAULTS.workerIdleTimeoutMs);
  await worker.run(async () => {
    // 先占用监听端点，再迁移或扫描中断任务；重复启动不能改写正在运行的账本。
    let handler: RequestListener = (_request, response) => { response.writeHead(503); response.end(); };
    const server = createServer((request, response) => {
      const settled = worker.requestStarted(!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET"));
      response.once("finish", settled);
      response.once("close", settled);
      handler(request, response);
    });
    let database: CouncilDatabase | undefined;
    let orchestration: ReturnType<typeof createProductionOrchestrationService> | undefined;
    let bundle: ReturnType<typeof createCouncilHttpApp> | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let closing: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (closing) return closing;
      handler = (_request, response) => { response.writeHead(503); response.end(); };
      closing = (async () => {
        if (idleTimer) clearInterval(idleTimer);
        bundle?.events.close();
        bundle?.fileView.close();
        const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
        const forceClose = setTimeout(() => server.closeAllConnections(), config.shutdownTimeoutMs);
        forceClose.unref();
        try {
          await Promise.all([serverClosed, orchestration?.shutdown()]);
        } finally {
          clearTimeout(forceClose);
          orchestration?.close();
          database?.close();
          worker.close();
        }
      })();
      return closing;
    };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => { server.removeListener("error", reject); resolve(); });
      });
      database = await CouncilDatabase.open(config.databasePath, config.sqliteBusyTimeoutMs,
        { maxAttempts: config.schemaMigrationMaxAttempts });
      orchestration = createProductionOrchestrationService(config, councilConfig);
      orchestration.attachDecisionWriter(createCycleDecisionWriter(database));
      orchestration.attachReviewLedger(createReviewLedgerWriter(database));
      await orchestration.initialize();
      const service = orchestration;
      bundle = createCouncilHttpApp(config, database, service, {
        snapshot: () => ({ protocolVersion: 1, startedAt: worker.startedAt, heartbeatAt: worker.heartbeatAt,
          activeTasks: service.activeTaskCount, idleTimeoutMs: worker.idleTimeoutMs }),
        canStop: () => worker.canStop(service.activeTaskCount),
        stop: () => { void shutdown().catch(error => logger.error("worker", "服务关闭失败", error)); },
      });
      handler = bundle.app;
      idleTimer = setInterval(() => {
        if (worker.shouldStop(service.activeTaskCount)) void shutdown();
      }, councilConfig.workerHeartbeatMs ?? EXECUTION_DEFAULTS.workerHeartbeatMs);
      idleTimer.unref();
      const stop = () => { void shutdown().catch(error => logger.error("worker", "服务关闭失败", error)); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      server.on("error", error => { logger.error("worker", "服务监听失败", error); stop(); });
      logger.info("http-server", "Council 后台执行服务已就绪；桌面断开后活动任务继续执行。");
    } catch (error) {
      await shutdown();
      throw error;
    }
  });
}

// 桌面 sidecar 是单文件程序：同一可执行按标记分派为只读 Git MCP、council stdio MCP 或 HTTP 服务。
const entry = process.argv.includes(READ_ONLY_GIT_MCP_FLAG)
  ? runReadOnlyGitMcp()
  : process.argv.includes(COUNCIL_STDIO_MCP_FLAG)
    ? runStdioMcp()
    : main();

void entry.catch((error: unknown) => {
  logger.error("http-server", "Council HTTP 启动失败", error);
  process.exitCode = 1;
});
