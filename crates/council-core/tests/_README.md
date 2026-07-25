# tests - council-core 集成验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `compatibility.rs` | 跨语言集成 | 调用真实 Node 迁移器生成 fresh v5、v2→v5 与 v3→v5 数据库，验证 Rust 对动态身份、配置版本、分页、revision、版本镜像及旧/未来结构拒绝 |
| `fixtures/` | 历史结构 | 仅保留 Node v1/v2 历史 SQL 供迁移参考；当前 v5 由真实 Node 迁移器生成 |
