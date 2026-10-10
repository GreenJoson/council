# http - WebUI 本地协议层

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `app.ts` | 核心 | 组装安全中间件、ready 状态、`routes/` 各域路由（settings → topic → work-item → task → orchestration）、服务停止、状态、SSE 事件流、404 与脱敏异常处理 |
| `routes/` | 路由模块 | Model Router 设置、议题与文件预览、实施项/审计/委派、任务（可无议题）、RuntimeBinding/运行/圆桌周期五组 REST，共享 `HttpRouteContext` 依赖包 |
| `config.ts` | 配置 | 用 Zod 校验迁移重试、HTTP、双 lease、sweeper、空闲绑定和 Agent 清理预算 |
| `schemas.ts` | 边界 | 严格校验 path、query、圆桌名册/审查范围与作答、RuntimeBinding 动作、兼容完成复核、委派完成策略/验收标准、审计游标、恢复版本、任务创建/列表过滤/委派与 Agent 设置，拒绝冲突模式和伪造 Actor 身份 |
| `responses.ts` | 契约 | 输出统一 JSON envelope 与安全错误 |
| `revision-stream.ts` | 实时 | 轮询 SQLite revision 广播 `council.changed`，并转发进程内 `agent.output` 草稿 SSE 与重连快照 |

接续请求可携带 `requestedPermission`；缺省沿用原委派，非法权限与未知字段被拒绝。
