# http - WebUI 本地协议层

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `app.ts` | 核心 | 组装内容/编排/Model Router REST 路由、包含 schema 版本的 ready 状态、安全中间件与脱敏异常处理 |
| `config.ts` | 配置 | 用 Zod 校验 schema 迁移重试、HTTP、lease、sweeper、Agent 清理与关闭预算 |
| `schemas.ts` | 边界 | 严格校验 path、query、body、单次完成复核布尔值与 Agent 设置，拒绝浏览器伪造 Actor 身份和其余策略 |
| `responses.ts` | 契约 | 输出统一 JSON envelope 与安全错误 |
| `revision-stream.ts` | 实时 | 轮询 SQLite revision 广播 `council.changed`，并转发进程内 `agent.output` 草稿 SSE 与重连快照 |
