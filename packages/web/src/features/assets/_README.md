# assets - 资产库视图

> ⚠️ 一旦本文件夹有所变化，请更新本文件

## 文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `AssetsView.tsx` | 入口 | `#/assets` 与 `#/assets/<assetId>`：创建一次资产仓储，在网格、详情、导入对话框间共享；导航只写 `buildHash` 生成的 hash |
| `AssetGrid.tsx` | 列表 | kind 筛选、缩略图网格（卡片链接到详情）、上一页/下一页分页；页大小取仓储 `pageSize` |
| `AssetDetail.tsx` | 详情 | 预览（Lightbox 看原图）、元数据、挂接列表、设为/取消 final、两步确认删除；读取失败显示占位与返回链接 |
| `AssetImportDialog.tsx` | 写入 | 原生 dialog，只收相对项目根目录的路径；项目路径由仓储持有 |
| `AssetThumbnail.tsx` | 展示 | 资产网格、详情、任务产物区与图像委派 reference 候选共用的缩略图；无缩略图时按 kind 显示图标占位 |
| `use-assets.ts` | 状态 | 分页读取与单资产读取；revision 前进或手动 reload 时重读，写操作返回的最新资产就地合并 |
| `asset-labels.ts` | 常量 | kind / role / 挂接目标的中文标签（经 `t()` 翻译）、字节数格式化与 links 查询纯函数 |

## 职责

只负责资产的浏览、导入、挂接（final）与软删除的界面与交互；资产数据的读取、URL 拼装与协议解析全部在 `data/assets/`。任务详情的「产物」区与图像委派表单复用本目录的 `AssetThumbnail` 与 `asset-labels`，不复用视图组件。

## 入口与依赖方向

`app/WorkspaceMain → AssetsView → AssetGrid / AssetDetail / AssetImportDialog → use-assets → data/assets 仓储`。路由只用 `app/routes.ts` 的类型与 `buildHash`；Lightbox 复用 `components/`。图片地址由仓储给出（`${apiBase}/api/v1/assets/:id/thumbnail|content`），组件不拼 URL、不读 `import.meta.env`。

mock 模式下资产仓储状态是模块级内存单例：资产页与任务页各自创建的仓储实例共享同一份数据，所以在任务产物区设 final 后资产页立即可见；刷新浏览器后重置。

## 验证方式

- `npm run check --prefix packages/web`、`npx vitest run`（i18n 覆盖会检查本目录的 `t("…")` 字面量）。
- mock 模式（`.claude/launch.json` 的 council-web-mock）走查：网格与 kind 筛选、分页、详情预览与 Lightbox、设/取消 final、删除确认、导入成功与非法路径报错。
- http 模式需要服务端 `/api/v1/assets*` 已就绪；实现见 `data/assets/http-asset-repository.ts`。
