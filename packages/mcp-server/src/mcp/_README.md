# mcp - council_* MCP 工具模块

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `tool-context.ts` | 契约 | 定义 `McpToolContext`：server、数据库、不可伪造的调用者身份、ClaudeClient 与 MCP 配置，由 `server.ts` 装配后传给各注册函数 |
| `tool-support.ts` | 共享件 | 议题/消息/决策/实施项的 Zod 字段与输出 schema，`success`/`publicError`/`executeTool` 统一返回与脱敏错误，以及 Markdown 文本格式化函数 |
| `tools/topic-tools.ts` | 工具 | `council_create_topic`、`council_update_topic`、`council_close_topic`、`council_get_topic`、`council_list_topics` |
| `tools/message-tools.ts` | 工具 | `council_post_message`、`council_record_decision`（MCP 只能创建 proposed 决策） |
| `tools/work-item-tools.ts` | 工具 | `council_add_work_items`、`council_update_work_item`、`council_list_work_items`、`council_claim_work_item`、`council_submit_fixes` |
| `tools/claude-tools.ts` | 工具 | `council_check_claude`、`council_ask_claude`（可传递请求取消）、`council_reset_claude_session` |
| `tools/status-tools.ts` | 工具 | `council_get_status`，只返回计数不暴露本地路径 |

注册顺序由 `src/server.ts` 固定为 topic → message → work-item → claude → status，与拆分前 `tools/list` 的输出顺序一致。
