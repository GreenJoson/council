/**
 * @input  依赖：AgentSettingsStore、系统 SecretStore 与可注入连接测试器
 * @output 导出：设置列表、更新、密钥状态与连接测试服务
 * @pos    HTTP 设置 API 和运行时适配器之间的安全应用服务
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  AgentSettingsStore,
  type AgentProviderKind,
  type AgentSetting,
} from "./agent-settings-store.js";
import type { SecretStore } from "./keychain-secret-store.js";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_MODEL_CHARS = 200;
const MAX_API_KEY_CHARS = 4_096;

export interface PublicAgentSetting extends AgentSetting {
  hasApiKey: boolean;
}

export interface UpdateAgentSettingInput {
  model: string;
  baseUrl?: string;
  enabled: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface AgentConnectionTest {
  ok: true;
  latencyMs: number;
}

export type AgentConnectionTester = () => Promise<void>;

function normalizeModel(value: string, kind: AgentProviderKind, enabled: boolean): string {
  const model = value.trim();
  if (model.length > MAX_MODEL_CHARS) {
    throw new Error("模型 ID 不能超过 200 个字符。");
  }
  if (enabled && kind !== "codex-cli" && !model) {
    throw new Error("启用该 Agent 前必须填写模型 ID。");
  }
  return model;
}

function normalizeBaseUrl(value: string | undefined, enabled: boolean): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    if (enabled) {
      throw new Error("启用远程 Provider 前必须填写 API Base URL。");
    }
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("API Base URL 必须是有效的绝对 URL。");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "::1"
    || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("API Base URL 只允许 HTTPS，或用于本地模型的 loopback HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API Base URL 不能包含凭据、查询参数或片段。");
  }
  return trimmed.replace(/\/+$/, "");
}

export class AgentSettingsService {
  readonly #testers = new Map<string, AgentConnectionTester>();

  constructor(
    private readonly store: AgentSettingsStore,
    private readonly secrets: SecretStore,
  ) {}

  get(id: string): AgentSetting | undefined {
    return this.store.get(id);
  }

  async getApiKey(id: string): Promise<string | undefined> {
    return await this.secrets.get(id);
  }

  async isReady(id: string): Promise<boolean> {
    const setting = this.store.get(id);
    if (!setting?.enabled) {
      return false;
    }
    if (setting.kind === "openai-compatible") {
      return Boolean(setting.model && setting.baseUrl && await this.secrets.has(id));
    }
    return true;
  }

  async list(): Promise<PublicAgentSetting[]> {
    return await Promise.all(this.store.list().map(async (setting) => ({
      ...setting,
      hasApiKey: setting.requiresApiKey ? await this.secrets.has(setting.id) : false,
    })));
  }

  async update(id: string, input: UpdateAgentSettingInput): Promise<PublicAgentSetting> {
    if (!AGENT_ID_PATTERN.test(id)) {
      throw new Error("Agent ID 格式无效。");
    }
    const current = this.store.get(id);
    if (!current) {
      throw new Error("Agent 设置不存在。");
    }
    if (input.apiKey !== undefined && input.clearApiKey) {
      throw new Error("不能同时设置和清除 API Key。");
    }
    const model = normalizeModel(input.model, current.kind, input.enabled);
    const baseUrl = current.kind === "openai-compatible"
      ? normalizeBaseUrl(input.baseUrl, input.enabled)
      : undefined;
    if (current.kind !== "openai-compatible" && (input.apiKey !== undefined || input.clearApiKey)) {
      throw new Error("本机 CLI Agent 不接受 API Key。");
    }
    const apiKey = input.apiKey?.trim();
    if (apiKey !== undefined && (!apiKey || apiKey.length > MAX_API_KEY_CHARS)) {
      throw new Error("API Key 必须为非空文本且不能超过安全上限。");
    }
    if (
      current.kind === "openai-compatible"
      && input.enabled
      && !apiKey
      && (input.clearApiKey || !await this.secrets.has(id))
    ) {
      throw new Error("启用远程 Provider 前必须保存 API Key。");
    }
    const changesSecret = Boolean(apiKey) || input.clearApiKey === true;
    const previousSecret = changesSecret ? await this.secrets.get(id) : undefined;
    if (apiKey) {
      await this.secrets.set(id, apiKey);
    } else if (input.clearApiKey) {
      await this.secrets.delete(id);
    }
    let setting: AgentSetting;
    try {
      setting = this.store.update({
        id,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        enabled: input.enabled,
      });
    } catch (error) {
      if (changesSecret) {
        try {
          if (previousSecret) {
            await this.secrets.set(id, previousSecret);
          } else {
            await this.secrets.delete(id);
          }
        } catch {
          throw new Error("Agent 设置保存失败，且系统 Keychain 未能恢复原凭据状态。");
        }
      }
      throw error;
    }
    return {
      ...setting,
      hasApiKey: setting.requiresApiKey ? await this.secrets.has(id) : false,
    };
  }

  registerTester(id: string, tester: AgentConnectionTester): void {
    this.#testers.set(id, tester);
  }

  async test(id: string): Promise<AgentConnectionTest> {
    const tester = this.#testers.get(id);
    if (!tester) {
      throw new Error("该 Agent 没有可用的连接测试器。");
    }
    if (!await this.isReady(id)) {
      throw new Error("请先完成模型、Provider 地址和 API Key 配置并启用该 Agent。");
    }
    const startedAt = Date.now();
    await tester();
    return { ok: true, latencyMs: Date.now() - startedAt };
  }

  close(): void {
    this.store.close();
  }
}
