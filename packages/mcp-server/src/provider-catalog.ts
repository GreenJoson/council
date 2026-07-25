/**
 * @input  依赖：打包 provider-catalog.json
 * @output 导出：严格校验的 Provider 模板与受控 BrandAsset 配置
 * @pos    供应商默认地址、品牌 glyph 与候选模型的唯一配置加载入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import catalogJson from "../resources/provider-catalog.json" with { type: "json" };

export type ProviderProtocol = "claude-cli" | "codex-cli" | "openai-compatible";
export type BrandSourceKind = "project-curated" | "user-custom";

export interface BrandCatalogEntry {
  id: string;
  slug: string;
  displayName: string;
  glyphId: string;
  colorToken: string;
  sourceKind: BrandSourceKind;
  sourceLabel: string;
}

export interface ProviderCatalogEntry {
  templateId: string;
  slug: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  requiresApiKey: boolean;
  brandAssetId: string;
  modelCandidates: readonly string[];
}

export interface ProviderCatalog {
  schemaVersion: 1;
  brands: readonly BrandCatalogEntry[];
  providers: readonly ProviderCatalogEntry[];
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const GLYPH_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const COLOR_TOKEN_PATTERN = /^brand-[a-z][a-z0-9-]{0,63}$/u;
const PROTOCOLS: readonly ProviderProtocol[] = [
  "claude-cli",
  "codex-cli",
  "openai-compatible",
];

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || !value || value.length > 200 || (pattern && !pattern.test(value))) {
    throw new Error(`${label} 无效。`);
  }
  return value;
}

function parseBrand(value: unknown): BrandCatalogEntry {
  const item = record(value, "BrandAsset");
  const sourceKind = text(item.sourceKind, "BrandAsset.sourceKind");
  if (sourceKind !== "project-curated" && sourceKind !== "user-custom") {
    throw new Error("BrandAsset.sourceKind 无效。");
  }
  return {
    id: text(item.id, "BrandAsset.id", SLUG_PATTERN),
    slug: text(item.slug, "BrandAsset.slug", SLUG_PATTERN),
    displayName: text(item.displayName, "BrandAsset.displayName"),
    glyphId: text(item.glyphId, "BrandAsset.glyphId", GLYPH_PATTERN),
    colorToken: text(item.colorToken, "BrandAsset.colorToken", COLOR_TOKEN_PATTERN),
    sourceKind,
    sourceLabel: text(item.sourceLabel, "BrandAsset.sourceLabel"),
  };
}

function parseProvider(value: unknown): ProviderCatalogEntry {
  const item = record(value, "Provider 模板");
  const protocol = text(item.protocol, "Provider.protocol");
  if (!PROTOCOLS.includes(protocol as ProviderProtocol)) {
    throw new Error("Provider.protocol 无效。");
  }
  const baseUrl = item.baseUrl;
  if (baseUrl !== null && typeof baseUrl !== "string") {
    throw new Error("Provider.baseUrl 无效。");
  }
  if (typeof item.requiresApiKey !== "boolean" || !Array.isArray(item.modelCandidates)) {
    throw new Error("Provider 模板字段无效。");
  }
  const modelCandidates = item.modelCandidates.map((candidate, index) =>
    text(candidate, `Provider.modelCandidates[${String(index)}]`));
  return {
    templateId: text(item.templateId, "Provider.templateId", SLUG_PATTERN),
    slug: text(item.slug, "Provider.slug", SLUG_PATTERN),
    displayName: text(item.displayName, "Provider.displayName"),
    protocol: protocol as ProviderProtocol,
    ...(typeof baseUrl === "string" && baseUrl ? { baseUrl } : {}),
    requiresApiKey: item.requiresApiKey,
    brandAssetId: text(item.brandAssetId, "Provider.brandAssetId", SLUG_PATTERN),
    modelCandidates,
  };
}

function parseCatalog(value: unknown): ProviderCatalog {
  const root = record(value, "Provider catalog");
  if (root.schemaVersion !== 1 || !Array.isArray(root.brands) || !Array.isArray(root.providers)) {
    throw new Error("Provider catalog 版本或结构无效。");
  }
  const brands = root.brands.map(parseBrand);
  const providers = root.providers.map(parseProvider);
  const brandIds = new Set(brands.map((brand) => brand.id));
  const unique = (values: readonly string[], label: string): void => {
    if (new Set(values.map((item) => item.toLocaleLowerCase("en-US"))).size !== values.length) {
      throw new Error(`${label} 存在重复项。`);
    }
  };
  unique(brands.map((brand) => brand.id), "BrandAsset.id");
  unique(brands.map((brand) => brand.slug), "BrandAsset.slug");
  unique(providers.map((provider) => provider.templateId), "Provider.templateId");
  unique(providers.map((provider) => provider.slug), "Provider.slug");
  if (providers.some((provider) => !brandIds.has(provider.brandAssetId))) {
    throw new Error("Provider 模板引用了未知 BrandAsset。");
  }
  return { schemaVersion: 1, brands, providers };
}

export const PROVIDER_CATALOG: ProviderCatalog = parseCatalog(catalogJson);
