# orchestration - REST 编排产品接线

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `delegation-checkpoint.ts` | 检查点协议 | 私有指令与进度、公开白名单投影 |
| `delegation-runtime-stage.ts` | 阶段执行 | 独立预算、早期会话与进度持久化，仅只读瞬态故障有界重试 |
| `delegation-task-context.ts` | 任务上下文 | 完整保留任务、约束与已接受结论，只节选背景；关键材料超限在派发前拒绝，完整内容参与指纹；代码委派输入图段落只列相对路径 |
| `delegation-execution-result.ts` | 阶段交接 | 识别说明和 Markdown 包装中的交接，损坏交接不能成为完成摘要 |
| `delegation-execution-segments.ts` | 有界接续 | CLI 调用终态与任务终态分离，按已校验的交接、真实文件变化和冻结预算继续 |
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
| `service.ts` | 装配与生命周期 | 组装 store、注册表、attention/audit、编排器、执行管理器、CycleDriver 与产品服务；持有配置锁、决策写入器/审核账本挂载、initialize/shutdown 与空闲绑定回收，对外以同名同签名转发注册表与产品服务；`createProductionOrchestrationService` 在此；工厂另建独立数据库连接装配 P3 `PipelineService`（`attachPipelines`/`pipelines`），一次性调用与委派均经本服务转发，`initialize` 在委派恢复后启动流水线对账，shutdown/close 同步停止；同样装配 P4 `TeamService`（`attachTeams`/`teams`：注入 Lead MCP 入口、`collectCouncilEnv()` 与回环 HTTP 地址，`initialize` 在委派恢复后对账团队）；Claude CLI 可用性检查返回声明能力（含 `image_input`） |
| `agent-registry.ts` | Agent 注册表 | 固定 Actor 与适配器注册（重复注册即关闭 store 并拒绝）、capabilities 快照与 TTL 刷新、动态 Agent 同步、冻结周期的 Agent/Provider/Runtime 修订与授权能力；可用性检查可返回 `{ available, runtimeCapabilities }`，探针声明随 TTL/指纹缓存覆盖并重算授权（Codex 生图能力由此生效）；`transportKindForProtocol` 在此导出 |
| `product-service.ts` | 产品用例 | 圆桌周期开始/读取/作答/提交修复/放弃、Run 创建/启动/批准/取消/恢复（模型调用前 fail-fast）、实施计划生成、RuntimeBinding 列表/关闭/重开、Provider/Agent 设置变更与委派单项/批量/接续/取消（图像委派启动前强制刷新探针，执行者 granted 须含 `image_generate`）；`invokeOneShot` 是单次只读 Agent 调用骨架（任务规划与流水线 brief/review 共用，不建 Run），`listAgentCandidates` 给流水线挑默认 Agent；Composer 手动 @Agent 从议题最新结构化提交记录继承跨仓库白名单，自由 instruction 不能自行扩大授权 |
| `cycle-metrics.ts` | 度量 | 从既有落库状态推算轮次、墙钟耗时、提问次数、缺失 verdict 与「决策正文 == 最终 synthesis」一致性核对 |
| `project-activity.ts` | 度量 | 同项目活动 Agent 计数：running/waiting_agent 的 Run + executing/reviewing 的委派；queued/waiting_user/changes_requested 在等别人，不算 |
| `cycle-decisions.ts` | 决策同步 | 把最终 synthesis 正文逐字落成 proposed 决策；accepted 仍只能由用户写 |
| `cycle-driver.ts` | 自动交接 | 发起人入选时把议题正文冻结为首轮提案并直接召唤其他评审；发起人未入选时按规则复用或召唤首位提案人；Commit 互审读取议题后续 Note 关联的多仓库提交并传给评审，提问处停住，收敛时写 proposed 决策 |
| `work-item-planner.ts` | 结构化边界 | 仅在用户显式选择规划 Agent 后，把 Accepted 决策作为非可信上下文交给该 Agent，严格解析 `council-work-plan` 并过滤重复任务；接受决策本身绝不触发规划 |
| `delegation-task-resolver.ts` | 任务解析 | 按任务 id 读取任务与可选议题（无议题时决策为空、项目路径取任务自身），并集中执行委派前置校验：kind 为 code/image 且与任务一致（kind=prototype 任务按 code 委派）、输入图校验 `validateInputImageAssets`（≤8、不重复、同项目图像，代码与图像委派共用）、版本、议题归属、未完成、叶子任务与上下文预算 |
| `work-item-delegation-store.ts` | 委派账本 | 持久化可选议题、委派 kind 与输入资产、supervisor/executor、有效权限、尝试轮次、隔离分支、审核结论与终态；`onSettled` 在非终态→终态时异步通知一次（流水线据此推进）；公开 DTO 不泄露本机 worktree 路径 |
| `delegation-image-execution.ts` | 图像委派 | 单段生图闭环：校验 brief 与参考图（≤8、同项目图像），参考图拷入 `.council/in/` 并写 exclude，经 `CodexRuntime.generateImages` 生图（失败即 `image_unavailable`，文案沿用运行时原因，生图超时点名 `COUNCIL_CODEX_IMAGE_TIMEOUT_MS`，审计带 diagnosticCode）；清单 path 与 `.council/out/` 收集，两路都为空时才兜底扫 `<codex-home>/generated_images/<threadId>`（并集会把模型缩放前的原图一并收进来），sha256 去重入库并以 output 角色挂到任务（受 `COUNCIL_CODEX_IMAGE_MAX_OUTPUTS` 限制）；完成后委派 approved（headCommit=baseCommit）、工作项停在 in_progress 等人工验收，`outputManifest` 存脱敏清单加本次入库的 `assetIds` 与逐张 `assetId`（`readImageOutputManifest` 供流水线复盘只看本次产物，失败尝试已入库的图不混进下一次复盘）；清单里超出 brief 的产物（修订轮常见）只丢弃并记 `image.manifest_outputs_dropped`，不让整轮失败；失败分 `image_unavailable`/`outputs_missing`/`manifest_invalid`（文案带协议定位原因）；审计只记数量、字节、去重数与耗时。导出 `excludeCouncilDir`/`copyInputAssets`/`COUNCIL_INPUT_DIR` 供代码委派输入图与流水线复用。依赖全部显式注入，不 import 管理器 |
| `delegation-worker-execution.ts` | Worker 执行 | P4 Worker 子委派：在 TeamService 预先分叉的 worktree 里执行 Lead 指令（分段接续同主委派），不认领实施项、不审核，完成后由 Council 提交到 Worker 分支并直接 approved（= done）；没有改动即失败 |
| `delegation-initial-baseline.ts` | Git 基线 | 全新仓库（无提交）的安全初始基线提交，从管理器拆出 |
| `work-item-delegation-manager.ts` | 执行闭环 | 只在显式委派时建立隔离 worktree，按 supervisor→executor→review 推进；image 委派只做校验与默认监督者解析后按 kind 分流到 `delegation-image-execution.ts`，在委派根目录下的隔离空目录执行、不建 worktree 也不要求项目是 Git 仓库，不支持接续；代码委派在非 Git 目录直接给出初始化指引；代码委派的输入图拷进 worktree 的 `.council/in/`（写 exclude）并以相对路径进入提示词；`get`/`resume`/`onSettled`/`stageProjectInputs` 供流水线对账、原型交接接续、终态订阅与 brief/review 资产拷入；任务可不属于任何议题（单项委派），批量委派仍按议题；只传当前任务/所属议题/diff，扫描敏感内容后由 Council 统一提交；冻结验收标准、限定只读瞬时重试，并从已提交检查点创建新委派（接续沿用原 kind 与输入图）；P4：`startTeamWorker` 起 `team_worker=1` 子委派（不进委派列表与工作注意力），`setTeamHooks` 让 TeamService 为 Lead 执行阶段注入 council MCP 与「团队模式」指令，`setTeamLeadHead`/`teamLeadWorkspace`/`projectPathOf` 供检查点与合并回写 Lead HEAD |

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

`service.ts` 的初始化顺序固定为 store → 回退路由存储 → `AgentRegistry`（注册循环先于其余 SQLite 句柄，重复注册以原文案拒绝）→ attention → audit → orchestrator → 执行管理器 → CycleDriver → `CouncilProductService`；指向产品服务的回调（`onRunSettled`、CycleRunner、注册表关闭绑定）都是闭包，只在 `initialize()` 或显式调用后解引用。注册表与产品服务之间只有一条边：注册表同步动态 Agent 时通过注入的 `closeRuntimeBinding` 关闭失效绑定。

委派从派发与认领时保存任务版本，成功/失败回写均不能覆盖后续人工作答；已提交检查点在后续模型调用之前保存。活动委派占用的 Agent/Provider 禁止修改配置，Node 与 Rust 同时禁止关闭仍有活动委派的议题。

接续只为新运行选择权限；创建前复核 Agent 上限，权限变化使指令检查点失效，审计保留前后权限。

交付可靠性模块：`delegation-review.ts` 管理逐文件材料和审核覆盖，`delegation-git-delivery.ts` 通过安全快照追加提交，`delegation-execution-result.ts` 接收主动阶段交接，`delegation-handoff.ts` 将旧摘要与审核意见传给新运行。修正阶段中断可接回上一提交后的草稿；材料不足独立于实现缺陷处理。

任务正文、约束和已接受结论不能被长背景截断；关键材料本身超限时，在创建委派/工作区前拒绝请求。审核每次显式收到当前任务上下文，不依赖保存的 supervisor 会话仍在。交接解析只产出一个经过校验的对象，接续层不得重新按原始字符串位置解析 JSON。
