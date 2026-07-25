/**
 * @input  依赖：COUNCIL_DATA_DIR、schema 迁移与 COUNCIL_HTTP_* 环境变量
 * @output 导出：经过 Zod 校验且含迁移重试策略的 CouncilHttpConfig
 * @pos    本地 HTTP 服务的唯一配置加载入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod/v4";
import {
  MAX_LIST_LIMIT,
  MAX_ORCHESTRATION_PLAN_ROUNDS,
  MAX_ORCHESTRATION_STARTUP_SCAN,
} from "../constants.js";
import type { CouncilHttpConfig } from "../types.js";

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().min(0);
const timerInteger = positiveInteger.max(2_147_483_647);
const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

const envSchema = z
  .object({
    COUNCIL_DATA_DIR: z.string().trim().min(1),
    COUNCIL_SQLITE_BUSY_TIMEOUT_MS: positiveInteger,
    COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS: positiveInteger,
    COUNCIL_DEFAULT_MESSAGE_LIMIT: positiveInteger.max(MAX_LIST_LIMIT),
    COUNCIL_HTTP_HOST: z.string().trim().min(1).max(253),
    COUNCIL_HTTP_PORT: positiveInteger.max(65_535),
    COUNCIL_HTTP_CORS_ORIGINS_JSON: z.string().trim().min(1),
    COUNCIL_HTTP_CORS_MAX_AGE_SECONDS: positiveInteger,
    COUNCIL_HTTP_RATE_LIMIT_WINDOW_MS: positiveInteger,
    COUNCIL_HTTP_RATE_LIMIT_MAX: positiveInteger,
    COUNCIL_HTTP_BODY_LIMIT_BYTES: positiveInteger,
    COUNCIL_HTTP_EVENT_POLL_MS: positiveInteger,
    COUNCIL_HTTP_EVENT_RETRY_MS: positiveInteger,
    COUNCIL_HTTP_EVENT_HEARTBEAT_MS: positiveInteger,
    COUNCIL_HTTP_SHUTDOWN_TIMEOUT_MS: positiveInteger,
    COUNCIL_ORCHESTRATION_LEASE_TTL_MS: timerInteger,
    COUNCIL_ORCHESTRATION_LEASE_RENEW_MS: timerInteger,
    COUNCIL_ORCHESTRATION_SWEEP_INTERVAL_MS: timerInteger,
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_ROUNDS: positiveInteger.max(
      MAX_ORCHESTRATION_PLAN_ROUNDS,
    ),
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_ATTEMPTS: positiveInteger,
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_RECOVERIES: nonNegativeInteger,
    COUNCIL_ORCHESTRATION_DEFAULT_AGENT_TIMEOUT_MS: timerInteger,
    COUNCIL_ORCHESTRATION_AGENT_CLEANUP_TIMEOUT_MS: timerInteger,
    COUNCIL_ORCHESTRATION_CONFIRM_COMPLETION: booleanString,
    COUNCIL_ORCHESTRATION_RUN_PAGE_LIMIT: positiveInteger.max(MAX_LIST_LIMIT),
    COUNCIL_ORCHESTRATION_STARTUP_SCAN_LIMIT: positiveInteger.max(
      MAX_ORCHESTRATION_STARTUP_SCAN,
    ),
    COUNCIL_ORCHESTRATION_SHUTDOWN_TIMEOUT_MS: timerInteger,
    COUNCIL_RUNTIME_BINDING_IDLE_TIMEOUT_MS: timerInteger,
  });

// Tauri webview（macOS/Linux 生产构建）的固定 origin：自定义协议经 new URL()
// 归一化后 origin 为 "null"，无法通过下方 http/https 校验，因此按字面量放行。
const TAURI_WEBVIEW_ORIGIN = "tauri://localhost";

function parseAllowedOrigins(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("COUNCIL_HTTP_CORS_ORIGINS_JSON 必须是合法 JSON。");
  }
  const result = z.array(z.string().trim().url()).min(1).safeParse(value);
  if (!result.success) {
    throw new Error("COUNCIL_HTTP_CORS_ORIGINS_JSON 必须是非空 URL 字符串数组。");
  }
  const origins = result.data.map((item) => {
    if (item === TAURI_WEBVIEW_ORIGIN) {
      return item;
    }
    const url = new URL(item);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("CORS origin 只允许 HTTP 或 HTTPS 协议。");
    }
    if (url.origin !== item) {
      throw new Error("CORS origin 必须只包含协议、主机和端口。");
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function isLoopbackHost(value: string): boolean {
  const host = value.toLowerCase();
  if (host === "localhost" || host === "::1") {
    return true;
  }
  return isIP(host) === 4 && host.split(".")[0] === "127";
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): CouncilHttpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .filter((name) => name.length > 0)
      .join(", ");
    throw new Error(`HTTP 配置无效：${names || "环境变量格式错误"}。`);
  }

  const dataDir = parsed.data.COUNCIL_DATA_DIR;
  if (!path.isAbsolute(dataDir)) {
    throw new Error("COUNCIL_DATA_DIR 必须是绝对路径。");
  }
  if (!isLoopbackHost(parsed.data.COUNCIL_HTTP_HOST)) {
    throw new Error("COUNCIL_HTTP_HOST 只允许 loopback 主机。");
  }
  if (
    parsed.data.COUNCIL_ORCHESTRATION_LEASE_RENEW_MS >=
    parsed.data.COUNCIL_ORCHESTRATION_LEASE_TTL_MS
  ) {
    throw new Error("COUNCIL_ORCHESTRATION_LEASE_RENEW_MS 必须小于 lease TTL。");
  }
  if (
    parsed.data.COUNCIL_ORCHESTRATION_AGENT_CLEANUP_TIMEOUT_MS >
    parsed.data.COUNCIL_ORCHESTRATION_SHUTDOWN_TIMEOUT_MS
  ) {
    throw new Error(
      "COUNCIL_ORCHESTRATION_AGENT_CLEANUP_TIMEOUT_MS 不能超过编排关闭预算。",
    );
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return {
    databasePath: path.join(dataDir, "council.sqlite3"),
    sqliteBusyTimeoutMs: parsed.data.COUNCIL_SQLITE_BUSY_TIMEOUT_MS,
    schemaMigrationMaxAttempts:
      parsed.data.COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS,
    defaultMessageLimit: parsed.data.COUNCIL_DEFAULT_MESSAGE_LIMIT,
    host: parsed.data.COUNCIL_HTTP_HOST,
    port: parsed.data.COUNCIL_HTTP_PORT,
    allowedOrigins: parseAllowedOrigins(parsed.data.COUNCIL_HTTP_CORS_ORIGINS_JSON),
    corsMaxAgeSeconds: parsed.data.COUNCIL_HTTP_CORS_MAX_AGE_SECONDS,
    rateLimitWindowMs: parsed.data.COUNCIL_HTTP_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: parsed.data.COUNCIL_HTTP_RATE_LIMIT_MAX,
    bodyLimitBytes: parsed.data.COUNCIL_HTTP_BODY_LIMIT_BYTES,
    eventPollMs: parsed.data.COUNCIL_HTTP_EVENT_POLL_MS,
    eventRetryMs: parsed.data.COUNCIL_HTTP_EVENT_RETRY_MS,
    eventHeartbeatMs: parsed.data.COUNCIL_HTTP_EVENT_HEARTBEAT_MS,
    shutdownTimeoutMs: parsed.data.COUNCIL_HTTP_SHUTDOWN_TIMEOUT_MS,
    orchestrationLeaseTtlMs: parsed.data.COUNCIL_ORCHESTRATION_LEASE_TTL_MS,
    orchestrationLeaseRenewMs: parsed.data.COUNCIL_ORCHESTRATION_LEASE_RENEW_MS,
    orchestrationSweepIntervalMs:
      parsed.data.COUNCIL_ORCHESTRATION_SWEEP_INTERVAL_MS,
    orchestrationDefaultMaxRounds:
      parsed.data.COUNCIL_ORCHESTRATION_DEFAULT_MAX_ROUNDS,
    orchestrationDefaultMaxAttempts:
      parsed.data.COUNCIL_ORCHESTRATION_DEFAULT_MAX_ATTEMPTS,
    orchestrationDefaultMaxRecoveries:
      parsed.data.COUNCIL_ORCHESTRATION_DEFAULT_MAX_RECOVERIES,
    orchestrationDefaultAgentTimeoutMs:
      parsed.data.COUNCIL_ORCHESTRATION_DEFAULT_AGENT_TIMEOUT_MS,
    orchestrationAgentCleanupTimeoutMs:
      parsed.data.COUNCIL_ORCHESTRATION_AGENT_CLEANUP_TIMEOUT_MS,
    orchestrationConfirmCompletion:
      parsed.data.COUNCIL_ORCHESTRATION_CONFIRM_COMPLETION,
    orchestrationRunPageLimit: parsed.data.COUNCIL_ORCHESTRATION_RUN_PAGE_LIMIT,
    orchestrationStartupScanLimit:
      parsed.data.COUNCIL_ORCHESTRATION_STARTUP_SCAN_LIMIT,
    orchestrationShutdownTimeoutMs:
      parsed.data.COUNCIL_ORCHESTRATION_SHUTDOWN_TIMEOUT_MS,
    runtimeBindingIdleTimeoutMs:
      parsed.data.COUNCIL_RUNTIME_BINDING_IDLE_TIMEOUT_MS,
  };
}
