# assets - Council Web 资产数据域

> ⚠️ 一旦本文件夹有所变化，请更新本文件

## 文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `asset-repository.ts` | 边界 | 定义资产列表（kind/target/unlinked 查询）/详情/导入/挂接/解除挂接/软删除与同步的缩略图、原文 URL 接口；不提供 subscribe |
| `asset-api.ts` | 协议 | 严格解析 Asset DTO、可空资产（Tauri `get_asset`）与分页结果；未知 kind/role/targetKind 直接拒绝 |
| `http-asset-repository.ts` | 真实 | 调用 `/api/v1/assets` REST；201/204 空体由本地 `#send` 处理，挂接/解除后回读资产拿最新 links |
| `desktop-asset-repository.ts` | 桌面 | 列表/详情走 Tauri `list_assets`/`get_asset`；导入、挂接、删除委托本地 Agent 服务 HTTP，离线写抛诚实指引；图片 URL 指向 sidecar，地址未知时为 undefined |
| `mock-assets.ts` | 示例 | 脱敏夹具：3 张挂在「结算页空状态插画」任务上的 output（其一为 final）、1 张 reference、1 张未挂接的线框图、1 份 PDF；图像均为内联 SVG data URI |
| `mock-asset-repository.ts` | 原型 | 内存实现：分页、kind/target/unlinked 筛选、按扩展名导入、主键去重的挂接、软删除；刷新即重置 |
| `create-asset-repository.ts` | 配置 | 按 `VITE_COUNCIL_DATA_MODE` 选择实现；页大小取 `VITE_COUNCIL_ASSET_PAGE_SIZE`（留空 60，上限 100）；mock 返回模块级单例 |

## 职责

- 只负责 P2 资产通道的读写与 URL 生成，不承担 UI 状态；DTO 与 `docs/council-v2-refactor-plan.md`「P2 落地契约」一致，任何字段都不含路径。
- `<img src>` 只经 `thumbnailUrl`/`contentUrl` 取得，地址来自 `VITE_COUNCIL_API_URL`（http）或 Rust 设置层的 sidecar 地址（desktop），源码不写死。
- 资产写入推进内容 revision（`council.changed`），调用方按内容快照重读，不新增 SSE 事件。

## 入口与依赖方向

`features/assets`、`features/tasks` → `create-asset-repository.ts` → 三种实现 → `asset-api.ts` / `http-client.ts` / `desktop-bridge.ts`。`desktop-bridge.ts` 反向只依赖 `asset-api.ts` 的解析函数，不依赖仓储实现。

## 验证

- `npm run check --prefix packages/web`（类型）。
- mock 模式启动 `council-web-mock`，走 `#/assets` 网格、筛选、详情、Lightbox、设为 final、删除、导入。
- http/desktop 需后端 P2 资产路由与 Tauri 只读命令就绪后联调。
