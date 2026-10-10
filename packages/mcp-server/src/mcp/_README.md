# mcp - council_* MCP 工具模块

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `tool-context.ts` | 契约 | 定义 `McpToolContext`：server、数据库、不可伪造的调用者身份、ClaudeClient 与 MCP 配置，由 `server.ts` 装配后传给各注册函数 |
| `tool-support.ts` | 共享件 | 议题/消息/决策/实施项的 Zod 字段与输出 schema（含任务/委派输出），`success`/`publicError`/`executeTool` 统一返回与脱敏错误，以及 Markdown 文本格式化函数 |
| `tools/topic-tools.ts` | 工具 | `council_create_topic`、`council_update_topic`、`council_close_topic`、`council_get_topic`、`council_list_topics` |
| `tools/message-tools.ts` | 工具 | `council_post_message`、`council_record_decision`（MCP 只能创建 proposed 决策） |
| `tools/work-item-tools.ts` | 工具 | `council_add_work_items`、`council_update_work_item`、`council_list_work_items`、`council_claim_work_item`、`council_submit_fixes` |
| `tools/task-tools.ts` | 工具 | `council_create_task`、`council_list_tasks`、`council_get_task`、`council_delegate_task`（kind=code/image，image 可省略 supervisor 并带 input_asset_ids；委派经本机 HTTP 服务执行）、`council_submit_brief`（image 任务提交 council-brief，stdio 直连数据库并走乐观版本） |
| `tools/asset-tools.ts` | 工具 | `council_list_assets`（可 `unlinked` 只看未引用）、`council_get_asset`、`council_import_asset`、`council_attach_asset`（stdio 直连数据库，输出不含路径，导入规则与 REST 共用 `assets/`） |
| `tools/pipeline-tools.ts` | 工具 | `council_start_pipeline`、`council_get_pipeline`（参数 snake_case；stdio 进程不持有驱动器，两者都经 loopback HTTP `/api/v1/pipelines` 转发，4xx 与 503 文案透传、其余 5xx 只给通用说明） |
| `tools/team-tools.ts` | 工具 | P4 Worker 团队：`council_dispatch_worker`、`council_list_workers`、`council_wait_worker`、`council_interrupt_worker`、`council_merge_worker`、`council_archive_worker`（参数 camelCase；Lead 注入进程按 `COUNCIL_TEAM_LEAD_DELEGATION_ID` 定位团队，taskId 可省略；list/wait 直接读本地库，写操作经 loopback HTTP `/api/v1/tasks/:taskId/team*` 转发，4xx 与 503 文案透传） |
| `task-delegation-forwarder.ts` | 适配 | stdio 进程没有委派执行器：委派列表直接读本地账本，启动委派转发到 loopback HTTP 服务的 `/api/v1/tasks/:id/delegations`，连接失败给出可执行提示，5xx 只返回通用文案 |
| `tools/claude-tools.ts` | 工具 | `council_check_claude`、`council_ask_claude`（可传递请求取消）、`council_reset_claude_session` |
| `tools/status-tools.ts` | 工具 | `council_get_status`，只返回计数不暴露本地路径 |

注册顺序由 `src/server.ts` 固定为 topic → message → work-item → task → asset → pipeline → claude → status → team；task 为 P1 新增、asset 为 P2 新增、pipeline 为 P3 新增、team 为 P4 追加在末尾，其余与拆分前 `tools/list` 的输出顺序一致。团队 Lead 注入的 MCP 进程（带 `COUNCIL_TEAM_LEAD_DELEGATION_ID`）只注册六个团队工具。
