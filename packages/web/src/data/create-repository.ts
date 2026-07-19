/**
 * @input  依赖：VITE_COUNCIL_* 数据源、项目路径、分页和 revision 重试配置
 * @output 导出：当前环境对应的 CouncilRepository
 * @pos    WebUI 数据实现的集中式选择入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  BROWSER_MAX_TIMER_DELAY_MS,
  COUNCIL_API_MAX_PAGE_SIZE,
  MAX_EVENT_REFRESH_ATTEMPTS,
} from "./api-constants";
import { HttpCouncilRepository } from "./http-repository";
import { MockCouncilRepository } from "./mock-repository";
import { readProjectPathConfig } from "./project-path";
import type { CouncilRepository } from "./repository";

export function readIntegerConfig(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} 必须是 ${String(minimum)} 到 ${String(maximum)} 之间的整数`,
    );
  }
  return parsed;
}

export function createCouncilRepository(): CouncilRepository {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  if (mode === "mock") {
    return new MockCouncilRepository();
  }
  if (mode === "http") {
    const baseUrl = import.meta.env.VITE_COUNCIL_API_URL?.trim();
    if (!baseUrl) {
      throw new Error("http 模式必须配置 VITE_COUNCIL_API_URL");
    }
    return new HttpCouncilRepository({
      baseUrl,
      projectPath: readProjectPathConfig(import.meta.env.VITE_COUNCIL_PROJECT_PATH),
      topicPageSize: readIntegerConfig(
        import.meta.env.VITE_COUNCIL_TOPIC_PAGE_SIZE,
        "VITE_COUNCIL_TOPIC_PAGE_SIZE",
        1,
        COUNCIL_API_MAX_PAGE_SIZE,
      ),
      messagePageSize: readIntegerConfig(
        import.meta.env.VITE_COUNCIL_MESSAGE_PAGE_SIZE,
        "VITE_COUNCIL_MESSAGE_PAGE_SIZE",
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
        import.meta.env.VITE_COUNCIL_EVENT_RECOVERY_DELAY_MS,
        "VITE_COUNCIL_EVENT_RECOVERY_DELAY_MS",
        1,
        BROWSER_MAX_TIMER_DELAY_MS,
      ),
    });
  }
  throw new Error(`不支持的数据模式：${mode}，仅允许 mock 或 http`);
}
