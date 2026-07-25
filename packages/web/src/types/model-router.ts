/**
 * @input  依赖：Council 模型路由 REST 协议
 * @output 导出：ProviderProfile、AgentDefinition、BrandAsset、catalog 与写入命令
 * @pos    ModelRouterDialog、capabilities 与 OrchestrationRepository 共享的领域模型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type ProviderProtocol = "claude-cli" | "codex-cli" | "openai-compatible";
export type ProviderStatus = "active" | "inactive" | "deleted";

export interface BrandAsset {
  id: string;
  slug: string;
  displayName: string;
  glyphId: string;
  colorToken: string;
  sourceKind: "project-curated" | "user-custom";
  sourceLabel: string;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfile {
  id: string;
  slug: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  requiresApiKey: boolean;
  hasApiKey: boolean;
  brandAssetId: string;
  status: ProviderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinition {
  id: string;
  actorId: string;
  providerId: string;
  slug: string;
  displayName: string;
  model: string;
  mentionAlias: string;
  enabled: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCatalogEntry {
  templateId: string;
  slug: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  requiresApiKey: boolean;
  brandAssetId: string;
  modelCandidates: string[];
}

export interface ModelRouterSnapshot {
  providers: ProviderProfile[];
  agents: AgentDefinition[];
  brands: BrandAsset[];
  catalog: {
    providers: ProviderCatalogEntry[];
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
  providerId: string;
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

export interface UpdateAgentInput {
  agentId: string;
  displayName: string;
  model: string;
  mentionAlias: string;
  enabled: boolean;
}

export interface AgentConnectionTest {
  ok: true;
  latencyMs: number;
}
