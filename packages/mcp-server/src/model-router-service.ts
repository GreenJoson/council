/**
 * @input  依赖：ModelRouterStore、系统 SecretStore、Provider catalog 与可注入连接测试器
 * @output 导出：公开模型路由快照、Provider/Agent 增删改、连接测试和安全凭据操作
 * @pos    HTTP 设置 API、capabilities 与临时适配器工厂之间的模型路由应用服务
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import type { SecretStore } from "./keychain-secret-store.js";
import {
  type AgentDefinition,
  type BrandAsset,
  ModelRouterStore,
  type ProviderProfile,
} from "./model-router-store.js";
import {
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
  type ProviderProtocol,
} from "./provider-catalog.js";

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MENTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_NAME_CHARS = 120;
const MAX_MODEL_CHARS = 200;
const MAX_API_KEY_CHARS = 4_096;

export class ModelRouterPublicError extends Error {
  override readonly name = "ModelRouterPublicError";

  constructor(
    readonly status: 400 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new ModelRouterPublicError(400, message);
}

function conflict(message: string): never {
  throw new ModelRouterPublicError(409, message);
}

function compensationFailed(message: string): never {
  throw new ModelRouterPublicError(500, message);
}

export interface PublicProviderProfile extends Omit<ProviderProfile, "credentialRef"> {
  hasApiKey: boolean;
}

export interface ModelRouterSnapshot {
  providers: PublicProviderProfile[];
  agents: AgentDefinition[];
  brands: BrandAsset[];
  catalog: {
    providers: readonly ProviderCatalogEntry[];
  };
}

export interface CreateProviderInput {
  templateId: string;
  slug: string;
  displayName: string;
  baseUrl?: string;
  brandAssetId?: string;
  apiKey?: string;
  active: boolean;
}

export interface UpdateProviderInput {
  displayName: string;
  baseUrl?: string;
  brandAssetId: string;
  active: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface CreateAgentInput {
  providerId: string;
  slug: string;
  displayName: string;
  model: string;
  mentionAlias: string;
  enabled: boolean;
}

export interface UpdateAgentDefinitionInput {
  displayName: string;
  model: string;
  mentionAlias: string;
  enabled: boolean;
}

export interface ModelRouterConnectionTest {
  ok: true;
  latencyMs: number;
}

export type ModelRouterConnectionTester = (
  agent: AgentDefinition,
  provider: ProviderProfile,
  apiKey: string | undefined,
) => Promise<void>;

function normalizeName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_NAME_CHARS) {
    invalid(`${label} 必须为 1-${String(MAX_NAME_CHARS)} 个字符。`);
  }
  return normalized;
}

function normalizeSlug(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!SLUG_PATTERN.test(normalized)) {
    invalid(`${label} 必须以小写字母开头，只能包含小写字母、数字和短横线。`);
  }
  return normalized;
}

function normalizeMention(value: string): string {
  const normalized = value.trim().replace(/^@/u, "").toLocaleLowerCase("en-US");
  if (!MENTION_PATTERN.test(normalized)) {
    invalid("@alias 格式无效。");
  }
  return normalized;
}

function normalizeModel(value: string, protocol: ProviderProtocol, enabled: boolean): string {
  const normalized = value.trim();
  if (normalized.length > MAX_MODEL_CHARS) {
    invalid(`模型 ID 不能超过 ${String(MAX_MODEL_CHARS)} 个字符。`);
  }
  if (enabled && protocol !== "codex-cli" && !normalized) {
    invalid("启用该 Agent 前必须填写模型 ID。");
  }
  return normalized;
}

function normalizeApiKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_API_KEY_CHARS) {
    invalid("API Key 必须为非空文本且不能超过安全上限。");
  }
  return normalized;
}

function normalizeBaseUrl(
  value: string | undefined,
  protocol: ProviderProtocol,
  active: boolean,
): string | undefined {
  if (protocol !== "openai-compatible") {
    if (value?.trim()) {
      invalid("本机 CLI Provider 不接受 API Base URL。");
    }
    return undefined;
  }
  const normalized = value?.trim();
  if (!normalized) {
    if (active) {
      invalid("启用远程 Provider 前必须填写 API Base URL。");
    }
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    invalid("API Base URL 必须是有效的绝对 URL。");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "::1"
    || /^127(?:\.[0-9]{1,3}){3}$/u.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    invalid("API Base URL 只允许 HTTPS，或用于本地模型的 loopback HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) {
    invalid("API Base URL 不能包含凭据、查询参数或片段。");
  }
  return normalized.replace(/\/+$/u, "");
}

function safeShortName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").slice(0, 3).toLocaleUpperCase("en-US") || "AI";
}

function publicConflict(error: unknown): never {
  if (error instanceof Error && /UNIQUE constraint failed/iu.test(error.message)) {
    conflict("slug 或 @alias 已被使用。");
  }
  throw error;
}

function publicProvider(
  provider: ProviderProfile,
  hasApiKey: boolean,
): PublicProviderProfile {
  const { credentialRef: _credentialRef, ...profile } = provider;
  return { ...profile, hasApiKey };
}

function catalogTemplateForProvider(provider: ProviderProfile): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.providers.find(
    (entry) => entry.slug === provider.slug && entry.protocol === provider.protocol,
  );
}

function isSystemProvider(provider: ProviderProfile): boolean {
  return provider.protocol === "claude-cli" || provider.protocol === "codex-cli";
}

function lockedSystemAgentIdentity(
  actorId: string,
): Readonly<{ displayName: string; mentionAlias: string }> | undefined {
  if (actorId === "claude") {
    return { displayName: "Claude", mentionAlias: "claude" };
  }
  if (actorId === "codex") {
    return { displayName: "Codex", mentionAlias: "codex" };
  }
  return undefined;
}

export class ModelRouterService {
  #tester: ModelRouterConnectionTester | undefined;

  constructor(
    private readonly store: ModelRouterStore,
    private readonly secrets: SecretStore,
  ) {}

  registerTester(tester: ModelRouterConnectionTester): void {
    this.#tester = tester;
  }

  getAgent(id: string): AgentDefinition | undefined {
    return this.store.getAgent(id);
  }

  getProvider(id: string): ProviderProfile | undefined {
    return this.store.getProvider(id);
  }

  async getApiKeyForAgent(agentId: string): Promise<string | undefined> {
    const agent = this.store.getAgent(agentId);
    const provider = agent ? this.store.getProvider(agent.providerId) : undefined;
    return provider?.credentialRef
      ? await this.secrets.get(provider.credentialRef)
      : undefined;
  }

  async isAgentReady(id: string): Promise<boolean> {
    const agent = this.store.getAgent(id);
    if (!agent?.enabled || agent.deletedAt) {
      return false;
    }
    const provider = this.store.getProvider(agent.providerId);
    if (!provider || provider.status !== "active") {
      return false;
    }
    if (provider.protocol === "openai-compatible") {
      return Boolean(
        provider.baseUrl &&
        agent.model &&
        provider.credentialRef &&
        await this.secrets.has(provider.credentialRef),
      );
    }
    return provider.protocol === "codex-cli" || Boolean(agent.model);
  }

  async snapshot(): Promise<ModelRouterSnapshot> {
    const providers = await Promise.all(this.store.listProviders().map(async (provider) =>
      publicProvider(
        provider,
        Boolean(
          provider.requiresApiKey &&
          provider.credentialRef &&
          await this.secrets.has(provider.credentialRef),
        ),
      )));
    return {
      providers,
      agents: this.store.listAgents(),
      brands: this.store.listBrands(),
      catalog: {
        providers: PROVIDER_CATALOG.providers.filter(
          (entry) => entry.protocol === "openai-compatible",
        ),
      },
    };
  }

  async createProvider(input: CreateProviderInput): Promise<PublicProviderProfile> {
    const template = PROVIDER_CATALOG.providers.find(
      (entry) => entry.templateId === input.templateId,
    );
    if (!template || template.protocol !== "openai-compatible") {
      invalid("Provider 模板不存在或不能由用户添加。");
    }
    const isCustom = template.templateId === "custom";
    if (
      !isCustom &&
      (
        (input.slug.trim() && input.slug.trim() !== template.slug) ||
        (input.displayName.trim() && input.displayName.trim() !== template.displayName) ||
        (input.brandAssetId !== undefined && input.brandAssetId !== template.brandAssetId)
      )
    ) {
      invalid("内置 Provider 模板的名称、slug 与品牌不能自定义。");
    }
    const slug = normalizeSlug(isCustom ? input.slug : template.slug, "Provider slug");
    if (
      isCustom &&
      PROVIDER_CATALOG.providers.some(
        (entry) => entry.templateId !== "custom" && entry.slug === slug,
      )
    ) {
      invalid("自定义 Provider 不能占用内置供应商 slug。");
    }
    const displayName = normalizeName(
      isCustom ? input.displayName : template.displayName,
      "Provider 名称",
    );
    const brandAssetId = isCustom
      ? input.brandAssetId ?? template.brandAssetId
      : template.brandAssetId;
    if (!this.store.getBrand(brandAssetId)) {
      invalid("BrandAsset 不存在。");
    }
    const baseUrl = normalizeBaseUrl(
      input.baseUrl ?? template.baseUrl,
      template.protocol,
      input.active,
    );
    const apiKey = normalizeApiKey(input.apiKey);
    if (input.active && template.requiresApiKey && !apiKey) {
      invalid("启用远程 Provider 前必须保存 API Key。");
    }
    const deletedProvider = this.store.getProviderBySlug(slug);
    if (deletedProvider && deletedProvider.status !== "deleted") {
      conflict("Provider slug 已被使用。");
    }
    if (deletedProvider && deletedProvider.protocol !== template.protocol) {
      conflict("已删除 Provider 的协议与当前模板不兼容。");
    }
    const id = deletedProvider?.id ?? `provider-${randomUUID()}`;
    const credentialRef = `credential-${randomUUID()}`;
    if (apiKey) {
      await this.secrets.set(credentialRef, apiKey);
    }
    try {
      const providerInput = {
        id,
        slug,
        displayName,
        protocol: template.protocol,
        ...(baseUrl ? { baseUrl } : {}),
        requiresApiKey: template.requiresApiKey,
        credentialRef,
        brandAssetId,
        status: input.active ? "active" : "inactive",
        now: new Date().toISOString(),
      } as const;
      const provider = deletedProvider
        ? this.store.reviveProvider(providerInput)
        : this.store.createProvider(providerInput);
      return publicProvider(provider, Boolean(apiKey));
    } catch (error) {
      if (apiKey) {
        try {
          const deleted = await this.secrets.delete(credentialRef);
          if (!deleted) {
            compensationFailed("Keychain 没有删除刚写入的凭据。");
          }
        } catch {
          compensationFailed("Provider 保存失败，且系统 Keychain 未能恢复原凭据状态。");
        }
      }
      return publicConflict(error);
    }
  }

  async updateProvider(
    id: string,
    input: UpdateProviderInput,
  ): Promise<PublicProviderProfile> {
    const current = this.store.getProvider(id);
    if (!current || current.status === "deleted") {
      conflict("Provider 不存在或已删除。");
    }
    if (this.store.hasActiveRunForProvider(id)) {
      conflict("Provider 正被活动 Run 使用，不能重绑、停用或修改连接。");
    }
    const template = catalogTemplateForProvider(current);
    if (input.apiKey !== undefined && input.clearApiKey) {
      invalid("不能同时设置和清除 API Key。");
    }
    if (
      template &&
      template.templateId !== "custom" &&
      (
        input.displayName.trim() !== template?.displayName ||
        input.brandAssetId !== template?.brandAssetId
      )
    ) {
      invalid("内置 Provider 模板的名称与品牌不能修改。");
    }
    const displayName = normalizeName(input.displayName, "Provider 名称");
    const brandAssetId = normalizeSlug(input.brandAssetId, "BrandAsset ID");
    if (!this.store.getBrand(brandAssetId)) {
      invalid("BrandAsset 不存在。");
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl, current.protocol, input.active);
    const apiKey = normalizeApiKey(input.apiKey);
    if (
      input.active &&
      current.requiresApiKey &&
      !apiKey &&
      (input.clearApiKey || !current.credentialRef || !await this.secrets.has(current.credentialRef))
    ) {
      invalid("启用远程 Provider 前必须保存 API Key。");
    }
    const credentialRef = current.credentialRef;
    const changesSecret = Boolean(apiKey) || input.clearApiKey === true;
    const previousSecret = changesSecret && credentialRef
      ? await this.secrets.get(credentialRef)
      : undefined;
    if (apiKey && credentialRef) {
      await this.secrets.set(credentialRef, apiKey);
    } else if (input.clearApiKey && credentialRef) {
      const deleted = await this.secrets.delete(credentialRef);
      if (previousSecret && !deleted) {
        compensationFailed("系统 Keychain 未能删除 API Key，Provider 设置保持不变。");
      }
    }
    try {
      const provider = this.store.updateProvider({
        id,
        displayName,
        ...(baseUrl ? { baseUrl } : {}),
        brandAssetId,
        status: input.active ? "active" : "inactive",
        now: new Date().toISOString(),
      });
      return publicProvider(
        provider,
        Boolean(
          provider.credentialRef && await this.secrets.has(provider.credentialRef),
        ),
      );
    } catch (error) {
      if (changesSecret && credentialRef) {
        try {
          if (previousSecret) {
            await this.secrets.set(credentialRef, previousSecret);
          } else {
            const deleted = await this.secrets.delete(credentialRef);
            if (!deleted) {
              compensationFailed("Keychain 没有删除新写入的凭据。");
            }
          }
        } catch {
          compensationFailed("Provider 设置保存失败，且系统 Keychain 未能恢复原凭据状态。");
        }
      }
      return publicConflict(error);
    }
  }

  async removeProvider(id: string): Promise<PublicProviderProfile> {
    const current = this.store.getProvider(id);
    if (!current || current.status === "deleted") {
      conflict("Provider 不存在或已删除。");
    }
    if (this.store.hasActiveRunForProvider(id)) {
      conflict("Provider 正被活动 Run 使用，不能移除。");
    }
    if (isSystemProvider(current)) {
      conflict("Claude 与 Codex 系统 Provider 不能删除。");
    }
    const credentialRef = current.credentialRef;
    const previousSecret = credentialRef
      ? await this.secrets.get(credentialRef)
      : undefined;
    if (credentialRef && previousSecret !== undefined) {
      const deleted = await this.secrets.delete(credentialRef);
      if (!deleted) {
        compensationFailed("系统 Keychain 未能删除 API Key，Provider 保持不变。");
      }
    }
    try {
      const provider = this.store.softDeleteProvider(id, new Date().toISOString());
      return publicProvider(provider, false);
    } catch (error) {
      if (credentialRef && previousSecret !== undefined) {
        try {
          await this.secrets.set(credentialRef, previousSecret);
        } catch {
          compensationFailed("Provider 删除失败，且系统 Keychain 未能恢复原凭据状态。");
        }
      }
      throw error;
    }
  }

  createAgent(input: CreateAgentInput): AgentDefinition {
    const provider = this.store.getProvider(input.providerId);
    if (!provider || provider.status === "deleted") {
      conflict("Provider 不存在或已删除。");
    }
    if (input.enabled && provider.status !== "active") {
      invalid("启用 Agent 前必须先启用 Provider。");
    }
    const slug = normalizeSlug(input.slug, "Agent slug");
    const mentionAlias = normalizeMention(input.mentionAlias);
    const displayName = normalizeName(input.displayName, "Agent 名称");
    const model = normalizeModel(input.model, provider.protocol, input.enabled);
    const id = `agent-${randomUUID()}`;
    const actorId = `actor-${randomUUID()}`;
    try {
      return this.store.createAgent({
        id,
        actorId,
        actorSlug: actorId,
        providerId: provider.id,
        slug,
        displayName,
        shortName: safeShortName(displayName),
        model,
        mentionAlias,
        enabled: input.enabled,
        now: new Date().toISOString(),
      });
    } catch (error) {
      return publicConflict(error);
    }
  }

  updateAgent(id: string, input: UpdateAgentDefinitionInput): AgentDefinition {
    const current = this.store.getAgent(id);
    if (!current || current.deletedAt) {
      conflict("Agent 不存在或已删除。");
    }
    const lockedIdentity = lockedSystemAgentIdentity(current.actorId);
    if (
      lockedIdentity &&
      (
        input.displayName.trim() !== lockedIdentity.displayName ||
        normalizeMention(input.mentionAlias) !== lockedIdentity.mentionAlias
      )
    ) {
      invalid("Claude/Codex 系统 Agent 的名称与 @alias 不能修改。");
    }
    if (this.store.hasActiveRunForAgent(id)) {
      conflict("Agent 正被活动 Run 使用，不能重绑、停用或修改模型。");
    }
    const provider = this.store.getProvider(current.providerId);
    if (!provider || provider.status === "deleted") {
      conflict("Agent 对应 Provider 不存在或已删除。");
    }
    if (input.enabled && provider.status !== "active") {
      invalid("启用 Agent 前必须先启用 Provider。");
    }
    try {
      return this.store.updateAgent({
        id,
        displayName: normalizeName(input.displayName, "Agent 名称"),
        shortName: safeShortName(input.displayName),
        model: normalizeModel(input.model, provider.protocol, input.enabled),
        mentionAlias: normalizeMention(input.mentionAlias),
        enabled: input.enabled,
        now: new Date().toISOString(),
      });
    } catch (error) {
      return publicConflict(error);
    }
  }

  removeAgent(id: string): AgentDefinition {
    const current = this.store.getAgent(id);
    if (!current || current.deletedAt) {
      conflict("Agent 不存在或已删除。");
    }
    if (lockedSystemAgentIdentity(current.actorId)) {
      conflict("Claude/Codex 系统 Agent 不能删除。");
    }
    if (this.store.hasActiveRunForAgent(id)) {
      conflict("Agent 正被活动 Run 使用，不能移除。");
    }
    return this.store.softDeleteAgent(id, new Date().toISOString());
  }

  async testAgent(id: string): Promise<ModelRouterConnectionTest> {
    const agent = this.store.getAgent(id);
    if (!agent || agent.deletedAt) {
      conflict("Agent 不存在或已删除。");
    }
    const provider = this.store.getProvider(agent.providerId);
    if (!provider || provider.status !== "active" || !agent.enabled) {
      invalid("请先启用 Agent 与 Provider。");
    }
    if (!this.#tester || !await this.isAgentReady(id)) {
      invalid("请先完成模型、Provider 地址和 API Key 配置。");
    }
    const apiKey = provider.credentialRef
      ? await this.secrets.get(provider.credentialRef)
      : undefined;
    const startedAt = Date.now();
    await this.#tester(agent, provider, apiKey);
    return { ok: true, latencyMs: Date.now() - startedAt };
  }

  close(): void {
    this.store.close();
  }
}
