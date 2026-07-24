# tests - council-core 集成验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `compatibility.rs` | 集成 | 验证当前 Node schema、跨连接、分页、revision、版本镜像及旧/未来结构拒绝 |
| `fixtures/` | 测试结构 | 提供 Node 当前版本 schema 的显式 SQL fixture，不参与生产迁移 |
