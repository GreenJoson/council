/**
 * @input  依赖：AssetRepository 契约、mock-assets 夹具与占位图生成
 * @output 导出：MockAssetRepository 与其构造参数类型
 * @pos    mock 模式的资产仓储：内存夹具、刷新即重置；同构模拟分页、kind/target 筛选、
 *         导入（按扩展名推断 kind、同路径视为同 sha256 返回既有资产、拒绝绝对路径与 ..）、
 *         挂接/解除挂接（主键去重）与软删除（之后不再出现在列表，URL 返回 undefined）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { AssetRepository } from "./asset-repository";
import {
  createMockAssetFixtures,
  mockPlaceholderImage,
  mockSha256,
  type MockAssetFixtures,
} from "./mock-assets";
import type {
  Asset,
  AssetKind,
  AssetLinkTarget,
  AssetListQuery,
  AssetPage,
} from "../../types/assets";

const MOCK_DELAY_MS = 60;

export interface MockAssetRepositoryOptions {
  pageSize: number;
  fixtures?: MockAssetFixtures;
}

/** 扩展名 → (kind, mime)；模拟服务端白名单，未列出的一律拒绝。 */
const IMPORT_TYPES: Record<string, { kind: AssetKind; mime: string }> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  svg: { kind: "image", mime: "image/svg+xml" },
  glb: { kind: "model3d", mime: "model/gltf-binary" },
  pdf: { kind: "document", mime: "application/pdf" },
};

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));
}

function sameLink(left: AssetLinkTarget, right: AssetLinkTarget): boolean {
  return left.targetKind === right.targetKind
    && left.targetId === right.targetId
    && left.role === right.role;
}

export class MockAssetRepository implements AssetRepository {
  readonly pageSize: number;
  readonly #assets: Asset[];
  readonly #images: Record<string, string>;
  #sequence = 0;

  constructor(options: MockAssetRepositoryOptions) {
    const fixtures = structuredClone(options.fixtures ?? createMockAssetFixtures());
    this.pageSize = options.pageSize;
    this.#assets = fixtures.assets;
    this.#images = fixtures.images;
  }

  async listAssets(query: AssetListQuery = {}): Promise<AssetPage> {
    await delay();
    const offset = query.offset ?? 0;
    const limit = query.limit ?? this.pageSize;
    const target = query.target;
    const matched = this.#assets
      .filter((asset) => !asset.deletedAt)
      .filter((asset) => !query.kind || asset.kind === query.kind)
      .filter((asset) => !target || asset.links.some((link) =>
        link.targetKind === target.targetKind && link.targetId === target.targetId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const items = matched.slice(offset, offset + limit).map((asset) => structuredClone(asset));
    return {
      items,
      total: matched.length,
      count: items.length,
      offset,
      hasMore: offset + items.length < matched.length,
    };
  }

  async getAsset(assetId: string): Promise<Asset> {
    await delay();
    return structuredClone(this.#require(assetId));
  }

  async importAsset(relativePath: string): Promise<Asset> {
    await delay();
    const path = relativePath.trim().replace(/\\/g, "/");
    if (!path) {
      throw new Error("请输入相对项目根目录的文件路径。");
    }
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
      throw new Error("只能导入项目目录内的文件，路径不能是绝对路径或包含 ..。");
    }
    const name = path.split("/").pop() ?? path;
    const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
    const type = IMPORT_TYPES[extension];
    if (!type) {
      throw new Error("不支持的文件类型；允许 png、jpg、webp、svg、glb、pdf。");
    }
    const sha256 = mockSha256(`import:${path}`);
    const existing = this.#assets.find((asset) => asset.sha256 === sha256 && !asset.deletedAt);
    if (existing) {
      return structuredClone(existing);
    }
    this.#sequence += 1;
    const id = `asset_mock_import_${String(this.#sequence)}`;
    const asset: Asset = {
      id,
      kind: type.kind,
      mime: type.mime,
      byteSize: 24_000 + path.length * 97,
      sha256,
      ...(type.kind === "image" ? { width: 480, height: 320 } : {}),
      origin: {},
      createdAt: new Date().toISOString(),
      links: [],
    };
    this.#assets.push(asset);
    if (type.kind === "image") {
      this.#images[id] = mockPlaceholderImage(name);
    }
    return structuredClone(asset);
  }

  async addLink(assetId: string, link: AssetLinkTarget): Promise<Asset> {
    await delay();
    const asset = this.#requireLive(assetId);
    if (!asset.links.some((candidate) => sameLink(candidate, link))) {
      asset.links.push({ ...link, createdAt: new Date().toISOString() });
    }
    return structuredClone(asset);
  }

  async removeLink(assetId: string, link: AssetLinkTarget): Promise<Asset> {
    await delay();
    const asset = this.#requireLive(assetId);
    asset.links = asset.links.filter((candidate) => !sameLink(candidate, link));
    return structuredClone(asset);
  }

  async deleteAsset(assetId: string): Promise<void> {
    await delay();
    this.#requireLive(assetId).deletedAt = new Date().toISOString();
  }

  thumbnailUrl(asset: Asset): string | undefined {
    return this.#imageOf(asset);
  }

  contentUrl(asset: Asset): string | undefined {
    return this.#imageOf(asset);
  }

  #imageOf(asset: Asset): string | undefined {
    const current = this.#assets.find((candidate) => candidate.id === asset.id);
    return current && !current.deletedAt ? this.#images[asset.id] : undefined;
  }

  #require(assetId: string): Asset {
    const asset = this.#assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      throw new Error("资产不存在或已被移除");
    }
    return asset;
  }

  #requireLive(assetId: string): Asset {
    const asset = this.#require(assetId);
    if (asset.deletedAt) {
      throw new Error("资产已删除");
    }
    return asset;
  }
}
