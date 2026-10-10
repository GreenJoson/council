/**
 * @input  依赖：无（纯类型与常量）
 * @output 导出：资产 DTO（Asset/AssetLink/AssetOrigin）、kind/targetKind/role 常量与联合类型、
 *         资产列表查询与分页结果、挂接目标；council-brief v1 的 TS 类型（CouncilBrief 等）
 * @pos    P2 资产通道（/api/v1/assets 与 Tauri list_assets/get_asset）和任务 brief 在 Web 端的稳定领域模型；
 *         字段与 docs/council-v2-refactor-plan.md 的「P2 落地契约」一一对应，公开 DTO 不含任何路径
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

// ============================================================
// 资产 DTO
// ============================================================

export const ASSET_KINDS = ["image", "model3d", "document", "archive"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_LINK_TARGET_KINDS = ["work_item", "message", "decision"] as const;
export type AssetLinkTargetKind = (typeof ASSET_LINK_TARGET_KINDS)[number];

export const ASSET_LINK_ROLES = ["reference", "output", "final", "brief"] as const;
export type AssetLinkRole = (typeof ASSET_LINK_ROLES)[number];

/** 挂接的目标与角色；(assetId, targetKind, targetId, role) 是服务端主键。 */
export interface AssetLinkTarget {
  targetKind: AssetLinkTargetKind;
  targetId: string;
  role: AssetLinkRole;
}

export interface AssetLink extends AssetLinkTarget {
  createdAt: string;
}

export interface AssetOrigin {
  delegationId?: string;
  actorId?: string;
}

export interface Asset {
  id: string;
  kind: AssetKind;
  mime: string;
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
  /** 脱敏后的生成提示词，只有生成类资产才有。 */
  prompt?: string;
  origin: AssetOrigin;
  createdAt: string;
  /** 软删除时间；列表默认不含已删除资产。 */
  deletedAt?: string;
  links: AssetLink[];
}

/** 列表查询；项目路径由仓储实现持有，UI 不传。 */
export interface AssetListQuery {
  kind?: AssetKind;
  /** 只看挂在某个目标上的资产（任意 role）。 */
  target?: { targetKind: AssetLinkTargetKind; targetId: string };
  limit?: number;
  offset?: number;
}

export interface AssetPage {
  items: Asset[];
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
}

// ============================================================
// council-brief v1（服务端严格校验、拒绝未知字段；style 必填）
// ============================================================

export const COUNCIL_BRIEF_KINDS = [
  "app-mockup",
  "game-sprite",
  "game-tileset",
  "concept-sheet",
  "icon-set",
  "custom",
] as const;
export type CouncilBriefKind = (typeof COUNCIL_BRIEF_KINDS)[number];

export interface CouncilBriefDeliverable {
  id: string;
  description: string;
  /** 形如 1024x1024。 */
  size?: string;
  transparent?: boolean;
  count?: number;
}

export interface CouncilBriefStyle {
  palette?: string[];
  /** reference 资产 id。 */
  references?: string[];
  constraints?: string[];
}

export interface CouncilBrief {
  schemaVersion: 1;
  kind: CouncilBriefKind;
  goal: string;
  deliverables: CouncilBriefDeliverable[];
  style: CouncilBriefStyle;
  acceptance: string[];
  nextStage?: { kind: "prototype"; notes: string };
}
