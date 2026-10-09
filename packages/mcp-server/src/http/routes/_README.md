# routes - HTTP 路由模块

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `context.ts` | 契约 | 定义路由模块共享的 `HttpRouteContext` 依赖包（配置、数据库、可选编排服务、项目文件预览），并提供 `parse` 校验、RuntimeBinding 脱敏与 Model Router 错误转译辅助 |
| `settings-routes.ts` | 路由 | 编排能力探测与 Provider/Agent 设置的 Model Router REST（增删改、模型列表、连接诊断） |
| `topic-routes.ts` | 路由 | 议题列表/详情/创建/更正/关闭、项目文件只读预览、消息发布与决策记录/接受 |
| `work-item-routes.ts` | 路由 | 实施项创建/AI 生成/更新/认领、项目待处理、运行审计与跨 Agent 任务委派（单项、批量、接续、取消） |
| `task-routes.ts` | 路由 | `/api/v1/tasks` 任务创建/按项目列表/详情（附所属议题摘要与委派）/乐观更新，以及不依赖议题的任务委派启动与列表；P1 只接受 kind=code、inputAssetIds 为空 |
| `orchestration-routes.ts` | 路由 | RuntimeBinding 列表/关闭/重开、编排运行创建/查询/启动/批准/取消/恢复、圆桌周期指标与开始/放弃/作答/提交修复 |

注册顺序由 `http/app.ts` 决定：settings → topic → work-item → task → orchestration（task 为 P1 新增，其余与拆分前的内联顺序一致）；`/api/v1/service/actions/stop`、`/api/v1/status`、`/api/v1/events`（SSE）、404 与错误中间件仍留在 `app.ts`。`orchestration` 为可选依赖，各路由对缺失的处理方式（503 文案或静默跳过）与拆分前逐字一致。
