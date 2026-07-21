/**
 * @input  依赖：AgentSettingsDialog 的 Provider 可见性规则与 AgentSetting 领域类型
 * @output 导出：本机 Agent 常驻、远程 Provider 按需出现的回归测试
 * @pos    模型路由台不会随候选 Provider 数量线性展开的状态边界验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import { isAddedAgentSetting } from "../src/components/AgentSettingsDialog";
import type { AgentSetting } from "../src/types/agent-settings";

function createSetting(overrides: Partial<AgentSetting> = {}): AgentSetting {
  return {
    id: "provider-test",
    label: "Provider Test",
    kind: "openai-compatible",
    model: "",
    enabled: false,
    requiresApiKey: true,
    hasApiKey: false,
    updatedAt: "2026-01-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("模型路由台 Provider 可见性", () => {
  it("本机 CLI Agent 始终留在路由列表", () => {
    expect(isAddedAgentSetting(createSetting({
      id: "claude",
      kind: "claude-cli",
      requiresApiKey: false,
    }))).toBe(true);
  });

  it("未配置远程 Provider 只出现在按需添加目录", () => {
    expect(isAddedAgentSetting(createSetting())).toBe(false);
    expect(isAddedAgentSetting(createSetting({ baseUrl: "   " }))).toBe(false);
  });

  it.each([
    { enabled: true },
    { model: "provider-model-id" },
    { baseUrl: "https://api.example.com/v1" },
    { hasApiKey: true },
  ])("已启用或留有配置的远程 Provider 显示在路由列表：%o", (overrides) => {
    expect(isAddedAgentSetting(createSetting(overrides))).toBe(true);
  });
});
