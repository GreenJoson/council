/**
 * @input  依赖：隔离环境变量、临时数据目录与 HTTP 配置加载器
 * @output 导出：必填项、迁移 fail-fast、loopback host 与 exact origin 配置测试
 * @pos    HTTP 服务启动前配置防错的单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadHttpConfig } from "../src/http/config.js";

function createEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    COUNCIL_DATA_DIR: dataDir,
    COUNCIL_SQLITE_BUSY_TIMEOUT_MS: "5000",
    COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS: "3",
    COUNCIL_DEFAULT_MESSAGE_LIMIT: "20",
    COUNCIL_HTTP_HOST: "localhost",
    COUNCIL_HTTP_PORT: "4317",
    COUNCIL_HTTP_CORS_ORIGINS_JSON: '["https://web.example"]',
    COUNCIL_HTTP_CORS_MAX_AGE_SECONDS: "600",
    COUNCIL_HTTP_RATE_LIMIT_WINDOW_MS: "60000",
    COUNCIL_HTTP_RATE_LIMIT_MAX: "120",
    COUNCIL_HTTP_BODY_LIMIT_BYTES: "65536",
    COUNCIL_HTTP_EVENT_POLL_MS: "500",
    COUNCIL_HTTP_EVENT_RETRY_MS: "3000",
    COUNCIL_HTTP_EVENT_HEARTBEAT_MS: "15000",
    COUNCIL_HTTP_SHUTDOWN_TIMEOUT_MS: "5000",
    COUNCIL_ORCHESTRATION_LEASE_TTL_MS: "30000",
    COUNCIL_ORCHESTRATION_LEASE_RENEW_MS: "10000",
    COUNCIL_ORCHESTRATION_SWEEP_INTERVAL_MS: "5000",
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_ROUNDS: "10",
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_ATTEMPTS: "2",
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_RECOVERIES: "1",
    COUNCIL_ORCHESTRATION_DEFAULT_AGENT_TIMEOUT_MS: "120000",
    COUNCIL_ORCHESTRATION_AGENT_CLEANUP_TIMEOUT_MS: "3000",
    COUNCIL_ORCHESTRATION_CONFIRM_COMPLETION: "true",
    COUNCIL_ORCHESTRATION_RUN_PAGE_LIMIT: "20",
    COUNCIL_ORCHESTRATION_STARTUP_SCAN_LIMIT: "1000",
    COUNCIL_ORCHESTRATION_SHUTDOWN_TIMEOUT_MS: "5000",
    UNRELATED_PROCESS_VALUE: "ignored",
  };
}

test("HTTP 配置只接受完整、有效且 exact 的 origin", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-http-config-test-"));
  try {
    const config = loadHttpConfig(createEnv(directory));
    assert.equal(config.databasePath, path.join(directory, "council.sqlite3"));
    assert.deepEqual(config.allowedOrigins, ["https://web.example"]);
    assert.equal(config.port, 4317);
    assert.equal(config.eventRetryMs, 3_000);
    assert.equal(config.orchestrationConfirmCompletion, true);
    assert.equal(config.orchestrationLeaseRenewMs, 10_000);

    const missingMigrationAttempts = createEnv(directory);
    delete missingMigrationAttempts.COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS;
    assert.throws(
      () => loadHttpConfig(missingMigrationAttempts),
      /COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS/,
    );

    const missingHost = createEnv(directory);
    delete missingHost.COUNCIL_HTTP_HOST;
    assert.throws(() => loadHttpConfig(missingHost), /COUNCIL_HTTP_HOST/);

    const missingRetry = createEnv(directory);
    delete missingRetry.COUNCIL_HTTP_EVENT_RETRY_MS;
    assert.throws(() => loadHttpConfig(missingRetry), /COUNCIL_HTTP_EVENT_RETRY_MS/);

    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.255.0.1", "::1"]) {
      const loopback = createEnv(directory);
      loopback.COUNCIL_HTTP_HOST = host;
      assert.doesNotThrow(() => loadHttpConfig(loopback));
    }
    for (const host of ["example.com", "0.0.0.0", "::"]) {
      const remote = createEnv(directory);
      remote.COUNCIL_HTTP_HOST = host;
      assert.throws(() => loadHttpConfig(remote), /loopback/);
    }

    const originWithPath = createEnv(directory);
    originWithPath.COUNCIL_HTTP_CORS_ORIGINS_JSON = '["https://web.example/path"]';
    assert.throws(() => loadHttpConfig(originWithPath), /只包含协议、主机和端口/);

    const tauriOrigin = createEnv(directory);
    tauriOrigin.COUNCIL_HTTP_CORS_ORIGINS_JSON =
      '["https://web.example", "tauri://localhost"]';
    assert.deepEqual(loadHttpConfig(tauriOrigin).allowedOrigins, [
      "https://web.example",
      "tauri://localhost",
    ]);

    const tauriLikeOrigin = createEnv(directory);
    tauriLikeOrigin.COUNCIL_HTTP_CORS_ORIGINS_JSON = '["tauri://evil.example"]';
    assert.throws(() => loadHttpConfig(tauriLikeOrigin), /HTTP 或 HTTPS/);

    const invalidBoolean = createEnv(directory);
    invalidBoolean.COUNCIL_ORCHESTRATION_CONFIRM_COMPLETION = "yes";
    assert.throws(() => loadHttpConfig(invalidBoolean), /CONFIRM_COMPLETION/);

    const invalidRenewal = createEnv(directory);
    invalidRenewal.COUNCIL_ORCHESTRATION_LEASE_RENEW_MS = "30000";
    assert.throws(() => loadHttpConfig(invalidRenewal), /必须小于 lease TTL/);

    const unsafeTimer = createEnv(directory);
    unsafeTimer.COUNCIL_ORCHESTRATION_DEFAULT_AGENT_TIMEOUT_MS = "2147483648";
    assert.throws(() => loadHttpConfig(unsafeTimer), /DEFAULT_AGENT_TIMEOUT_MS/);

    const cleanupBeyondShutdown = createEnv(directory);
    cleanupBeyondShutdown.COUNCIL_ORCHESTRATION_AGENT_CLEANUP_TIMEOUT_MS = "5001";
    assert.throws(() => loadHttpConfig(cleanupBeyondShutdown), /不能超过编排关闭预算/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
