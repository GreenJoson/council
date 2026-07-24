# sqlite - 真实 Council SQLite 持久化适配器

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `schema.ts` | 结构契约 | 导出运行、批准、lease、单活动索引与 revision DDL，并用 canonical SQL 精确验证自身表/索引/触发器；生产环境不自行迁移 |
| `run-codec.ts` | 安全边界 | 严格解码快照，并兼容回填旧 V1 cleanup 协议字段 |
| `sqlite-council-store.ts` | 核心适配器 | 验证 Node 已迁移 schema，以事务、CAS、状态索引分页及 token/epoch fencing 实现 Store |
