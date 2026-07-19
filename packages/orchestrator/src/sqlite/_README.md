# sqlite - 真实 Council SQLite 持久化适配器

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `schema.ts` | 迁移 | 追加运行、批准、lease、单活动索引与运行状态 revision 触发器 |
| `run-codec.ts` | 安全边界 | 严格解码快照，并兼容回填旧 V1 cleanup 协议字段 |
| `sqlite-council-store.ts` | 核心适配器 | 以事务、CAS、状态索引分页及 token/epoch fencing 实现 Store |
