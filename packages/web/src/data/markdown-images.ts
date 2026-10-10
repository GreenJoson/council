/**
 * @input  依赖：资产仓储入口 createAssetRepository、project-files 的本地链接判定与 API 地址解析、http-client 的 URL 构造
 * @output 导出：council-asset: 引用的识别/提取（isCouncilAssetReference、parseCouncilAssetId、extractCouncilAssetIds）、
 *         Markdown 图片地址解析 resolveMarkdownImageSrc（资产引用 → 资产缩略图/原文 URL；项目内相对路径 → 议题只读图片接口；
 *         http(s)/data 原样）与发布后把正文引用的资产挂到消息的 linkReferencedAssetsToMessage
 * @pos    MarkdownContent 的 <img src> 与 Composer 发布链路共用的一层；图片字节只经资产接口或议题图片接口出站，
 *         浏览器从不直接拿到本机路径；桌面模式人工发帖走 Rust 直写，服务端自动挂接不会触发，所以发布后由前端补挂
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { AssetRepository } from "./assets/asset-repository";
import { createAssetRepository } from "./assets/create-asset-repository";
import { createApiUrl } from "./http-client";
import { isProjectFileLink, resolveApiBaseUrl } from "./project-files";

/** 资产库资产在 Markdown 里的引用协议：`![说明](council-asset:asset_xxx)`，与服务端 asset-references.ts 一致。 */
export const COUNCIL_ASSET_SCHEME = "council-asset:";
// 资产 ID 形如 asset_<uuid>；mock 的 asset_mock_upload_N 带下划线，字符集必须含 _，否则引用解析不出、src 会被 urlTransform 清空。
const ASSET_REFERENCE = /^council-asset:(asset_[A-Za-z0-9_-]+)$/u;
const ASSET_REFERENCE_GLOBAL = /council-asset:(asset_[A-Za-z0-9_-]+)/gu;
/** 浏览器可直接加载、无需解析的图片地址。 */
const DIRECT_IMAGE_SRC = /^(?:https?:|data:)/iu;

export function isCouncilAssetReference(src: string): boolean {
  return ASSET_REFERENCE.test(src.trim());
}

export function parseCouncilAssetId(src: string): string | undefined {
  return ASSET_REFERENCE.exec(src.trim())?.[1];
}

/** 正文中出现的全部资产引用 ID，去重保序；发布后据此把资产挂到消息。 */
export function extractCouncilAssetIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(ASSET_REFERENCE_GLOBAL)) {
    ids.add(match[1]!);
  }
  return [...ids];
}

/** http(s)/data 地址不需要任何异步解析，UI 可同步渲染，避免闪一下占位。 */
export function isDirectImageSrc(src: string): boolean {
  return DIRECT_IMAGE_SRC.test(src.trim());
}

export interface MarkdownImageSource {
  src: string;
  /** 项目内相对路径所属议题；缺省时相对路径无法解析（例如本地文档预览）。 */
  topicId?: string;
  /** 相对路径的基准目录（相对项目根），来自文件预览的 Markdown。 */
  basePath?: string;
}

export interface ResolvedMarkdownImage {
  /** 缩略图地址；资产没有缩略图时与 full 相同。 */
  thumbnail: string;
  /** 放大查看使用的原图地址。 */
  full: string;
}

let assetRepository: AssetRepository | undefined;
let imageApiBaseUrl: Promise<string | undefined> | undefined;

function assets(): AssetRepository {
  assetRepository ??= createAssetRepository();
  return assetRepository;
}

/** 服务地址运行期不变，成功后缓存；失败不缓存，下一张图再试。 */
function resolveImageApiBaseUrl(): Promise<string | undefined> {
  imageApiBaseUrl ??= resolveApiBaseUrl().catch((error: unknown) => {
    imageApiBaseUrl = undefined;
    throw error;
  });
  return imageApiBaseUrl;
}

/** 有协议前缀（http:、data:、file: 等）的地址不是项目内相对路径。 */
function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/iu.test(value);
}

/**
 * 解析 Markdown 图片 src：
 * - `council-asset:<id>` → 读资产元数据后给出缩略图/原文 URL（mock 为 data URI）；
 * - 项目内相对路径且已知议题 → 议题只读图片接口（mock 或无服务地址时为 undefined，由 UI 显示占位）；
 * - 其余（http(s)、data）原样返回。
 * 资产不存在、服务不可达等错误交给调用方按加载失败处理。
 */
export async function resolveMarkdownImageSrc(source: MarkdownImageSource): Promise<ResolvedMarkdownImage | undefined> {
  const src = source.src.trim();
  if (!src) return undefined;
  if (isDirectImageSrc(src)) return { thumbnail: src, full: src };
  const assetId = parseCouncilAssetId(src);
  if (assetId) {
    const repository = assets();
    const asset = await repository.getAsset(assetId);
    const full = repository.contentUrl(asset);
    if (!full) return undefined;
    return { thumbnail: repository.thumbnailUrl(asset) ?? full, full };
  }
  if (!hasScheme(src) && isProjectFileLink(src)) {
    if (!source.topicId) return undefined;
    const baseUrl = await resolveImageApiBaseUrl();
    if (!baseUrl) return undefined;
    const url = createApiUrl(baseUrl, `/api/v1/topics/${encodeURIComponent(source.topicId)}/files/image`, {
      href: src,
      basePath: source.basePath,
    }).toString();
    return { thumbnail: url, full: url };
  }
  return undefined;
}

/**
 * 发布后把正文引用的资产挂到消息（role=reference）。挂接是幂等的：http 模式服务端已自动挂接，
 * 这里重复一次无副作用；桌面模式人工发帖直写 SQLite，只有这里会挂。单个资产失败不影响已发布的消息。
 */
export async function linkReferencedAssetsToMessage(content: string, messageId: string): Promise<void> {
  const ids = extractCouncilAssetIds(content);
  if (ids.length === 0) return;
  const repository = assets();
  await Promise.all(ids.map((assetId) => repository
    .addLink(assetId, { targetKind: "message", targetId: messageId, role: "reference" })
    .catch(() => undefined)));
}
