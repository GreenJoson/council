# tasks - Council Web 任务数据域

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `task-repository.ts` | 边界 | 定义任务列表/详情/创建/更新与按任务委派、取消、接续接口；不提供 subscribe，刷新由调用方驱动 |
| `task-api.ts` | 协议 | 复用 `parseApiWorkItem` + `mapWorkItem` 严格解析任务行、列表与任务详情，校验委派归属与议题摘要状态 |
| `http-task-repository.ts` | 真实 | 调用 `/api/v1/tasks` REST，PUT 可带 `brief`，委派可带 `kind`/`inputAssetIds`（图像委派不发 `supervisorAgentId`）；取消/接续复用 `/api/v1/work-item-delegations/:id/actions/*` |
| `desktop-task-repository.ts` | 桌面 | 读走 Tauri `list_tasks`/`get_task`，委派与写入委托本地 Agent 服务 HTTP；离线读降级、离线写抛诚实指引 |
| `mock-tasks.ts` | 示例 | 脱敏任务夹具：6 条直接任务、2 条议题实施项、1 条审核中与 1 条已通过委派 |
| `mock-task-repository.ts` | 原型 | 内存实现；排序、同项目标题去重、乐观版本、brief 校验与 code/image 委派约束（输入资产上限 8、代码委派需审核者）与服务端同语义 |
| `council-brief.ts` | 规则 | council-brief v1 的严格校验（未知字段一律拒绝），规则与上限 BRIEF_LIMITS 镜像服务端 brief-protocol；返回可翻译的问题列表；编辑器与 mock 仓储共用 |
| `create-task-repository.ts` | 配置 | 按 `VITE_COUNCIL_DATA_MODE` 选择实现，复用 `VITE_COUNCIL_API_URL`/`VITE_COUNCIL_PROJECT_PATH` |

刷新约定：任务写入递增 content revision，委派写入递增 orchestration revision；调用方监听内容快照与编排快照 `revision` 后重读，不新增 SSE 事件。服务端 `GET /api/v1/tasks/:id` 依赖编排服务，编排关闭时返回 503，http 模式的 `getTask` 会如实失败。
