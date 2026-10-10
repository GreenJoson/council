/**
 * @input  依赖：CouncilDatabase（assets / asset_links 唯一读写方）、AssetConfig、AssetStorage / AssetIngestor / AssetPreviewer
 * @output 导出：AssetService（list/get/importFromProject/ingestFile/addLink/removeLink/softDelete/content/thumbnail）与 ListAssetsInput
 * @pos    资产领域用例门面：REST、stdio MCP 与图像委派（C）共用；协议层只做参数适配与状态码映射。
 *         写入经仓储推进内容 revision（v19 触发器），沿用 council.changed，不新增 SSE 事件类型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilDatabase } from "../database.js";
import { normalizeProjectPath } from "../project-path.js";
import { CouncilValidationError } from "../errors.js";
import type {
  Asset,
  AssetConfig,
  AssetKind,
  AssetLinkRole,
  AssetLinkTargetKind,
  PaginatedAssets,
} from "../types.js";
import { AssetIngestor, type IngestFileInput, type IngestResult } from "./asset-ingest.js";
import { AssetPreviewer, type AssetPayload } from "./asset-preview.js";
import { AssetStorage } from "./asset-storage.js";

export interface ListAssetsInput {
  projectPath: string;
  kind?: AssetKind;
  target?: { kind: AssetLinkTargetKind; id: string };
  includeDeleted?: boolean;
  limit: number;
  offset: number;
}

export class AssetService {
  readonly #ingestor: AssetIngestor;
  readonly #previewer: AssetPreviewer;

  constructor(
    private readonly database: CouncilDatabase,
    config: AssetConfig,
  ) {
    const storage = new AssetStorage(config, database);
    this.#ingestor = new AssetIngestor(database, storage);
    this.#previewer = new AssetPreviewer(storage);
  }

  list(input: ListAssetsInput): PaginatedAssets {
    const projectPath = normalizeProjectPath(input.projectPath);
    if (!projectPath) {
      throw new CouncilValidationError("列出资产必须指定项目目录。");
    }
    const { items, total } = this.database.listAssets({ ...input, projectPath });
    return {
      items,
      total,
      count: items.length,
      offset: input.offset,
      hasMore: input.offset + items.length < total,
    };
  }

  get(assetId: string): Asset {
    return this.database.getAsset(assetId);
  }

  /** 图像委派（C）收集产物的入口：本机绝对路径入库并返回去重标志。 */
  ingestFile(input: IngestFileInput): Promise<IngestResult> {
    return this.#ingestor.ingestFile(input);
  }

  importFromProject(input: { projectPath: string; relativePath: string; actorId?: string }): Promise<IngestResult> {
    return this.#ingestor.importFromProject(input);
  }

  addLink(assetId: string, targetKind: AssetLinkTargetKind, targetId: string, role: AssetLinkRole): Asset {
    return this.database.addAssetLink(assetId, targetKind, targetId, role);
  }

  removeLink(assetId: string, targetKind: AssetLinkTargetKind, targetId: string, role: AssetLinkRole): void {
    this.database.removeAssetLink(assetId, targetKind, targetId, role);
  }

  /** 软删除只打标记，文件保留：同内容再次导入时可直接恢复；配额立即释放。 */
  softDelete(assetId: string): void {
    this.database.softDeleteAsset(assetId);
  }

  content(assetId: string): Promise<AssetPayload> {
    return this.#previewer.content(this.database.getAssetRecord(assetId));
  }

  thumbnail(assetId: string): Promise<AssetPayload | undefined> {
    return this.#previewer.thumbnail(this.database.getAssetRecord(assetId));
  }
}
