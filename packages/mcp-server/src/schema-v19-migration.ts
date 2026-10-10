/**
 * @input  依赖：canonical v18 数据库（actor_identities、work_item_delegations 已存在）
 * @output 导出：migrateVersionNineteen、ASSET_V19_SCHEMA_SQL 与 v18 迁移源验证
 * @pos    v18→v19 资产库：只新增 assets / asset_links 两张表、两个索引与内容 revision 触发器，不动旧表
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 外键删除动作：
 * - origin_delegation_id 用 ON DELETE SET NULL：委派会随议题/实施项级联删除，
 *   资产是独立产物，既不能阻塞删除，也不应跟着消失。
 * - origin_actor_id 与其它表一致不带动作：身份只停用不删除。
 * - asset_links.asset_id 用 ON DELETE CASCADE（契约约定）；target_* 是多态引用，不加外键。
 *
 * revision 触发器是对契约「只新增两表与索引」的补充（已回写契约「实现偏离」）：
 * HTTP 的 council.changed 由 content_revision 推进驱动，资产写入沿用这条通道。
 */
import type { DatabaseSync } from "node:sqlite";

interface ScalarRow {
  value: unknown;
}

function objectExists(database: DatabaseSync, name: string): boolean {
  const row = database.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) as unknown as ScalarRow;
  return Number(row.value) > 0;
}

export function assertVersionEighteenMigrationSource(database: DatabaseSync): void {
  if (!objectExists(database, "work_item_delegations") || !objectExists(database, "actor_identities")) {
    throw new Error("Council v18 数据库缺少资产外键依赖的表。");
  }
  if (objectExists(database, "assets") || objectExists(database, "asset_links")) {
    throw new Error("Council v18 数据库已存在资产表，迁移源与预期不符。");
  }
}

export const ASSET_V19_SCHEMA_SQL = `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'model3d', 'document', 'archive')),
    mime TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    sha256 TEXT NOT NULL,
    storage_rel_path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    origin_delegation_id TEXT REFERENCES work_item_delegations(id) ON DELETE SET NULL,
    origin_actor_id TEXT REFERENCES actor_identities(id),
    prompt TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (project_path, sha256)
  );
  CREATE INDEX idx_assets_project_kind ON assets(project_path, kind, created_at);
  CREATE TABLE asset_links (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('work_item', 'message', 'decision')),
    target_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('reference', 'output', 'final', 'brief')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (asset_id, target_kind, target_id, role)
  );
  CREATE INDEX idx_asset_links_target ON asset_links(target_kind, target_id);

  CREATE TRIGGER trg_assets_revision_insert
    AFTER INSERT ON assets BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_assets_revision_update
    AFTER UPDATE ON assets BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_assets_revision_delete
    AFTER DELETE ON assets BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_asset_links_revision_insert
    AFTER INSERT ON asset_links BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_asset_links_revision_delete
    AFTER DELETE ON asset_links BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
`;

export function migrateVersionNineteen(database: DatabaseSync, recordVersion = true): void {
  assertVersionEighteenMigrationSource(database);
  database.exec(ASSET_V19_SCHEMA_SQL);

  if (recordVersion) {
    database.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
      .run(19, "asset-library", new Date().toISOString());
    database.exec("PRAGMA user_version = 19;");
  }
}
