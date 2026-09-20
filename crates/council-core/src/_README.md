# src - council-core 源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `lib.rs` | 入口 | 统一导出错误、存储和领域类型 |
| `error.rs` | 错误 | 定义可识别的存储错误 |
| `store.rs` | 核心 | 失败关闭地校验 Node canonical v16 schema（含 Agent 权限职责、隔离委派账本、RuntimeBinding 与决策包），并读写共享 SQLite 内容数据 |
| `types.rs` | 类型 | 定义与 TypeScript 同构的序列化模型 |

人工验收策略在 Rust 写入边界和 SQLite 触发器共同约束；Rust 只验证 Node v16 结构，不能自行迁移。
