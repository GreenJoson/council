/**
 * @input  依赖：http-client 的 URL 构造/统一请求/错误类型、asset-api 严格解析器
 * @output 导出：HttpAssetRepository（/api/v1/assets 全量 REST 实现）与其构造参数类型
 * @pos    http 模式的资产仓储；桌面模式也用它承接写操作（每次按 sidecar 地址与当前项目路径构造）。
 *         缩略图与原文只生成 URL，由 <img src>/<a href> 直接加载，不经 fetch
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { parseApiEnvelope } from "../api-types";
import {
  CouncilApiError,
  createApiUrl,
  jsonRequest,
  requestApiData,
  type Fetcher,
} from "../http-client";
import { parseAsset, parseAssetPage } from "./asset-api";
import type { AssetRepository } from "./asset-repository";
import type {
  Asset,
  AssetLinkTarget,
  AssetListQuery,
  AssetPage,
} from "../../types/assets";

export interface HttpAssetRepositoryOptions {
  baseUrl: string;
  /** 绝对项目路径；列表与导入都绑定它，UI 不传。 */
  projectPath: string;
  pageSize: number;
  fetcher?: Fetcher;
}

export class HttpAssetRepository implements AssetRepository {
  readonly pageSize: number;
  readonly #baseUrl: string;
  readonly #projectPath: string;
  readonly #fetcher: Fetcher;

  constructor(options: HttpAssetRepositoryOptions) {
    const projectPath = options.projectPath.trim();
    if (!projectPath) {
      throw new Error("资产仓储必须绑定项目路径");
    }
    // 先构造一次以尽早暴露非法地址，而不是等第一次请求才失败。
    createApiUrl(options.baseUrl, "/api/v1/assets");
    this.#baseUrl = options.baseUrl;
    this.#projectPath = projectPath;
    this.pageSize = options.pageSize;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async listAssets(query: AssetListQuery = {}): Promise<AssetPage> {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/assets", {
        project: this.#projectPath,
        kind: query.kind,
        target: query.target ? `${query.target.targetKind}:${query.target.targetId}` : undefined,
        limit: query.limit ?? this.pageSize,
        offset: query.offset ?? 0,
      }),
      parseAssetPage,
    );
  }

  async getAsset(assetId: string): Promise<Asset> {
    return requestApiData(this.#fetcher, this.#assetUrl(assetId), parseAsset);
  }

  async importAsset(relativePath: string): Promise<Asset> {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/assets/import"),
      parseAsset,
      jsonRequest({ projectPath: this.#projectPath, relativePath }),
    );
  }

  async addLink(assetId: string, link: AssetLinkTarget): Promise<Asset> {
    await this.#send(this.#assetUrl(assetId, "/links"), jsonRequest({
      targetKind: link.targetKind,
      targetId: link.targetId,
      role: link.role,
    }));
    // 契约只约定 201，不约定响应体是资产还是链接；统一回读一次拿到最新 links。
    return this.getAsset(assetId);
  }

  async removeLink(assetId: string, link: AssetLinkTarget): Promise<Asset> {
    const suffix = `/links/${encodeURIComponent(link.targetKind)}/${encodeURIComponent(link.targetId)}/${encodeURIComponent(link.role)}`;
    await this.#send(this.#assetUrl(assetId, suffix), { method: "DELETE" });
    return this.getAsset(assetId);
  }

  async deleteAsset(assetId: string): Promise<void> {
    await this.#send(this.#assetUrl(assetId), { method: "DELETE" });
  }

  thumbnailUrl(asset: Asset): string | undefined {
    // 服务端只为图像生成缩略图（SVG 原样返回），其余 kind 必然 404，不必让浏览器白请求。
    return asset.kind === "image" ? this.#assetUrl(asset.id, "/thumbnail").toString() : undefined;
  }

  contentUrl(asset: Asset): string | undefined {
    return this.#assetUrl(asset.id, "/content").toString();
  }

  #assetUrl(assetId: string, suffix = ""): URL {
    return createApiUrl(this.#baseUrl, `/api/v1/assets/${encodeURIComponent(assetId)}${suffix}`);
  }

  /**
   * 204/201 可能没有响应体，requestApiData 要求 JSON 信封处理不了；这里只认 HTTP 状态，
   * 失败时尽量读出统一信封里的 message，读不出再给通用文案。
   */
  async #send(url: URL, init: RequestInit): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetcher(url, init);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "网络连接失败";
      throw new CouncilApiError(`无法连接 Council API：${detail}`, 0);
    }
    if (response.ok) {
      return;
    }
    let message = `Council API 请求失败（HTTP ${String(response.status)}）`;
    let code: number | undefined;
    try {
      const envelope = parseApiEnvelope(await response.json() as unknown);
      message = envelope.message || message;
      code = envelope.code;
    } catch {
      // 非 JSON 错误体：保留通用文案。
    }
    throw new CouncilApiError(message, response.status, code);
  }
}
