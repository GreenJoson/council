# src - council-core 源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `lib.rs` | 入口 | 统一导出错误、存储和领域类型 |
| `error.rs` | 错误 | 定义可识别的存储错误 |
| `store.rs` | 核心 | 失败关闭地校验 Node canonical v19 schema（含 Agent 权限职责、隔离委派账本、RuntimeBinding、决策包与 v19 资产库 assets/asset_links），并读写共享 SQLite 内容数据；按项目只读任务查询 `list_tasks`/`get_task` |
| `store/asset_queries.rs` | 子模块 | 只读资产查询 `list_assets`（kind/target 过滤 + limit/offset，返回与 REST 同形的 `PaginatedAssets`）/`get_asset`（不含已删除、不读存储路径），写入只在 Node 侧 |
| `types.rs` | 类型 | 定义与 TypeScript 同构的序列化模型 |

人工验收策略在 Rust 写入边界和 SQLite 触发器共同约束；Rust 只验证 Node v19 结构，不能自行迁移。
