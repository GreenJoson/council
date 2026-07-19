/**
 * @input  依赖：临时目录、CouncilDatabase 与 HTTP 应用工厂
 * @output 导出：隔离的本地集成测试服务和 JSON envelope 读取器
 * @pos    REST 与 SSE 测试共用的生命周期夹具
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { CouncilDatabase } from "../src/database.js";
import { createCouncilHttpApp } from "../src/http/app.js";
import {
  CouncilOrchestrationService,
  type RegisteredAgentAdapter,
} from "../src/orchestration/service.js";
import type { CouncilHttpConfig } from "../src/types.js";

export const TEST_ALLOWED_ORIGIN = "https://allowed.example";
export const TEST_BLOCKED_ORIGIN = "https://blocked.example";

export interface JsonEnvelope<T = unknown> {
  code: number;
  message: string;
  data?: T;
  timestamp: number;
}

export interface HttpHarness {
  baseUrl: string;
  config: CouncilHttpConfig;
  database: CouncilDatabase;
  databasePath: string;
  directory: string;
  orchestration?: CouncilOrchestrationService;
  close: () => Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startHttpHarness(
  overrides: Partial<CouncilHttpConfig> = {},
  registrations?: readonly RegisteredAgentAdapter[],
): Promise<HttpHarness> {
  const directory = mkdtempSync(path.join(tmpdir(), "council-http-test-"));
  const databasePath = path.join(directory, "council.sqlite3");
  const config: CouncilHttpConfig = {
    sqliteBusyTimeoutMs: 5_000,
    defaultMessageLimit: 20,
    host: "localhost",
    port: 4_000,
    allowedOrigins: [TEST_ALLOWED_ORIGIN],
    corsMaxAgeSeconds: 600,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    bodyLimitBytes: 65_536,
    eventPollMs: 20,
    eventRetryMs: 3_000,
    eventHeartbeatMs: 2_000,
    shutdownTimeoutMs: 1_000,
    orchestrationLeaseTtlMs: 1_000,
    orchestrationLeaseRenewMs: 100,
    orchestrationSweepIntervalMs: 50,
    orchestrationDefaultMaxRounds: 10,
    orchestrationDefaultMaxAttempts: 1,
    orchestrationDefaultMaxRecoveries: 1,
    orchestrationDefaultAgentTimeoutMs: 5_000,
    orchestrationAgentCleanupTimeoutMs: 100,
    orchestrationConfirmCompletion: false,
    orchestrationRunPageLimit: 20,
    orchestrationStartupScanLimit: 1_000,
    orchestrationShutdownTimeoutMs: 1_000,
    ...overrides,
    databasePath,
  };
  const database = new CouncilDatabase(databasePath, config.sqliteBusyTimeoutMs);
  const orchestration = registrations
    ? new CouncilOrchestrationService(config, registrations)
    : undefined;
  await orchestration?.initialize();
  const bundle = createCouncilHttpApp(config, database, orchestration);
  const server = createServer(bundle.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  let closed = false;

  return {
    baseUrl: `http://${config.host}:${String(address.port)}`,
    config,
    database,
    databasePath,
    directory,
    ...(orchestration ? { orchestration } : {}),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      bundle.events.close();
      await closeServer(server);
      await orchestration?.shutdown();
      orchestration?.close();
      try {
        database.close();
      } catch {
        // 测试可主动关闭数据库来触发 5xx；夹具清理必须保持幂等。
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function readEnvelope<T = unknown>(response: Response): Promise<JsonEnvelope<T>> {
  const value: unknown = await response.json();
  assert(value && typeof value === "object");
  const envelope = value as Partial<JsonEnvelope<T>>;
  assert.equal(typeof envelope.code, "number");
  assert.equal(typeof envelope.message, "string");
  assert.equal(typeof envelope.timestamp, "number");
  return envelope as JsonEnvelope<T>;
}
