/**
 * @input  依赖：CouncilDatabase（asset_links 写入）、消息正文
 * @output 导出：COUNCIL_ASSET_SCHEME、extractAssetReferences（正文里 council-asset:<id> 去重提取）、
 *         linkReferencedAssets（为消息等目标补 reference 链接）
 * @pos    人类在编辑器里引用资产库图片（`![说明](council-asset:<asset_id>)`）时，消息与资产之间的自动关联；
 *         HTTP 消息发布与 stdio MCP council_post_message 共用。资产不存在或跨项目只跳过，不让链接失败拖垮已发布的消息
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilDatabase } from "../database.js";
import { CouncilConflictError, CouncilNotFoundError } from "../errors.js";
import type { AssetLinkTargetKind } from "../types.js";

export const COUNCIL_ASSET_SCHEME = "council-asset:";

// 与 http/schemas.ts 的 assetIdSchema 同一形状；Markdown 里引用形如 ![说明](council-asset:asset_xxx)。
const ASSET_REFERENCE_PATTERN = /council-asset:(asset_[A-Za-z0-9-]+)/gu;

export function extractAssetReferences(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(ASSET_REFERENCE_PATTERN)) {
    ids.add(match[1]!);
  }
  return [...ids];
}

/** 返回实际挂上的资产 id；INSERT OR IGNORE 语义，重复发布同一引用不会累加。 */
export function linkReferencedAssets(
  database: CouncilDatabase,
  content: string,
  targetKind: AssetLinkTargetKind,
  targetId: string,
): string[] {
  const linked: string[] = [];
  for (const assetId of extractAssetReferences(content)) {
    try {
      database.addAssetLink(assetId, targetKind, targetId, "reference");
      linked.push(assetId);
    } catch (error) {
      if (error instanceof CouncilNotFoundError || error instanceof CouncilConflictError) continue;
      throw error;
    }
  }
  return linked;
}
