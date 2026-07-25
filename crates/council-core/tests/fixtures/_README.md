# fixtures - Node schema 兼容性夹具

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `node-schema-v1.sql` | 历史结构 | 保留旧枚举作者 schema，供 Node 迁移器的向前迁移测试参考；不参与 Rust 当前结构验证 |
| `node-schema-v2.sql` | 历史结构 | 保留拆分 Provider/Agent 前的 Node v2 schema，供未来迁移回归参考；不参与 Rust 当前结构验证 |

当前 v5 数据库不再维护手写 SQL 夹具。`compatibility.rs` 会调用
`packages/mcp-server/scripts/create-rust-test-database.mjs`，分别通过真实 Node 迁移器生成
fresh v5、v2→v5 与 v3→v5 数据库，再交给 Rust `CouncilStore::open` 验证。
