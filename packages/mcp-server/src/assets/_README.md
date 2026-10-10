# assets - 资产领域

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `asset-service.ts` | 用例门面 | 列表/详情/项目内导入/本机文件入库/链接增删/软删除/原图与缩略图读取；REST、stdio MCP 与图像委派共用 |
| `asset-ingest.ts` | 入库边界 | `ingestFile`（本机绝对路径）与 `importFromProject`（项目相对路径）：lstat 拒绝符号链接与非普通文件、嗅探 MIME、白名单、单文件/总配额、同项目同 sha256 去重（软删除则恢复） |
| `asset-sniff.ts` | 纯函数 | 文件头嗅探 PNG/JPEG/WebP/GIF/SVG/glb/PDF，纯 JS 解析位图宽高，MIME → kind |
| `asset-storage.ts` | 落盘 | 内容寻址布局 `<asset-root>/<sha 前 2 位>/<sha>.<ext>`、临时文件 + rename、缩略图缓存 `<asset-root>/thumbnails/<sha>.png`、配额检查 |
| `asset-preview.ts` | 只读出口 | content 原始字节；thumbnail 用外部命令（sips 兼容参数）生成 PNG 并缓存，SVG 返回原文，非图像返回空 |
| `asset-errors.ts` | 错误语义 | `AssetRejectedError` 带原因码，继承校验错误；资产路由按原因码映射 403/404/413/415/507 |

## 职责

资产字节的落盘、嗅探、配额与预览，以及资产用例编排。`assets` / `asset_links` 两张表的 SQL 由
`database/asset-repository.ts` 独占，本目录不写 SQL；公开 DTO `Asset` 不含任何路径，存储相对路径只在
仓储与本目录之间流转。根目录、配额、白名单、缩略图命令与超时全部来自 `config.ts` 的 `loadAssetConfig`。

## 入口与依赖方向

- REST：`http/routes/asset-routes.ts`（`/api/v1/assets*`）。
- MCP：`mcp/tools/asset-tools.ts`（`council_list_assets` / `council_get_asset` / `council_import_asset` / `council_attach_asset`）。
- 图像委派：编排侧构造 `AssetService` 后调用 `ingestFile({ projectPath, sourcePath, origin, prompt? })`。

`http/routes`、`mcp/tools`、`orchestration` → `assets/` → `database.ts`（`CouncilDatabase` 门面）、
`project-path*.ts`、`process-utils.ts`。本目录不反向依赖协议层与编排层。写入经 v19 触发器推进内容
revision，前端沿用 `council.changed` 刷新。

## 验证方式

`npm run check`；用临时 `COUNCIL_DATA_DIR` 启动 `npm run start:http`，在临时项目目录里放 PNG/SVG，走通
导入 → 列表/详情 → content（核对 Content-Type/Disposition/no-store/nosniff/SVG CSP）→ thumbnail → 链接增删 →
软删除后 content 404；失败路径覆盖符号链接、超单文件上限、超总配额、非白名单、伪扩展名、越界 relativePath 与重复导入 200。
