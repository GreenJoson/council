/**
 * @input  依赖：共享数据库上下文、资产行映射与安全错误语义
 * @output 导出：AssetRepository —— 按 (project_path, sha256) 查重、新建/恢复资产行、读取公开 DTO 与内部存储记录、
 *         按项目/kind/链接目标/未引用（unlinked：不挂任何目标）分页列表（默认不含软删除）、未删除资产字节总量、链接增删（目标存在且同项目）、软删除；
 *         以及 AssetStorageRecord / NewAssetRecord / AssetListFilter 类型
 * @pos    assets / asset_links 两张表的唯一数据访问所有者；不碰文件系统，落盘与嗅探在 assets/ 领域完成。
 *         内容 revision 由 v19 触发器推进，这里不手动改 council_meta
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { CouncilConflictError, CouncilNotFoundError, CouncilValidationError } from "../errors.js";
import type { Asset, AssetKind, AssetLinkRole, AssetLinkTargetKind } from "../types.js";
import type { DatabaseContext } from "./context.js";
import { assetFromRow, type AssetLinkRow, type AssetRow } from "./rows.js";

/** 内部记录：带存储相对路径与项目锚点，只给 assets/ 领域读写文件用，不出协议边界。 */
export interface AssetStorageRecord {
  asset: Asset;
  projectPath: string;
  storageRelPath: string;
}

export interface NewAssetRecord {
  projectPath: string;
  kind: AssetKind;
  mime: string;
  byteSize: number;
  sha256: string;
  storageRelPath: string;
  width?: number;
  height?: number;
  delegationId?: string;
  actorId?: string;
  prompt?: string;
}

export interface AssetListFilter {
  projectPath: string;
  kind?: AssetKind;
  target?: { kind: AssetLinkTargetKind; id: string };
  /** 只看没有任何链接（任务/消息/决策）的资产；与 target 互斥时以 target 为准由调用方保证。 */
  unlinked?: boolean;
  includeDeleted?: boolean;
  limit: number;
  offset: number;
}

const ASSET_COLUMNS = `
  a.id, a.project_path, a.kind, a.mime, a.byte_size, a.sha256, a.storage_rel_path,
  a.width, a.height, a.origin_delegation_id, a.origin_actor_id, a.prompt, a.created_at, a.deleted_at
`;

interface ScalarRow {
  value: number | string | null;
}

export class AssetRepository {
  readonly #context: DatabaseContext;

  constructor(context: DatabaseContext) {
    this.#context = context;
  }

  #linksFor(assetIds: readonly string[]): Map<string, AssetLinkRow[]> {
    const grouped = new Map<string, AssetLinkRow[]>();
    if (assetIds.length === 0) {
      return grouped;
    }
    const placeholders = assetIds.map(() => "?").join(", ");
    const rows = this.#context.database.prepare(`
      SELECT asset_id, target_kind, target_id, role, created_at
      FROM asset_links
      WHERE asset_id IN (${placeholders})
      ORDER BY created_at ASC, target_kind, target_id, role
    `).all(...assetIds) as unknown as AssetLinkRow[];
    for (const row of rows) {
      const list = grouped.get(row.asset_id) ?? [];
      list.push(row);
      grouped.set(row.asset_id, list);
    }
    return grouped;
  }

  #row(assetId: string): AssetRow | undefined {
    return this.#context.database.prepare(`
      SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.id = ?
    `).get(assetId) as unknown as AssetRow | undefined;
  }

  #toRecord(row: AssetRow): AssetStorageRecord {
    return {
      asset: assetFromRow(row, this.#linksFor([row.id]).get(row.id) ?? []),
      projectPath: row.project_path,
      storageRelPath: row.storage_rel_path,
    };
  }

  /** 读取存储记录；默认软删除视为不存在（content/thumbnail 因此 404）。 */
  getRecord(assetId: string, options: { includeDeleted?: boolean } = {}): AssetStorageRecord {
    const row = this.#row(assetId);
    if (!row || (row.deleted_at !== null && !options.includeDeleted)) {
      throw new CouncilNotFoundError(`资产 ${assetId} 不存在。`);
    }
    return this.#toRecord(row);
  }

  get(assetId: string, options: { includeDeleted?: boolean } = {}): Asset {
    return this.getRecord(assetId, options).asset;
  }

  /** 同项目同内容只有一行（含已软删除的行），入库去重以此为准。 */
  findByContent(projectPath: string, sha256: string): AssetStorageRecord | undefined {
    const row = this.#context.database.prepare(`
      SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.project_path = ? AND a.sha256 = ?
    `).get(projectPath, sha256) as unknown as AssetRow | undefined;
    return row ? this.#toRecord(row) : undefined;
  }

  /** 未删除资产的字节总量；去重共享同一文件时会被重复计入，配额因此只会偏保守。 */
  totalActiveBytes(): number {
    const row = this.#context.database.prepare(`
      SELECT COALESCE(SUM(byte_size), 0) AS value FROM assets WHERE deleted_at IS NULL
    `).get() as unknown as ScalarRow;
    return Number(row.value);
  }

  #assertOrigin(record: NewAssetRecord): void {
    if (record.delegationId) {
      const exists = this.#context.database.prepare(`
        SELECT 1 AS value FROM work_item_delegations WHERE id = ?
      `).get(record.delegationId);
      if (!exists) {
        throw new CouncilValidationError(`委派 ${record.delegationId} 不存在，无法作为资产来源。`);
      }
    }
    if (record.actorId) {
      const exists = this.#context.database.prepare(`
        SELECT 1 AS value FROM actor_identities WHERE id = ?
      `).get(record.actorId);
      if (!exists) {
        throw new CouncilValidationError(`Actor ${record.actorId} 不存在，无法作为资产来源。`);
      }
    }
  }

  insert(record: NewAssetRecord): Asset {
    this.#assertOrigin(record);
    const id = `asset_${randomUUID()}`;
    this.#context.database.prepare(`
      INSERT INTO assets (
        id, project_path, kind, mime, byte_size, sha256, storage_rel_path,
        width, height, origin_delegation_id, origin_actor_id, prompt, created_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id,
      record.projectPath,
      record.kind,
      record.mime,
      record.byteSize,
      record.sha256,
      record.storageRelPath,
      record.width ?? null,
      record.height ?? null,
      record.delegationId ?? null,
      record.actorId ?? null,
      record.prompt ?? null,
      new Date().toISOString(),
    );
    return this.get(id);
  }

  /** 软删除后再次导入同内容：恢复原行而不是新建（UNIQUE(project_path, sha256) 也不允许新建）。 */
  restore(assetId: string): Asset {
    this.#context.database.prepare(`
      UPDATE assets SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL
    `).run(assetId);
    return this.get(assetId);
  }

  softDelete(assetId: string): void {
    const result = this.#context.database.prepare(`
      UPDATE assets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL
    `).run(new Date().toISOString(), assetId);
    if (result.changes === 0) {
      throw new CouncilNotFoundError(`资产 ${assetId} 不存在。`);
    }
  }

  list(filter: AssetListFilter): { items: Asset[]; total: number } {
    const where = ["a.project_path = ?"];
    const params: Array<string | number> = [filter.projectPath];
    if (!filter.includeDeleted) {
      where.push("a.deleted_at IS NULL");
    }
    if (filter.kind) {
      where.push("a.kind = ?");
      params.push(filter.kind);
    }
    if (filter.target) {
      where.push(`EXISTS (
        SELECT 1 FROM asset_links l
        WHERE l.asset_id = a.id AND l.target_kind = ? AND l.target_id = ?
      )`);
      params.push(filter.target.kind, filter.target.id);
    }
    if (filter.unlinked) {
      where.push("NOT EXISTS (SELECT 1 FROM asset_links l WHERE l.asset_id = a.id)");
    }
    const clause = where.join(" AND ");
    const total = this.#context.database.prepare(`
      SELECT COUNT(*) AS value FROM assets a WHERE ${clause}
    `).get(...params) as unknown as ScalarRow;
    const rows = this.#context.database.prepare(`
      SELECT ${ASSET_COLUMNS} FROM assets a
      WHERE ${clause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, filter.limit, filter.offset) as unknown as AssetRow[];
    const links = this.#linksFor(rows.map((row) => row.id));
    return {
      items: rows.map((row) => assetFromRow(row, links.get(row.id) ?? [])),
      total: Number(total.value),
    };
  }

  /**
   * 链接目标必须存在且属于同一项目：实施项看自身 project_path，消息/决策看所属议题；
   * 议题没有绑定项目时不做项目比对（旧议题可能没有 project_path）。
   */
  #targetProject(targetKind: AssetLinkTargetKind, targetId: string): string | null {
    const sql = {
      work_item: "SELECT project_path AS value FROM work_items WHERE id = ?",
      message: "SELECT t.project_path AS value FROM messages m JOIN topics t ON t.id = m.topic_id WHERE m.id = ?",
      decision: "SELECT t.project_path AS value FROM decisions d JOIN topics t ON t.id = d.topic_id WHERE d.id = ?",
    }[targetKind];
    const row = this.#context.database.prepare(sql).get(targetId) as unknown as ScalarRow | undefined;
    if (!row) {
      throw new CouncilNotFoundError(`链接目标 ${targetKind}:${targetId} 不存在。`);
    }
    return row.value === null ? null : String(row.value);
  }

  /** 幂等：同一 (asset, target, role) 已存在时直接返回资产。 */
  addLink(assetId: string, targetKind: AssetLinkTargetKind, targetId: string, role: AssetLinkRole): Asset {
    return this.#context.transaction(() => {
      const record = this.getRecord(assetId);
      const targetProject = this.#targetProject(targetKind, targetId);
      if (targetProject !== null && targetProject !== record.projectPath) {
        throw new CouncilConflictError("资产与链接目标不属于同一项目。");
      }
      this.#context.database.prepare(`
        INSERT OR IGNORE INTO asset_links (asset_id, target_kind, target_id, role, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(assetId, targetKind, targetId, role, new Date().toISOString());
      return this.get(assetId);
    });
  }

  removeLink(assetId: string, targetKind: AssetLinkTargetKind, targetId: string, role: AssetLinkRole): void {
    this.getRecord(assetId);
    const result = this.#context.database.prepare(`
      DELETE FROM asset_links WHERE asset_id = ? AND target_kind = ? AND target_id = ? AND role = ?
    `).run(assetId, targetKind, targetId, role);
    if (result.changes === 0) {
      throw new CouncilNotFoundError("资产链接不存在。");
    }
  }
}
