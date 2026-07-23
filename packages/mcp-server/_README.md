# mcp-server - 本地架构讨论 MCP 服务

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 核心 | 锁定 MCP/HTTP 依赖、已修复的传递依赖覆盖与构建、测试、双入口命令 |
| `package-lock.json` | 锁定 | 固化依赖解析结果 |
| `tsconfig.json` | 配置 | 启用严格 TypeScript 编译 |
| `.env.example` | 配置 | 列出全部可配置运行参数 |
| `src/` | 核心 | MCP、HTTP、数据库、模型设置与本机/远程 Agent 适配器源码 |
| `test/` | 验证 | 数据库、适配器、MCP 协议和 HTTP/SSE 集成测试 |

## Claude 运行边界

`ClaudeRuntime` 只接收已经整理为可公开共享的 prompt、项目目录、可选 model/session
与 `AbortSignal`，只负责调用 Claude Code CLI 并返回内容和会话标识。它不导入、读取或
写入 `CouncilDatabase`；未来编排器可以直接复用这条纯生成边界。

兼容层 `ClaudeClient.ask` 继续负责从数据库读取公开讨论和已存 session，调用运行时，
并且只在生成完整成功且请求未取消后写回 session 与消息。取消、超时和输出超限统一
先发送 `SIGTERM`，等待 `COUNCIL_CLAUDE_KILL_GRACE_MS` 后按需升级 `SIGKILL`，并等待
有界的子进程关闭与进程消失窗口；继承管道阻塞关闭时会主动销毁本端 stdio。
`council_ask_claude` 会把 MCP 请求的取消信号传到这条链路。

POSIX 平台会建立并终止独立进程组，以清理 CLI 的同组派生进程；主动建立新 session
并脱离该进程组的后代无法由普通 Node 父进程可靠回收，但不会再无限占住运行时管道。
Windows 平台仅保证直接子进程完成终止，派生进程仍受系统进程模型限制。运行配置强制
使用 `plan` 权限模式；额外 CLI 参数不能覆盖输出、会话、模型、轮次和权限参数，超时
与 kill grace 也不能超过 Node.js 定时器上限。

当前 `ClaudeClient` 的 session 保存与消息保存仍是两个数据库操作，不具备跨操作原子性。
编排 V1 不应复用此兼容层的 session 写回；该原子化改造应在数据库主线统一完成。

## HTTP 开发入口

复制 `.env.example` 为不提交的 `.env`，按本机环境填写全部配置后运行：

```bash
npm run dev:http
```

开发与生产 HTTP 命令都会通过 Node 的 env-file 支持读取包目录下的 `.env`；已由
父进程注入的环境变量优先。生产构建后可运行 `npm run start:http`。HTTP 服务只接受
loopback `COUNCIL_HTTP_HOST`，CORS 只接受显式白名单中的 exact origin。

## REST 与事件契约

| 方法 | 路径 | `data` |
|---|---|---|
| `GET` | `/api/v1/status` | 数量与当前 revision |
| `GET` | `/api/v1/topics` | `PaginatedTopics` |
| `GET` | `/api/v1/topics/:topicId` | `TopicDetail` |
| `POST` | `/api/v1/topics` | 新建 `Topic` |
| `POST` | `/api/v1/topics/:topicId/messages` | 新建 `CouncilMessage` |
| `POST` | `/api/v1/topics/:topicId/decisions` | 新建 `Decision` |
| `GET` | `/api/v1/orchestration/capabilities` | Agent 可用性与默认公开策略 |
| `GET` | `/api/v1/settings/agents` | 不含密钥的模型与 Provider 设置 |
| `PUT` | `/api/v1/settings/agents/:agentId` | 更新模型、地址、启用状态和 Keychain 凭据 |
| `POST` | `/api/v1/settings/agents/:agentId/actions/test` | 有界连接测试 |
| `GET/POST` | `/api/v1/topics/:topicId/runs` | 编排运行分页 / 创建运行（`201`） |
| `GET` | `/api/v1/runs/:runId` | 单个运行 |
| `POST` | `/api/v1/runs/:runId/actions/start` | 启动后台执行（`202`） |
| `POST` | `/api/v1/runs/:runId/actions/cancel` | 同步持久化取消（`200`） |
| `POST` | `/api/v1/runs/:runId/actions/recover` | 显式后台恢复（`202`） |
| `POST` | `/api/v1/runs/:runId/approvals` | 首次应用 `202`，幂等重放 `200` |
| `GET` | `/api/v1/events` | `council.changed` SSE，载荷 `{revision}` |

REST 成功统一为 `{code: 0, message, data, timestamp}`；错误使用对应 HTTP 状态码，
响应为 `{code, message, data?, timestamp}`。字段全部使用 canonical camelCase。
普通 Web 写入固定派生为 `human`，请求体不能提交 `createdBy`、`author`、`approvedBy`、
`publicAuthor` 或 `allowedAgents`。Agent 消息只经过受 lease/CAS 保护的编排提交或 MCP 边界。

`status.revision` 保持兼容的全局总版本，同时增加 `revisions.content` 与
`revisions.orchestration`。内容表只推进 content，总运行表只推进 orchestration；lease
claim/renew/release 不推进任何 revision，避免心跳制造 SSE 风暴。

SQLite trigger 维护全库单调 revision，HTTP 进程按配置轮询。因此另一个 MCP 进程
写入同一数据库时也会产生事件，不依赖进程内 emitter。

事件重连等待由 `COUNCIL_HTTP_EVENT_RETRY_MS` 独立控制。`Last-Event-ID` 等于当前
revision 时不会重复通知；落后或超前时发送当前 revision，让客户端全量校准。HTTP
入口拒绝非 loopback 的监听 host；SSE 的可选 `projectPath` 只用于输入边界校验，
revision 通知仍是全库级，客户端刷新时再按项目过滤。

自动执行的 TTL、续租、周期 sweep、分页、启动候选上限、Agent cleanup 和关闭预算全部
来自 `COUNCIL_ORCHESTRATION_*` 配置。cleanup 必须不大于编排关闭预算；启动候选超过上限
会失败而不是漏恢复。V1 Claude 适配器只裁较早公开历史，永远保留可信头与当前 instruction，
且不恢复 session。Store 读取 Agent 上下文前还会按 `COUNCIL_DEFAULT_MESSAGE_LIMIT`
限制最新公开消息数，避免超大议题在 prompt 字符裁剪前放大内存。

模型设置保存在共享 SQLite 的 `agent_settings` 表，Claude/Codex 适配器在每次调用时读取当前
模型，因此切换无需重启服务。API Key 不写 SQLite，macOS 通过系统 Keychain 保存；设置 API
只返回 `hasApiKey`。DeepSeek 与 Kimi 共用 OpenAI Chat Completions 兼容运行时，输出、网络和
超时均有界，上游错误正文不会进入 HTTP 响应或日志。
