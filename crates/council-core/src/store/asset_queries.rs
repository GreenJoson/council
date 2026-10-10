//! @input 依赖：CouncilStore 的只读连接、v19 assets/asset_links 表与资产领域类型
//! @output 为 CouncilStore 增加 list_assets / get_asset 两个只读查询
//! @pos 桌面端资产库的只读入口：写入、入库校验与字节读取都只在 Node 侧，
//!      这里不读 storage_rel_path，返回的 DTO 与 Node 公开 Asset 同构
//!
//! ⚠️ 一旦本文件被更新，务必更新以上注释

use rusqlite::{OptionalExtension, Row, params};

use super::CouncilStore;
use crate::error::{CouncilError, CouncilResult};
use crate::types::{Asset, AssetKind, AssetLink, AssetLinkRole, AssetLinkTargetKind, AssetOrigin};

const ASSET_SELECT_COLUMNS: &str = "id, kind, mime, byte_size, sha256, width, height, \
     origin_delegation_id, origin_actor_id, prompt, created_at, deleted_at";

struct AssetRow {
    id: String,
    kind: String,
    mime: String,
    byte_size: i64,
    sha256: String,
    width: Option<i64>,
    height: Option<i64>,
    origin_delegation_id: Option<String>,
    origin_actor_id: Option<String>,
    prompt: Option<String>,
    created_at: String,
    deleted_at: Option<String>,
}

fn read_asset_row(row: &Row<'_>) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        mime: row.get(2)?,
        byte_size: row.get(3)?,
        sha256: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        origin_delegation_id: row.get(7)?,
        origin_actor_id: row.get(8)?,
        prompt: row.get(9)?,
        created_at: row.get(10)?,
        deleted_at: row.get(11)?,
    })
}

fn invalid(message: &str) -> CouncilError {
    CouncilError::InvalidData(message.into())
}

impl CouncilStore {
    /// 按项目列出未删除资产（新到旧），可按类型过滤；顺序贴合 idx_assets_project_kind。
    pub fn list_assets(
        &self,
        project_path: &str,
        kind: Option<AssetKind>,
    ) -> CouncilResult<Vec<Asset>> {
        let project_path = project_path.trim();
        if project_path.is_empty() {
            return Err(CouncilError::InvalidData("资产项目路径不能为空。".into()));
        }
        let mut sql = format!(
            "SELECT {ASSET_SELECT_COLUMNS} FROM assets WHERE project_path = ?1 AND deleted_at IS NULL"
        );
        let mut values: Vec<&str> = vec![project_path];
        if let Some(kind) = kind {
            values.push(kind.as_db());
            sql.push_str(" AND kind = ?2");
        }
        sql.push_str(" ORDER BY created_at DESC, id DESC");
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), read_asset_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|row| self.asset_from_row(row))
            .collect()
    }

    /// 按 id 取资产；与 Node 一致，已软删除视为不存在。
    pub fn get_asset(&self, id: &str) -> CouncilResult<Option<Asset>> {
        let row = self
            .connection
            .query_row(
                &format!(
                    "SELECT {ASSET_SELECT_COLUMNS} FROM assets WHERE id = ?1 AND deleted_at IS NULL"
                ),
                params![id],
                read_asset_row,
            )
            .optional()?;
        row.map(|row| self.asset_from_row(row)).transpose()
    }

    fn asset_from_row(&self, row: AssetRow) -> CouncilResult<Asset> {
        let kind = AssetKind::from_db(&row.kind).ok_or_else(|| invalid("资产类型无效。"))?;
        let links = self.asset_links(&row.id)?;
        Ok(Asset {
            id: row.id,
            kind,
            mime: row.mime,
            byte_size: row.byte_size,
            sha256: row.sha256,
            width: row.width,
            height: row.height,
            prompt: row.prompt,
            origin: AssetOrigin {
                delegation_id: row.origin_delegation_id,
                actor_id: row.origin_actor_id,
            },
            created_at: row.created_at,
            deleted_at: row.deleted_at,
            links,
        })
    }

    fn asset_links(&self, asset_id: &str) -> CouncilResult<Vec<AssetLink>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT target_kind, target_id, role, created_at FROM asset_links \
             WHERE asset_id = ?1 ORDER BY created_at ASC, target_kind, target_id, role",
        )?;
        let rows = statement
            .query_map(params![asset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(target_kind, target_id, role, created_at)| {
                Ok(AssetLink {
                    target_kind: AssetLinkTargetKind::from_db(&target_kind)
                        .ok_or_else(|| invalid("资产链接目标类型无效。"))?,
                    target_id,
                    role: AssetLinkRole::from_db(&role)
                        .ok_or_else(|| invalid("资产链接角色无效。"))?,
                    created_at,
                })
            })
            .collect()
    }
}
