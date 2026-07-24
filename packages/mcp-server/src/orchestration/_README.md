# orchestration - REST 编排产品接线

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `agent-progress-hub.ts` | 临时流 | 在内存中维护每个 Run 的有界公开草稿、单调 sequence 和 SSE 重连快照，不写 SQLite |
| `claude-agent-adapter.ts` | 适配 | 只调用纯 ClaudeRuntime，把公开上下文转为无 session 回复并转发文本增量，仅公开脱敏诊断 |
| `codex-agent-adapter.ts` | 适配 | 只调用纯 CodexRuntime，把公开上下文转为无 session 回复并转发公开 JSONL 消息，记录安全恢复分类 |
| `openai-compatible-agent-adapter.ts` | 适配 | 将公开上下文交给已配置的兼容 API，转发公开 `delta.content` 并仅公开脱敏原因 |
| `execution-manager.ts` | 执行 | 快速响应后执行 claim/drive/续租，并周期扫描活动运行和有界关闭 |
| `service.ts` | 聚合 | 固定浏览器身份/策略、允许单次覆盖完成复核、检查 Agent 可用性并组装生产依赖 |

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
远程 Agent 共用有界流式 Chat Completions 运行时，并以各自 adapter ID 支持
`@deepseek`、`@kimi`。

桌面默认在正式回复原子落库后自动完成运行。Composer 的 `@Agent` 调用也会显式关闭完成门；
只有手动调用请求显式设置 `confirmationBeforeCompletion=true` 时才进入 `before_completion`
人工复核，其他执行策略仍由服务端固定。

所有适配器把临时输出写入同一个 `AgentProgressHub`：键由
`runId/topicId/adapterId` 组成，完成后立即清理。正式回复仍只能经
`SQLiteCouncilStore.commitRound` 原子发布，因此浏览器断线、草稿丢失或进程退出不会制造
半条正式消息。
