# fixtures - Node schema 兼容性夹具

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `node-schema-v1.sql` | 测试结构 | 显式创建含数据库实例身份的 Node 当前 schema，供 Rust Store 兼容性测试使用；不参与生产迁移 |
