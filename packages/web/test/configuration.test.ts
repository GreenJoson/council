/**
 * @input  依赖：createCouncilRepository 与 Vite 环境变量替身
 * @output 导出：http 模式项目路径配置的正负路径测试
 * @pos    Web factory 拒绝不可信 Agent cwd 的配置回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCouncilRepository } from "../src/data/create-repository";

function stubHttpConfig(projectPath: string): void {
  vi.stubEnv("VITE_COUNCIL_DATA_MODE", "http");
  vi.stubEnv("VITE_COUNCIL_API_URL", "https://example.com");
  vi.stubEnv("VITE_COUNCIL_PROJECT_PATH", projectPath);
  vi.stubEnv("VITE_COUNCIL_TOPIC_PAGE_SIZE", "100");
  vi.stubEnv("VITE_COUNCIL_MESSAGE_PAGE_SIZE", "100");
  vi.stubEnv("VITE_COUNCIL_EVENT_REFRESH_MAX_ATTEMPTS", "3");
  vi.stubEnv("VITE_COUNCIL_EVENT_REFRESH_RETRY_DELAY_MS", "1000");
  vi.stubEnv("VITE_COUNCIL_EVENT_RECOVERY_DELAY_MS", "10000");
}

describe.sequential("Council repository 配置", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["", "relative/project", "C:relative", "\\\\server-only"])(
    "http 模式拒绝空值或非绝对项目路径：%s",
    (projectPath) => {
      stubHttpConfig(projectPath);
      expect(() => createCouncilRepository()).toThrow(/VITE_COUNCIL_PROJECT_PATH/);
    },
  );

  it.each([
    "/path/to/project",
    "C:\\path\\to\\project",
    "\\\\server\\share\\project",
  ])("http 模式接受跨平台绝对项目路径：%s", (projectPath) => {
    stubHttpConfig(`  ${projectPath}  `);
    expect(() => createCouncilRepository()).not.toThrow();
  });
});
