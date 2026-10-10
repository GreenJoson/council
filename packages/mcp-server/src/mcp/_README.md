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
| `tools/asset-tools.ts` | 工具 | `council_list_assets`、`council_get_asset`、`council_import_asset`、`council_attach_asset`（stdio 直连数据库，输出不含路径，导入规则与 REST 共用 `assets/`） |
| `task-delegation-forwarder.ts` | 适配 | stdio 进程没有委派执行器：委派列表直接读本地账本，启动委派转发到 loopback HTTP 服务的 `/api/v1/tasks/:id/delegations`，连接失败给出可执行提示，5xx 只返回通用文案 |
| `tools/claude-tools.ts` | 工具 | `council_check_claude`、`council_ask_claude`（可传递请求取消）、`council_reset_claude_session` |
| `tools/status-tools.ts` | 工具 | `council_get_status`，只返回计数不暴露本地路径 |

注册顺序由 `src/server.ts` 固定为 topic → message → work-item → task → asset → claude → status；task 为 P1 新增、asset 为 P2 新增，其余与拆分前 `tools/list` 的输出顺序一致。
