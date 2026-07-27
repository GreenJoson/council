/**
 * @input  依赖：模型路由严格解析器与 Provider/Agent/Brand REST 快照
 * @output 导出：供应商名称、同 Provider 多 Agent、独立 @alias 与密钥不回显测试
 * @pos    ModelRouterDialog 读取动态路由时的运行时协议回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import {
  isSystemAgentDefinition,
  isKnownProviderTemplate,
  isSystemProviderProfile,
} from "../src/components/ModelRouterDialog";
import { parseModelRouterSnapshot } from "../src/data/model-router-api";

const NOW = "2026-01-01T08:00:00.000Z";

function routerSnapshot(): unknown {
  return {
    providers: [{
      id: "provider-kimi",
      slug: "kimi",
      displayName: "Kimi",
      protocol: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      requiresApiKey: true,
      hasApiKey: true,
      brandAssetId: "brand-kimi",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    }],
    agents: [
      {
        id: "agent-kimi-main",
        actorId: "actor-kimi-main",
        providerId: "provider-kimi",
        slug: "kimi-main",
        displayName: "Kimi 主审",
        model: "kimi-model",
        mentionAlias: "kimi",
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "agent-kimi-fast",
        actorId: "actor-kimi-fast",
        providerId: "provider-kimi",
        slug: "kimi-fast",
        displayName: "Kimi 快审",
        model: "kimi-fast-model",
        mentionAlias: "kimi-fast",
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    brands: [{
      id: "brand-kimi",
      slug: "kimi",
      displayName: "Kimi",
      glyphId: "simple-icons-kimi",
      colorToken: "brand-kimi",
      sourceKind: "project-curated",
      sourceLabel: "Simple Icons · CC0-1.0",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    }],
    catalog: {
      providers: [{
        templateId: "kimi",
        slug: "kimi",
        displayName: "Kimi",
        protocol: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        requiresApiKey: true,
        brandAssetId: "brand-kimi",
        modelCandidates: [],
      }],
    },
  };
}

describe("动态模型路由协议", () => {
  it("保留供应商原名和离线品牌，不退化为 Other", () => {
    const snapshot = parseModelRouterSnapshot(routerSnapshot());
    expect(snapshot.providers[0]?.displayName).toBe("Kimi");
    expect(snapshot.brands[0]?.glyphId).toBe("simple-icons-kimi");
    expect(JSON.stringify(snapshot)).not.toContain("Other");
  });

  it("同一个 Provider 可以声明多个独立 Agent 和 @alias", () => {
    const snapshot = parseModelRouterSnapshot(routerSnapshot());
    expect(snapshot.agents.map((agent) => agent.providerId)).toEqual([
      "provider-kimi",
      "provider-kimi",
    ]);
    expect(snapshot.agents.map((agent) => agent.mentionAlias)).toEqual([
      "kimi",
      "kimi-fast",
    ]);
    expect(new Set(snapshot.agents.map((agent) => agent.actorId)).size).toBe(2);
  });

  it("ACP Provider 与模板都必须显式携带同一类 RuntimeDefinition 引用", () => {
    const value = routerSnapshot() as {
      providers: Array<Record<string, unknown>>;
      catalog: { providers: Array<Record<string, unknown>> };
    };
    value.providers[0] = {
      ...value.providers[0],
      protocol: "acp",
      runtimeDefinitionId: "kimi-code",
      baseUrl: undefined,
      requiresApiKey: false,
      hasApiKey: false,
    };
    value.catalog.providers[0] = {
      ...value.catalog.providers[0],
      protocol: "acp",
      runtimeDefinitionId: "kimi-code",
      baseUrl: undefined,
      requiresApiKey: false,
    };
    const parsed = parseModelRouterSnapshot(value);
    expect(parsed.providers[0]?.runtimeDefinitionId).toBe("kimi-code");
    expect(parsed.catalog.providers[0]?.runtimeDefinitionId).toBe("kimi-code");

    delete value.providers[0]?.runtimeDefinitionId;
    expect(() => parseModelRouterSnapshot(value)).toThrow(/RuntimeDefinition/u);
  });

  it("公开快照只返回 hasApiKey，不接受密钥正文", () => {
    const snapshot = routerSnapshot() as Record<string, unknown>;
    const providers = snapshot.providers as Array<Record<string, unknown>>;
    providers[0] = { ...providers[0], apiKey: "must-not-return" };
    const parsed = parseModelRouterSnapshot(snapshot);
    expect(parsed.providers[0]?.hasApiKey).toBe(true);
    expect("apiKey" in (parsed.providers[0] as object)).toBe(false);
  });

  it("系统 Provider 不可删除，已知模板身份字段必须锁定", () => {
    const parsed = parseModelRouterSnapshot(routerSnapshot());
    expect(isSystemProviderProfile({
      ...parsed.providers[0]!,
      protocol: "claude-cli",
    })).toBe(true);
    expect(isSystemProviderProfile(parsed.providers[0]!)).toBe(false);
    expect(isKnownProviderTemplate(parsed.catalog.providers[0])).toBe(true);
    expect(isKnownProviderTemplate({
      ...parsed.catalog.providers[0]!,
      templateId: "custom",
    })).toBe(false);
  });

  it("只有 Claude/Codex 是不可改名的系统 Agent，远程 Agent 保持动态", () => {
    const parsed = parseModelRouterSnapshot(routerSnapshot());
    expect(isSystemAgentDefinition({
      ...parsed.agents[0]!,
      actorId: "claude",
      displayName: "Claude",
      mentionAlias: "claude",
    })).toBe(true);
    expect(isSystemAgentDefinition({
      ...parsed.agents[0]!,
      actorId: "codex",
      displayName: "Codex",
      mentionAlias: "codex",
    })).toBe(true);
    expect(isSystemAgentDefinition(parsed.agents[0]!)).toBe(false);
  });
});
