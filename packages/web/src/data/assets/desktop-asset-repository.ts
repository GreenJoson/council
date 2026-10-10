/**
 * @input  依赖：DesktopBridge 的设置/资产只读/本地 Agent 服务配置与健康命令、
 *         HttpAssetRepository（写操作与内容 URL）、离线指引 buildOfflineLimitation
 * @output 导出：DesktopAssetRepository、其桥接子接口与构造参数类型
 * @pos    桌面模式资产仓储：列表/详情走 Tauri list_assets/get_asset 直读 Rust core；
 *         导入、图片上传/本机图片入库、挂接、删除走本地 Agent 服务 HTTP，离线时抛诚实指引；
 *         缩略图/原文 URL 指向 sidecar，地址未知时返回 undefined，由 UI 显示占位而不是坏图
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DesktopBridge, DesktopSettings } from "../desktop-bridge";
import { buildOfflineLimitation } from "../desktop-orchestration-repository";
import { createApiUrl } from "../http-client";
import { readProjectPathConfig } from "../project-path";
import type { AssetRepository } from "./asset-repository";
import { HttpAssetRepository } from "./http-asset-repository";
import type {
  Asset,
  AssetLinkTarget,
  AssetListQuery,
  AssetPage,
} from "../../types/assets";

/** 仅暴露资产仓储需要的桥接命令，方便测试注入替身。 */
export type DesktopAssetBridge = Pick<
  DesktopBridge,
  | "getSettings"
  | "listAssets"
  | "getAsset"
  | "getOrchestrationConfig"
  | "checkOrchestrationService"
>;

export interface DesktopAssetRepositoryOptions {
  bridge: DesktopAssetBridge;
  pageSize: number;
  /** 本地服务可达时按 (服务地址, 当前项目路径) 构造 HTTP 实现；默认 HttpAssetRepository。 */
  createHttpDelegate?: (baseUrl: string, projectPath: string) => AssetRepository;
}

const PROJECT_SWITCHED = "项目已切换，旧资产结果已忽略";

export class DesktopAssetRepository implements AssetRepository {
  readonly pageSize: number;
  readonly #bridge: DesktopAssetBridge;
  readonly #createHttpDelegate: (baseUrl: string, projectPath: string) => AssetRepository;
  /** 服务地址来自 Rust 设置层且运行期不变；第一次读列表/详情时顺带取得，供同步 URL 使用。 */
  #baseUrl: string | undefined;

  constructor(options: DesktopAssetRepositoryOptions) {
    this.#bridge = options.bridge;
    this.pageSize = options.pageSize;
    this.#createHttpDelegate = options.createHttpDelegate
      ?? ((baseUrl, projectPath) => new HttpAssetRepository({
        baseUrl,
        projectPath,
        pageSize: options.pageSize,
      }));
  }

  async listAssets(query: AssetListQuery = {}): Promise<AssetPage> {
    await this.#ensureBaseUrl();
    return this.#readInCurrentProject((projectPath) => this.#bridge.listAssets({
      projectPath,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.target ? { target: `${query.target.targetKind}:${query.target.targetId}` } : {}),
      ...(query.unlinked ? { unlinked: true } : {}),
      limit: query.limit ?? this.pageSize,
      offset: query.offset ?? 0,
    }));
  }

  async getAsset(assetId: string): Promise<Asset> {
    await this.#ensureBaseUrl();
    const asset = await this.#bridge.getAsset(assetId);
    if (!asset) {
      throw new Error("资产不存在或已被移除");
    }
    return asset;
  }

  async importAsset(relativePath: string): Promise<Asset> {
    return (await this.#requireLive()).importAsset(relativePath);
  }

  async uploadImage(file: File): Promise<Asset> {
    return (await this.#requireLive()).uploadImage(file);
  }

  async ingestLocalFile(sourcePath: string): Promise<Asset> {
    return (await this.#requireLive()).ingestLocalFile(sourcePath);
  }

  async addLink(assetId: string, link: AssetLinkTarget): Promise<Asset> {
    return (await this.#requireLive()).addLink(assetId, link);
  }

  async removeLink(assetId: string, link: AssetLinkTarget): Promise<Asset> {
    return (await this.#requireLive()).removeLink(assetId, link);
  }

  async deleteAsset(assetId: string): Promise<void> {
    await (await this.#requireLive()).deleteAsset(assetId);
  }

  thumbnailUrl(asset: Asset): string | undefined {
    if (asset.kind !== "image" || !this.#baseUrl) {
      return undefined;
    }
    return createApiUrl(this.#baseUrl, `/api/v1/assets/${encodeURIComponent(asset.id)}/thumbnail`).toString();
  }

  contentUrl(asset: Asset): string | undefined {
    if (!this.#baseUrl) {
      return undefined;
    }
    return createApiUrl(this.#baseUrl, `/api/v1/assets/${encodeURIComponent(asset.id)}/content`).toString();
  }

  /** 拿不到地址不影响元数据读取：图片位显示占位，下次读取再试。 */
  async #ensureBaseUrl(): Promise<void> {
    if (this.#baseUrl !== undefined) {
      return;
    }
    try {
      this.#baseUrl = (await this.#bridge.getOrchestrationConfig()).baseUrl;
    } catch {
      this.#baseUrl = undefined;
    }
  }

  /** 与任务仓储同一套世代校验：读结果回来后当前项目已变就丢弃。 */
  async #readInCurrentProject<T>(read: (projectPath: string) => Promise<T>): Promise<T> {
    const projectPath = requireProjectPath(await this.#bridge.getSettings());
    const result = await read(projectPath);
    const after = await this.#bridge.getSettings();
    if (after.currentProjectPath !== projectPath) {
      throw new Error(PROJECT_SWITCHED);
    }
    return result;
  }

  /** 写操作必须在服务可达时执行；离线时抛出与编排面板一致的诚实指引。 */
  async #requireLive(): Promise<AssetRepository> {
    const projectPath = requireProjectPath(await this.#bridge.getSettings());
    let reachable = false;
    try {
      await this.#ensureBaseUrl();
      reachable = Boolean(this.#baseUrl) && (await this.#bridge.checkOrchestrationService()).reachable;
    } catch {
      reachable = false;
    }
    if (!reachable || !this.#baseUrl) {
      throw new Error(buildOfflineLimitation(this.#baseUrl));
    }
    return this.#createHttpDelegate(this.#baseUrl, projectPath);
  }
}

function requireProjectPath(settings: DesktopSettings): string {
  if (!settings.logLibrary || !settings.currentProjectPath) {
    throw new Error("请先设置日志库并选择项目目录");
  }
  return readProjectPathConfig(settings.currentProjectPath);
}
