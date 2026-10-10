/**
 * @input  依赖：types/assets 的 DTO 与枚举常量
 * @output 导出：parseAsset、parseOptionalAsset（Tauri get_asset 可空）、parseAssetPage（分页对象或裸数组都接受）
 * @pos    资产领域唯一协议校验入口；REST 与 Tauri 返回的未知 JSON 都先经这里再进入 UI。
 *         未知 kind/role/targetKind 直接拒绝，避免 UI 静默渲染不认识的数据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  ASSET_KINDS,
  ASSET_LINK_ROLES,
  ASSET_LINK_TARGET_KINDS,
  type Asset,
  type AssetLink,
  type AssetOrigin,
  type AssetPage,
} from "../../types/assets";

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} 必须是非空字符串`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${path}.${key} 必须是字符串`);
  }
  return value || undefined;
}

function readCount(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path}.${key} 必须是非负整数`);
  }
  return value;
}

function readOptionalCount(record: Record<string, unknown>, key: string, path: string): number | undefined {
  return record[key] === undefined || record[key] === null ? undefined : readCount(record, key, path);
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T {
  const value = readString(record, key, path);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${path}.${key} 包含不支持的值`);
  }
  return value as T;
}

function parseLink(value: unknown, path: string): AssetLink {
  const record = readRecord(value, path);
  return {
    targetKind: readEnum(record, "targetKind", ASSET_LINK_TARGET_KINDS, path),
    targetId: readString(record, "targetId", path),
    role: readEnum(record, "role", ASSET_LINK_ROLES, path),
    createdAt: readString(record, "createdAt", path),
  };
}

function parseOrigin(value: unknown): AssetOrigin {
  if (value === undefined || value === null) {
    return {};
  }
  const record = readRecord(value, "asset.origin");
  const delegationId = readOptionalString(record, "delegationId", "asset.origin");
  const actorId = readOptionalString(record, "actorId", "asset.origin");
  return {
    ...(delegationId ? { delegationId } : {}),
    ...(actorId ? { actorId } : {}),
  };
}

export function parseAsset(value: unknown): Asset {
  const record = readRecord(value, "asset");
  const links = record.links ?? [];
  if (!Array.isArray(links)) {
    throw new Error("asset.links 必须是数组");
  }
  const width = readOptionalCount(record, "width", "asset");
  const height = readOptionalCount(record, "height", "asset");
  const prompt = readOptionalString(record, "prompt", "asset");
  const deletedAt = readOptionalString(record, "deletedAt", "asset");
  return {
    id: readString(record, "id", "asset"),
    kind: readEnum(record, "kind", ASSET_KINDS, "asset"),
    mime: readString(record, "mime", "asset"),
    byteSize: readCount(record, "byteSize", "asset"),
    sha256: readString(record, "sha256", "asset"),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(prompt ? { prompt } : {}),
    origin: parseOrigin(record.origin),
    createdAt: readString(record, "createdAt", "asset"),
    ...(deletedAt ? { deletedAt } : {}),
    links: links.map((link, index) => parseLink(link, `asset.links[${index}]`)),
  };
}

/** Tauri get_asset 对不存在的资产返回 null。 */
export function parseOptionalAsset(value: unknown): Asset | null {
  return value === null ? null : parseAsset(value);
}

/**
 * REST 返回分页对象；Tauri list_assets 的返回形状在契约里未冻结，裸数组也接受，
 * 此时把数组本身当成完整的一页（hasMore=false）。
 */
export function parseAssetPage(value: unknown): AssetPage {
  if (Array.isArray(value)) {
    const items = value.map(parseAsset);
    return { items, total: items.length, count: items.length, offset: 0, hasMore: false };
  }
  const record = readRecord(value, "assets");
  if (!Array.isArray(record.items)) {
    throw new Error("assets.items 必须是数组");
  }
  const items = record.items.map(parseAsset);
  return {
    items,
    total: readCount(record, "total", "assets"),
    count: record.count === undefined ? items.length : readCount(record, "count", "assets"),
    offset: record.offset === undefined ? 0 : readCount(record, "offset", "assets"),
    hasMore: typeof record.hasMore === "boolean" ? record.hasMore : false,
  };
}
