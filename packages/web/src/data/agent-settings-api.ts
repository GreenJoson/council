/**
 * @input  依赖：模型设置 REST API 的未知 JSON data
 * @output 导出：Agent 设置列表、单项与连接测试的严格解析器
 * @pos    设置 UI 的唯一运行时协议校验入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AgentConnectionTest,
  AgentProviderKind,
  AgentSetting,
} from "../types/agent-settings";

const PROVIDER_KINDS: readonly AgentProviderKind[] = [
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

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} 必须是布尔值`);
  }
  return value;
}

export function parseAgentSetting(value: unknown): AgentSetting {
  const record = asRecord(value, "agent setting");
  const kind = stringValue(record, "kind");
  if (!PROVIDER_KINDS.includes(kind as AgentProviderKind)) {
    throw new Error("kind 包含不支持的值");
  }
  const baseUrl = record.baseUrl;
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || !baseUrl)) {
    throw new Error("baseUrl 必须是非空字符串");
  }
  return {
    id: stringValue(record, "id"),
    label: stringValue(record, "label"),
    kind: kind as AgentProviderKind,
    model: stringValue(record, "model", true),
    ...(typeof baseUrl === "string" ? { baseUrl } : {}),
    enabled: booleanValue(record, "enabled"),
    requiresApiKey: booleanValue(record, "requiresApiKey"),
    hasApiKey: booleanValue(record, "hasApiKey"),
    updatedAt: stringValue(record, "updatedAt"),
  };
}

export function parseAgentSettings(value: unknown): AgentSetting[] {
  const record = asRecord(value, "agent settings");
  if (!Array.isArray(record.agents)) {
    throw new Error("agents 必须是数组");
  }
  return record.agents.map(parseAgentSetting);
}

export function parseAgentConnectionTest(value: unknown): AgentConnectionTest {
  const record = asRecord(value, "agent connection test");
  const latencyMs = record.latencyMs;
  if (record.ok !== true || typeof latencyMs !== "number" || !Number.isSafeInteger(latencyMs)) {
    throw new Error("连接测试响应无效");
  }
  return { ok: true, latencyMs };
}
