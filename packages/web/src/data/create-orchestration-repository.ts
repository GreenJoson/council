/**
 * @input  依赖：VITE_COUNCIL_* 数据源、分页、重试、恢复与桌面健康探测配置
 * @output 导出：当前环境对应的 OrchestrationRepository
 * @pos    自动轮次数据实现的集中式选择入口；desktop 模式经 Tauri 桥接
 *         获取本地 Agent 服务地址并直连 HTTP 编排 API
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  BROWSER_MAX_TIMER_DELAY_MS,
  COUNCIL_API_MAX_PAGE_SIZE,
  MAX_EVENT_REFRESH_ATTEMPTS,
} from "./api-constants";
import { readIntegerConfig } from "./create-repository";
import { createDesktopBridge } from "./desktop-bridge";
import { DesktopOrchestrationRepository } from "./desktop-orchestration-repository";
import {
  HttpOrchestrationRepository,
  type HttpOrchestrationRepositoryOptions,
} from "./http-orchestration-repository";
import { MockOrchestrationRepository } from "./mock-orchestration-repository";
import type { OrchestrationRepository } from "./orchestration-repository";

/** http 与 desktop 模式共享的 HTTP 编排仓储调优参数（不含 baseUrl）。 */
function readHttpOrchestrationTuning(): Omit<HttpOrchestrationRepositoryOptions, "baseUrl"> {
  return {
    runPageSize: readIntegerConfig(
      import.meta.env.VITE_COUNCIL_ORCHESTRATION_PAGE_SIZE,
      "VITE_COUNCIL_ORCHESTRATION_PAGE_SIZE",
      1,
      COUNCIL_API_MAX_PAGE_SIZE,
    ),
    eventRefreshMaxAttempts: readIntegerConfig(
      import.meta.env.VITE_COUNCIL_EVENT_REFRESH_MAX_ATTEMPTS,
      "VITE_COUNCIL_EVENT_REFRESH_MAX_ATTEMPTS",
      1,
      MAX_EVENT_REFRESH_ATTEMPTS,
    ),
    eventRefreshRetryDelayMs: readIntegerConfig(
      import.meta.env.VITE_COUNCIL_EVENT_REFRESH_RETRY_DELAY_MS,
      "VITE_COUNCIL_EVENT_REFRESH_RETRY_DELAY_MS",
      0,
      BROWSER_MAX_TIMER_DELAY_MS,
    ),
    eventRecoveryDelayMs: readIntegerConfig(
      import.meta.env.VITE_COUNCIL_ORCHESTRATION_RECOVERY_DELAY_MS,
      "VITE_COUNCIL_ORCHESTRATION_RECOVERY_DELAY_MS",
      1,
      BROWSER_MAX_TIMER_DELAY_MS,
    ),
  };
}

export function createOrchestrationRepository(): OrchestrationRepository {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  if (mode === "mock") {
    return new MockOrchestrationRepository();
  }
  if (mode === "desktop") {
    // 服务地址只来自 Rust 设置层（get_orchestration_config），不进入前端环境变量。
    const tuning = readHttpOrchestrationTuning();
    return new DesktopOrchestrationRepository({
      bridge: createDesktopBridge(),
      createDelegate: (baseUrl) =>
        new HttpOrchestrationRepository({ baseUrl, ...tuning }),
      healthCheckIntervalMs: readIntegerConfig(
        import.meta.env.VITE_COUNCIL_DESKTOP_HEALTH_INTERVAL_MS,
        "VITE_COUNCIL_DESKTOP_HEALTH_INTERVAL_MS",
        1,
        BROWSER_MAX_TIMER_DELAY_MS,
      ),
    });
  }
  if (mode !== "http") {
    throw new Error(`不支持的数据模式：${mode}，仅允许 mock、http 或 desktop`);
  }
  const baseUrl = import.meta.env.VITE_COUNCIL_API_URL?.trim();
  if (!baseUrl) {
    throw new Error("http 模式必须配置 VITE_COUNCIL_API_URL");
  }
  return new HttpOrchestrationRepository({
    baseUrl,
    ...readHttpOrchestrationTuning(),
  });
}
