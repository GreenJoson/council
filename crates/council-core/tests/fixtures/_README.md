# fixtures - Node schema 兼容性夹具

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `node-schema-v1.sql` | 历史结构 | 保留旧枚举作者 schema，供 Node 迁移器的向前迁移测试参考；不参与 Rust 当前结构验证 |
| `node-schema-v2.sql` | 当前结构 | 显式创建含 ActorIdentity、Alias、快照、历史会话/current 唯一索引和数据库实例身份的 Node 当前 schema，供 Rust Store 兼容性测试使用；不参与生产迁移 |
