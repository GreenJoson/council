# routes - HTTP 路由模块

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `context.ts` | 契约 | 定义路由模块共享的 `HttpRouteContext` 依赖包（配置、数据库、可选编排服务、项目文件预览），并提供 `parse` 校验、RuntimeBinding 脱敏与 Model Router 错误转译辅助 |
| `settings-routes.ts` | 路由 | 编排能力探测与 Provider/Agent 设置的 Model Router REST（增删改、模型列表、连接诊断） |
| `client-config-routes.ts` | 路由 | 客户端接入（P4 配置分发）：`GET /api/v1/settings/client-config` → `{clients}`；`POST /api/v1/settings/client-config/:client/actions/apply`（body `{force?}`，漂移未带 force 409）与 `.../actions/restore`，均返回该客户端状态；`client` ∈ claude/codex，未注入 `config.clientConfig` 时 503 |
| `topic-routes.ts` | 路由 | 议题列表/详情/创建/更正/关闭、项目文件只读预览、消息发布与决策记录/接受 |
| `work-item-routes.ts` | 路由 | 实施项创建/AI 生成/更新/认领、项目待处理、项目活动计数（`GET /api/v1/topics/:topicId/activity` → `{activeAgents, attention}`，按议题所在项目汇总）、运行审计与跨 Agent 任务委派（单项、批量、接续、取消） |
| `task-routes.ts` | 路由 | `/api/v1/tasks` 任务创建/按项目列表/详情（附所属议题摘要与委派）/乐观更新，以及不依赖议题的任务委派启动与列表；`PUT` 对 image 任务可带 `brief`（按 council-brief 校验）；委派接受 kind=code（supervisor 必填、inputAssetIds 可带 ≤8 张同项目图像；kind=prototype 任务也走 code）与 kind=image（supervisor 可省略取默认 Claude，inputAssetIds ≤8） |
| `asset-routes.ts` | 路由 | `/api/v1/assets` 资产列表（`kind`/`target`/`unlinked=true` 过滤）/详情/原始内容/缩略图/项目内导入/链接增删/软删除；内容响应固定 no-store/nosniff，SVG 加沙箱 CSP，入库拒绝按原因码映射 403/404/413/415/507 |
| `pipeline-routes.ts` | 路由 | `/api/v1/pipelines` 流水线创建（201 `{pipeline}`）/按项目列表/详情与人工推进（确认 brief、选终稿、恢复、取消，均返回 PipelineDetail）；actor 固定 human，编排服务未启用时 503 |
| `team-routes.ts` | 路由 | `/api/v1/tasks/:taskId/team` P4 Worker 团队：组队（202 `{team, leadDelegation}`）、读团队（无团队 404）、派发 Worker（202）、等待（`timeoutMs` ≤ 600000，客户端断开即停）、中断/合并/归档/聚焦、结束团队；合并冲突 409 `data: {files, hint}`；编排服务未启用时 503 |
| `orchestration-routes.ts` | 路由 | RuntimeBinding 列表/关闭/重开、编排运行创建/查询/启动/批准/取消/恢复、圆桌周期指标与开始/放弃/作答/提交修复 |

注册顺序由 `http/app.ts` 决定：settings → client-config → topic → work-item → task → asset → pipeline → team → orchestration（task 为 P1 新增、asset 为 P2 新增、pipeline 为 P3 新增、client-config 与 team 为 P4 新增，其余与拆分前的内联顺序一致）；`/api/v1/service/actions/stop`、`/api/v1/status`、`/api/v1/events`（SSE）、404 与错误中间件仍留在 `app.ts`。`orchestration` 为可选依赖，各路由对缺失的处理方式（503 文案或静默跳过）与拆分前逐字一致。
