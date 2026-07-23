# orchestration - REST 编排产品接线

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `claude-agent-adapter.ts` | 适配 | 只调用纯 ClaudeRuntime，把公开上下文转为无 session 回复，并仅公开脱敏诊断 |
| `codex-agent-adapter.ts` | 适配 | 只调用纯 CodexRuntime，把公开上下文转为无 session 回复，并记录脱敏诊断、安全原因与恢复分类 |
| `openai-compatible-agent-adapter.ts` | 适配 | 将公开上下文交给已配置的兼容 API，并仅公开运行时定义的脱敏原因 |
| `execution-manager.ts` | 执行 | 快速响应后执行 claim/drive/续租，并周期扫描活动运行和有界关闭 |
| `service.ts` | 聚合 | 固定浏览器身份/策略、检查 Agent 可用性并组装生产依赖 |

生产工厂注册 `claude`、`codex`、`deepseek` 与 `kimi` 四个后台适配器。适配器不调用兼容层客户端，
因此不会提前写消息；回复只能由 `SQLiteCouncilStore.commitRound` 在 lease 和
运行版本校验通过后原子发布。V1 也不恢复任何 Agent session，避免把兼容层的
双写语义带入编排。

HTTP 请求断开不会取消后台执行。只有显式 cancel 会把运行改为 `cancelled` 并失效 lease；
其他进程的续租会在一个 heartbeat 内失败并中止 Agent。进程关闭使用统一总预算；
Agent 收到取消后还必须在独立 cleanup 期限内退出，超时不得自动重试。启动与周期 sweeper
直接按 Store 的 `running/waiting_agent` 状态索引完整分页：旧 lease 到期后自动接管，
`running` 继续，`waiting_agent` 标记为 `execution_interrupted`，`waiting_user` 不参与扫描。
候选数超过安全上限会明确阻止启动，不会静默漏恢复。

生产初始化会检查 Claude Code CLI 与 Codex CLI 的可用性和登录状态。不可用适配器在
capabilities 中标记 `available=false`，返回注册时提供的可执行提示（如 Codex 的
"运行 codex login"）或通用限制说明，并在创建运行时被拒绝；底层本机错误不会进入响应。
Claude/Codex 非零退出按认证、额度、模型权限、回合耗尽、暂时性服务故障和未知进程退出分类；
未知退出不公开内部原因。日志只记录脱敏诊断码、retryable 标志和同一份安全原因，不记录
prompt、项目路径或 CLI stderr。

Claude/Codex 每次调用从 `AgentSettingsService` 读取当前模型。远程 Provider 只有在模型、
HTTPS/loopback Base URL、Keychain API Key 与启用状态同时有效时才进入 capabilities；两个
远程 Agent 共用有界 Chat Completions 运行时，并以各自 adapter ID 支持 `@deepseek`、`@kimi`。
