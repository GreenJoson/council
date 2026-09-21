# orchestration - REST 编排产品接线

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `delegation-checkpoint.ts` | 检查点协议 | 私有指令与进度、公开白名单投影 |
| `delegation-runtime-stage.ts` | 阶段执行 | 独立预算、早期会话与进度持久化，仅只读瞬态故障有界重试 |
| `runtime-audit-store.ts` | 执行证据 | 持久化脱敏阶段/工具事件，提供不可覆盖的游标分页记录，不存私有草稿与未知用量 |
| `work-attention-store.ts` | 聚合查询 | 按当前项目汇总待决策、待验收、阻断、失败与待回复，较新执行取代历史状态 |
| `delegation-workspace-snapshot.ts` | 草稿快照 | 临时索引保留原 HEAD/索引/文件；拒绝配置、运行数据、二进制、符号链接和疑似凭据后接续未提交代码 |
| `delegation-recovery.ts` | 恢复边界 | 区分事件流/最终回复超限等失败，核验受管目录、Git 仓库、原 HEAD 与提交/草稿恢复条件 |
| `agent-progress-hub.ts` | 兼容桥 | 把统一 RuntimeEvent 投影为现有 SSE 草稿、单调 sequence 和重连快照，不写 SQLite |
| `claude-agent-adapter.ts` | 适配 | 只调用纯 ClaudeRuntime，首轮发送完整公开上下文、后续恢复 session 并发出统一文本事件，只公开脱敏诊断 |
| `codex-agent-adapter.ts` | 适配 | 只调用纯 CodexRuntime，首轮发送完整公开上下文、后续 `exec resume` 并把公开 JSONL 消息转成统一文本事件 |
| `acp-delegated-agent-adapter.ts` | Delegated 适配 | 将注册表选定的 ACP session、只读工具/审批和公开文本映射到统一 RuntimeEvent，禁止写操作越过 Council policy |
| `openai-compatible-agent-adapter.ts` | ToolLoop 适配 | 将公开上下文交给只读 AgentLoop，把文本和 Council 工具事件转成统一 RuntimeEvent，并仅公开脱敏原因 |
| `execution-manager.ts` | 执行 | 快速响应后执行 claim/drive，同时续租 Run 与 RuntimeBinding，并周期扫描活动运行和有界关闭 |
| `service.ts` | 聚合 | 固定浏览器身份/策略、冻结周期的 Agent/Provider/Runtime 修订与授权能力、模型调用前 fail-fast，并组装生产依赖 |
| `work-item-planner.ts` | 结构化边界 | 仅在用户显式选择规划 Agent 后，把 Accepted 决策作为非可信上下文交给该 Agent，严格解析 `council-work-plan` 并过滤重复任务；接受决策本身绝不触发规划 |
| `work-item-delegation-store.ts` | 委派账本 | 持久化 supervisor/executor、有效权限、尝试轮次、隔离分支、审核结论与终态；公开 DTO 不泄露本机 worktree 路径 |
| `work-item-delegation-manager.ts` | 执行闭环 | 只在显式委派时建立隔离 worktree，按 supervisor→executor→review 推进；只传当前议题/任务/diff，扫描敏感内容后由 Council 统一提交；冻结验收标准、限定只读瞬时重试，并从已提交检查点创建新委派 |

生产工厂从 Model Router 的 AgentDefinition 动态注册后台适配器。每个 Agent 都绑定独立
Actor 与 `@mentionAlias`；同一 Kimi、DeepSeek 或其他 Provider 下可以创建多个 Agent，
不会共享 `other` 身份。适配器不调用兼容层客户端，因此不会提前写消息；回复只能由
`SQLiteCouncilStore.commitRound` 在运行 lease、RuntimeBinding lease 和版本校验通过后原子发布，
同时保存 session、实际消费水位和 human 请求消费凭证。调用开始后新到达的消息不会被水位
越过，成功消费过的请求会在再次调用模型前被拒绝。RuntimeBinding 是逻辑会话绑定，不代表
常驻 OS 进程。ACP DelegatedRuntime 是例外：同一 RuntimeBinding 复用一个长驻进程与 ACP session；
同一议题同一 Agent 串行复用，不同议题不会共享。

HTTP 请求断开不会取消后台执行。只有显式 cancel 会把运行改为 `cancelled` 并失效 lease；
其他进程的续租会在一个 heartbeat 内失败并中止 Agent。进程关闭使用统一总预算；
Agent 收到取消后还必须在独立 cleanup 期限内退出，超时不得自动重试。启动与周期 sweeper
直接按 Store 的 `running/waiting_agent` 状态索引完整分页：旧 lease 到期后自动接管，
`running` 继续，`waiting_agent` 标记为 `execution_interrupted`，`waiting_user` 不参与扫描。
候选数超过安全上限会明确阻止启动，不会静默漏恢复。

生产初始化会检查 Claude Code CLI、Codex CLI 与已配置 ACP Agent 的可用性。不可用适配器在
capabilities 中标记 `available=false`，返回注册时提供的可执行提示（如 Codex 的
"运行 codex login"）或通用限制说明，并在创建运行时被拒绝；底层本机错误不会进入响应。
Claude/Codex 非零退出按认证、额度、模型权限、回合耗尽、暂时性服务故障和未知进程退出分类；
未知退出不公开内部原因。日志只记录脱敏诊断码、retryable 标志和同一份安全原因，不记录
prompt、项目路径或 CLI stderr。

Claude/Codex、ACP 与远程 Agent 每次调用都从 `ModelRouterService` 读取当前 Provider 和 Agent
定义。远程 Provider 只有在 HTTPS/loopback Base URL、Keychain API Key、启用 Provider
和启用 Agent 同时有效时才进入 capabilities；兼容 Agent 共用 `ModelClient → ToolHost →
AgentLoop` 只读路径，在有界预算内获得 `repository_read`，并以各自 `mentionAlias` 参与
`@` 补全和召唤。路由变更会刷新临时适配器与
capabilities，无需重启服务；活动 Run 引用的 Agent/Provider 不允许中途修改或删除。
重复读取 capabilities 会保留未变化绑定最近一次已验证的可用性；只有绑定 fingerprint
变化时才清空状态并强制重检，避免 TTL 内把健康动态 Agent 错误重置为不可用。

通用 ACP Runtime 根据 Provider 持久化的 `runtimeDefinitionId` 从受控注册表读取命令、
启动参数、模型选择协议与声明能力，再与独立 Council policy 计算实际授权；当前注册 Kimi、
Gemini、Grok、Codex 与 Claude Agent。供应商自己的 AgentLoop 负责工具循环，
Council 不重复实现。Runtime 只在定义获得 `repository_read` 时声明文件读取能力，只在
获得 `git_diff` 时挂载仅公开 `council_git_diff` 的 stdio MCP；议题关联仓库白名单同时进入
ACP 文件桥与兼容 API ToolLoop；
read/search/think 与该精确工具名仅允许单次，execute/edit/delete/move/fetch 等请求均拒绝。
文件路径必须 realpath 后位于当前项目或本轮已关联仓库根目录；Git 工具只读已提交 commit/ref，过滤敏感路径，
禁用外部驱动且不接触未提交工作区。服务重启后使用
RuntimeBinding 保存的 session ID 执行 `session/resume`；accepted 决策、配置变化、手动
关闭、空闲回收与服务退出都会有界取消并终止对应进程树。

兼容 API Provider 没有供应商 DelegatedRuntime，因此走 Council 自己的只读 AgentLoop。
ModelClient 只负责通信与 Tool Call；ToolHost 提供项目内文本读取、目录枚举、文本搜索和
受控已提交 Git diff；
AgentLoop 负责“模型请求 → 工具执行 → 结果回传 → 继续推理”。这条路径没有 Shell、
未提交工作区读取、文件写入、提交、推送或部署能力，所有工具事件归 `owner=council`。事件不接受
模型自报能力；Adapter 必须按本地 ToolHost 注册表从工具名解析能力，未知工具立即失败。

桌面默认在正式回复原子落库后自动完成运行。Composer 的 `@Agent` 调用显式关闭完成门；
底层 API 仍保留 `confirmationBeforeCompletion=true` 的兼容能力，但 Web 不再暴露与 Composer
重复的手工启动表单，其他执行策略仍由服务端固定。

编排器和适配器只发出统一 `RuntimeEvent`；`AgentProgressHub` 是面向旧 SSE 草稿协议的兼容
投影，键由 `runId/topicId/adapterId` 组成，完成后立即清理。正式回复仍只能经
`SQLiteCouncilStore.commitRound` 原子发布，因此浏览器断线、草稿丢失或进程退出不会制造
半条正式消息。`RuntimeAuditStore` 同时接收生命周期与工具事件并追加落库；文本草稿与上下文用量不写入审计。

取消或失败清理会在同一状态迁移中清空 session 与游标；任何缺少 session 的绑定都强制使用
完整公开上下文。进程重启只保留仍存在的可恢复 session。只有 open 议题可以创建运行或重开
绑定；accepted 决策会 fencing 并关闭全部绑定，已决议题必须新建议题后才能继续通用 Run。
已决议题仍允许显式实施计划和委派。一次性实施计划不恢复旧 session、不创建 RuntimeBinding/Run，也不给模型 Council
写权限；服务端只接收结构化草案并通过 canonical `work_items` 写入。显式委派使用独立账本与隔离工作区，完成条件和恢复规则见 [执行交付](../../../../docs/execution-delivery.md)。
| `cycle-metrics.ts` | 度量 | 从既有落库状态推算轮次、墙钟耗时、提问次数、缺失 verdict 与「决策正文 == 最终 synthesis」一致性核对 |
| `cycle-decisions.ts` | 决策同步 | 把最终 synthesis 正文逐字落成 proposed 决策；accepted 仍只能由用户写 |
| `cycle-driver.ts` | 自动交接 | 发起人入选时把议题正文冻结为首轮提案并直接召唤其他评审；发起人未入选时按规则复用或召唤首位提案人；Commit 互审读取议题后续 Note 关联的多仓库提交并传给评审，提问处停住，收敛时写 proposed 决策 |
| `service.ts` | 产品聚合 | Composer 手动 @Agent 从议题最新结构化提交记录继承跨仓库白名单；自由 instruction 不能自行扩大授权 |

委派从派发与认领时保存任务版本，成功/失败回写均不能覆盖后续人工作答；已提交检查点在后续模型调用之前保存。活动委派占用的 Agent/Provider 禁止修改配置，Node 与 Rust 同时禁止关闭仍有活动委派的议题。

接续只为新运行选择权限；创建前复核 Agent 上限，权限变化使指令检查点失效，审计保留前后权限。

交付可靠性模块：`delegation-review.ts` 管理逐文件材料和审核覆盖，`delegation-git-delivery.ts` 通过安全快照追加提交，`delegation-execution-result.ts` 接收主动阶段交接，`delegation-handoff.ts` 将旧摘要与审核意见传给新运行。修正阶段中断可接回上一提交后的草稿；材料不足独立于实现缺陷处理。
