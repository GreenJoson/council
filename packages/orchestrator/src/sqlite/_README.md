# sqlite - 真实 Council SQLite 持久化适配器

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `schema.ts` | 结构契约 | 导出运行、批准、双 lease、RuntimeBinding、议题级请求账本、活动 session 唯一索引与 revision DDL，并验证 canonical schema |
| `run-codec.ts` | 安全边界 | 严格解码含 RuntimeBinding 冻结引用的 v4 运行快照，并兼容旧快照 |
| `runtime-binding-codec.ts` | 安全边界 | 严格解码逻辑绑定、公开游标、session 状态与关闭原因 |
| `runtime-binding-repository.ts` | 数据访问 | 仅为 open 议题在事务内实现绑定创建、双 lease fencing、session/游标原子清理、重启中断、关闭和空闲回收 |
| `runtime-invocation-context.ts` | 上下文 | 按“议题 + Agent + 请求”拒绝重复调用，并构建首轮全量或 session 增量公开上下文 |
| `atomic-round-commit.ts` | 原子提交 | 在单事务写入 Run、公开消息、逻辑请求账本、唯一 session/游标并释放 binding lease |
| `sqlite-council-store.ts` | 核心适配器 | 验证已迁移 schema，以事务和 CAS 聚合 Run、lease、上下文与原子提交模块 |
