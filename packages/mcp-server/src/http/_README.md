# http - WebUI 本地协议层

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `app.ts` | 核心 | 组装内容/编排/圆桌/RuntimeBinding/Model Router REST 路由、ready 状态、安全中间件与脱敏异常处理 |
| `config.ts` | 配置 | 用 Zod 校验迁移重试、HTTP、双 lease、sweeper、空闲绑定和 Agent 清理预算 |
| `schemas.ts` | 边界 | 严格校验 path、query、圆桌名册/审查范围与作答、RuntimeBinding 动作、兼容完成复核与 Agent 设置，拒绝冲突模式和伪造 Actor 身份 |
| `responses.ts` | 契约 | 输出统一 JSON envelope 与安全错误 |
| `revision-stream.ts` | 实时 | 轮询 SQLite revision 广播 `council.changed`，并转发进程内 `agent.output` 草稿 SSE 与重连快照 |
