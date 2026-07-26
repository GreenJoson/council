# src - 编排领域核心

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `constants.ts` | 协议 | 定义状态、公开作者、消息类型、失败原因和安全边界 |
| `types.ts` | 模型 | 定义计划、RuntimeBinding、双 lease、状态分页、运行快照和带 session 的 Agent 输入输出 |
| `ports.ts` | 边界 | 隔离消息传播、运行/绑定恢复查询、双 lease fencing 与 Agent 主动触发 |
| `errors.ts` | 错误 | 提供可判定的配置、状态、冲突、lease、超时和调用错误；适配器只能通过显式 `publicMessage` 公开脱敏原因 |
| `orchestrator.ts` | 核心 | 分离 begin/drive，统一 Run 与活动 RuntimeBinding 续租、session 恢复、cleanup 屏障、人工门、取消和恢复 |
| `index.ts` | 入口 | 汇总导出公开 API 及供 Node 单一迁移器消费的编排 schema 契约 |
| `cycle/` | 收敛协议 | 固定四段圆桌协议：纯状态机、立场/提问尾块解析、cycle 与阻塞提问的严格解码与 CAS 仓储 |
| `sqlite/` | 持久化 | 实现事务、CAS、单活动 run、RuntimeBinding、双 lease fencing 和稳定公开游标 |
