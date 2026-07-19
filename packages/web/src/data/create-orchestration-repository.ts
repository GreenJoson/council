/**
 * @input  依赖：VITE_COUNCIL_* 数据源、分页、重试和恢复配置
 * @output 导出：当前环境对应的 OrchestrationRepository
 * @pos    自动轮次数据实现的集中式选择入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  BROWSER_MAX_TIMER_DELAY_MS,
  COUNCIL_API_MAX_PAGE_SIZE,
  MAX_EVENT_REFRESH_ATTEMPTS,
} from "./api-constants";
import { readIntegerConfig } from "./create-repository";
import { HttpOrchestrationRepository } from "./http-orchestration-repository";
import { MockOrchestrationRepository } from "./mock-orchestration-repository";
import type { OrchestrationRepository } from "./orchestration-repository";

export function createOrchestrationRepository(): OrchestrationRepository {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  if (mode === "mock") {
    return new MockOrchestrationRepository();
  }
  if (mode !== "http") {
    throw new Error(`不支持的数据模式：${mode}，仅允许 mock 或 http`);
  }
  const baseUrl = import.meta.env.VITE_COUNCIL_API_URL?.trim();
  if (!baseUrl) {
    throw new Error("http 模式必须配置 VITE_COUNCIL_API_URL");
  }
  return new HttpOrchestrationRepository({
    baseUrl,
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
  });
}
