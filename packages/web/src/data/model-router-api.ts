/**
 * @input  依赖：模型路由 REST API 的未知 JSON data
 * @output 导出：ModelRouter、Provider、Agent 与连接测试严格解析器
 * @pos    Model Router UI 的唯一运行时协议校验入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AgentConnectionTest,
  AgentDefinition,
  BrandAsset,
  ModelRouterSnapshot,
  ProviderCatalogEntry,
  ProviderProfile,
  ProviderProtocol,
} from "../types/model-router";

const PROTOCOLS: readonly ProviderProtocol[] = [
  "claude-cli",
  "codex-cli",
  "openai-compatible",
];

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string" || (!allowEmpty && !value)) {
    throw new Error(`${key} 必须是${allowEmpty ? "字符串" : "非空字符串"}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value) {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} 必须是布尔值`);
  }
  return value;
}

function protocolValue(record: Record<string, unknown>): ProviderProtocol {
  const value = stringValue(record, "protocol");
  if (!PROTOCOLS.includes(value as ProviderProtocol)) {
    throw new Error("protocol 包含不支持的值");
  }
  return value as ProviderProtocol;
}

export function parseBrandAsset(value: unknown): BrandAsset {
  const record = asRecord(value, "brand");
  const sourceKind = stringValue(record, "sourceKind");
  const status = stringValue(record, "status");
  if (
    (sourceKind !== "project-curated" && sourceKind !== "user-custom") ||
    (status !== "active" && status !== "inactive")
  ) {
    throw new Error("brand 枚举字段无效");
  }
  return {
    id: stringValue(record, "id"),
    slug: stringValue(record, "slug"),
    displayName: stringValue(record, "displayName"),
    glyphId: stringValue(record, "glyphId"),
    colorToken: stringValue(record, "colorToken"),
    sourceKind,
    sourceLabel: stringValue(record, "sourceLabel"),
    status,
    createdAt: stringValue(record, "createdAt"),
    updatedAt: stringValue(record, "updatedAt"),
  };
}

export function parseProviderProfile(value: unknown): ProviderProfile {
  const record = asRecord(value, "provider");
  const status = stringValue(record, "status");
  if (status !== "active" && status !== "inactive" && status !== "deleted") {
    throw new Error("provider.status 无效");
  }
  const baseUrl = optionalString(record, "baseUrl");
  return {
    id: stringValue(record, "id"),
    slug: stringValue(record, "slug"),
    displayName: stringValue(record, "displayName"),
    protocol: protocolValue(record),
    ...(baseUrl ? { baseUrl } : {}),
    requiresApiKey: booleanValue(record, "requiresApiKey"),
    hasApiKey: booleanValue(record, "hasApiKey"),
    brandAssetId: stringValue(record, "brandAssetId"),
    status,
    createdAt: stringValue(record, "createdAt"),
    updatedAt: stringValue(record, "updatedAt"),
  };
}

export function parseAgentDefinition(value: unknown): AgentDefinition {
  const record = asRecord(value, "agent");
  const deletedAt = optionalString(record, "deletedAt");
  return {
    id: stringValue(record, "id"),
    actorId: stringValue(record, "actorId"),
    providerId: stringValue(record, "providerId"),
    slug: stringValue(record, "slug"),
    displayName: stringValue(record, "displayName"),
    model: stringValue(record, "model", true),
    mentionAlias: stringValue(record, "mentionAlias"),
    enabled: booleanValue(record, "enabled"),
    ...(deletedAt ? { deletedAt } : {}),
    createdAt: stringValue(record, "createdAt"),
    updatedAt: stringValue(record, "updatedAt"),
  };
}

function parseCatalogEntry(value: unknown): ProviderCatalogEntry {
  const record = asRecord(value, "provider catalog");
  const baseUrl = optionalString(record, "baseUrl");
  if (!Array.isArray(record.modelCandidates)) {
    throw new Error("modelCandidates 必须是数组");
  }
  return {
    templateId: stringValue(record, "templateId"),
    slug: stringValue(record, "slug"),
    displayName: stringValue(record, "displayName"),
    protocol: protocolValue(record),
    ...(baseUrl ? { baseUrl } : {}),
    requiresApiKey: booleanValue(record, "requiresApiKey"),
    brandAssetId: stringValue(record, "brandAssetId"),
    modelCandidates: record.modelCandidates.map((item) => {
      if (typeof item !== "string" || !item) {
        throw new Error("modelCandidates 项无效");
      }
      return item;
    }),
  };
}

export function parseModelRouterSnapshot(value: unknown): ModelRouterSnapshot {
  const record = asRecord(value, "model router");
  const catalog = asRecord(record.catalog, "catalog");
  if (
    !Array.isArray(record.providers) ||
    !Array.isArray(record.agents) ||
    !Array.isArray(record.brands) ||
    !Array.isArray(catalog.providers)
  ) {
    throw new Error("model router 数组字段无效");
  }
  return {
    providers: record.providers.map(parseProviderProfile),
    agents: record.agents.map(parseAgentDefinition),
    brands: record.brands.map(parseBrandAsset),
    catalog: {
      providers: catalog.providers.map(parseCatalogEntry),
    },
  };
}

export function parseAgentConnectionTest(value: unknown): AgentConnectionTest {
  const record = asRecord(value, "agent connection test");
  const latencyMs = record.latencyMs;
  if (record.ok !== true || typeof latencyMs !== "number" || !Number.isSafeInteger(latencyMs)) {
    throw new Error("连接测试响应无效");
  }
  return { ok: true, latencyMs };
}
