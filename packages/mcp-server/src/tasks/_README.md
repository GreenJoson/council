# tasks - 任务领域

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `task-intake.ts` | 入口 | 两个任务入口：直接任务（校验标题/详情/项目路径/优先级/brief，image 任务的 brief 按 council-brief 协议严格校验，source=direct、无议题；kind=pipeline 一律 400，流水线只能经 `/api/v1/pipelines` 创建）与议题派生任务（复用议题实施项批量创建，source=topic） |
| `task-service.ts` | 用例 | 直接任务创建、按项目列表、详情（所属议题摘要 + 委派列表）、乐观更新（image 任务可同时写 brief）、`submitBrief`（只写 brief、保持状态）与委派启动；委派经 `TaskDelegationPort` 注入 |

## 职责

只承载任务的录入规则与用例编排。任务存储职责由 `database/work-item-repository.ts` 承担（schema v18
的 `work_items` 即任务表），本目录不直接写 SQL。

## 入口

- REST：`http/routes/task-routes.ts`（`/api/v1/tasks*`）；议题派生入口仍走 `POST /api/v1/topics/:topicId/work-items`。
- MCP：`mcp/tools/task-tools.ts`（`council_*_task`）；议题派生入口仍是 `council_add_work_items`。

## 依赖方向

`http/routes`、`mcp/tools` → `tasks/` → `database.ts`（`CouncilDatabase` 门面）。委派通过
`TaskDelegationPort` 注入：HTTP 侧接编排服务的委派管理器，stdio MCP 侧接
`mcp/task-delegation-forwarder.ts`。本目录不反向依赖 `orchestration/`，只引用其输入类型。

## 验证方式

`npm run check`；启动 `npm run start:http` 后用真实请求走通创建 → 列表 → 详情 → 更新 → 委派（含 400/404/409 失败路径），
并确认议题派生任务出现在同一项目的任务列表中。
