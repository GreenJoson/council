# data - Council Web 数据边界

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `repository.ts` | 边界 | 定义列表加载、显式选题、消息写入、Human / Accepted 人工决策和只读议题详情加载的数据访问接口 |
| `create-repository.ts` | 配置 | 根据环境选择当前数据实现 |
| `orchestration-repository.ts` | 边界 | 定义 `@Agent` 单次调用、AI 实施计划、三范围圆桌开局/作答、RuntimeBinding 关闭/重开和订阅接口 |
| `create-orchestration-repository.ts` | 配置 | 根据环境选择自动轮次数据实现 |
| `api-types.ts` | 协议 | 严格解析 canonical API 未知 JSON，并拒绝索引 Actor ID 与冻结快照不一致 |
| `orchestration-api.ts` | 协议 | 严格解析 Capabilities、Run、含审查范围/多仓库 commit 目标的圆桌视图、公开 RuntimeBinding、审批结果、分页与 `agent.output` 草稿事件 |
| `model-router-api.ts` | 协议 | 严格解析不含密钥的 Provider/Agent/BrandAsset/catalog 快照与连接测试响应 |
| `api-constants.ts` | 协议 | 定义 HTTP v1 分页和浏览器定时器配置边界 |
| `http-client.ts` | 传输 | 集中构造 URL、解析统一响应并保留 HTTP 错误语义 |
| `project-path.ts` | 配置 | 校验 http 模式 POSIX、盘符或 UNC 绝对项目路径 |
| `status-revisions.ts` | 分流 | 严格解析总、内容和编排三类 revision |
| `workspace-mapper.ts` | 映射 | 保留 Topic/Message/Decision 行级冻结快照并派生当前参与者，将 canonical Topic 摘要和详情转换为 Web 工作区；决策 status 原样透传 accepted/superseded（只丢弃 rejected） |
| `http-repository.ts` | 真实 | 惰性读取当前详情，按 SSE revision 串行校准工作区，提交用户绑定的 accepted 人工决策，并提供不改状态的只读议题详情加载 |
| `http-orchestration-repository.ts` | 真实 | 校准运行与逻辑绑定列表，生成 AI 实施计划，传输圆桌审查范围，执行关闭/重开，合并临时草稿并接入 Model Router API |
| `mock-data.ts` | 示例 | 提供脱敏的 Operator Console 工作区数据；含一组可验证的架构档案样例——一个被取代的旧决策 + 取代它的新决策（decision.rationale 内嵌 mermaid 图）+ 一条含 mermaid 图的 synthesis 消息 |
| `mock-repository.ts` | 原型 | 同构模拟选题、创建、发帖、同步、Human / Accepted 人工结束（同时写入 decidedAt 供架构档案 ADR 编号排序）和只读议题详情加载 |
| `mock-orchestration-repository.ts` | 原型 | 同构模拟逻辑绑定、AI 实施计划、三种圆桌审查范围、关闭/重开、运行操作和系统身份约束 |
| `desktop-bridge.ts` | 原生边界 | 严格封装 Tauri invoke、event、目录选择器与本地 Agent 服务配置/健康命令 |
| `native-repository.ts` | 桌面 | 直接调用 Rust core，用事件/轮询校准外部写入，提交用户绑定的 accepted 人工决策，并提供不参与设置世代的只读议题详情加载 |
| `desktop-orchestration-repository.ts` | 桌面编排 | 探测本地 Agent 服务：可达时委托 HTTP 编排仓储及 AI 实施计划，离线时保持诚实快照并周期重试、服务恢复后自动转 LIVE |
| `error-message.ts` | 边界 | 把 Tauri 字符串 reject、普通对象与 Error 归一成可展示文案；只认 Error 会在启动失败时吞掉唯一的线索 |
| `selectors.ts` | 查询 | 提供可测试的议题文本搜索与状态筛选逻辑（filterTopics）、Markdown 顶层 mermaid 围栏提取（extractMermaidBlocks，逐行围栏状态机而非正则，不误提嵌套围栏）与架构档案聚合纯函数（computeAdrNumberAssignments 稳定 ADR 编号、buildArchitectureTimeline 演进时间线、aggregateConstraints 约束去重聚合、collectArchitectureDiagrams 图集提取）|
| `section-collapse.ts` | 偏好 | 架构档案区块折叠状态的读写边界；`parseCollapsedSections` 是纯函数，只认已知区块 id，值损坏时回落到全展开 |
| `theme.ts` | 偏好 | 浅色/深色主题的读取、应用与持久化唯一边界 |
| `mention-parser.ts` | 查询 | 动态 Agent 召唤的纯函数层；统一按适配器绑定的 Actor ID 匹配，排除代码围栏并提供自动补全和前导召唤芯片提取 |
| `commit-association.ts` | 协议 | 把一个仓库内以逗号、空格或换行批量粘贴的 SHA 展开为独立提交，校验相对路径后编码为 `council-fix` 尾块，并为消息卡安全解码 |
| `work-item-tree.ts` | 查询 | 把扁平实施项按 `parentId` 装成两层树并稳定排序；完成度只数叶子，父任务不进分母 |

`HttpCouncilRepository` 与 `HttpOrchestrationRepository` 只从构造参数接收 API origin；应用入口只允许由 `VITE_COUNCIL_API_URL` 提供该值。http 模式还必须通过 `VITE_COUNCIL_PROJECT_PATH` 提供跨平台绝对项目路径，每个新议题都会携带该路径，使 Agent Adapter 获得可信工作目录。无结构化证据时映射结果保持空数组，不从消息文本猜测证据。普通 Topic、Message 和 Decision 写请求不发送 Actor 身份，服务端固定为 `human`；Agent 产出只通过 orchestration 协议进入共享时间线。

初始加载和实时刷新只读取 Topic 分页摘要及当前议题按配置页大小限制的最新消息，侧栏其他议题保持轻量 canonical `open/decided` 状态；显式选题成功后才替换详情。`messageTotal` 用于显示未加载历史数量。

`loadTopicDetail(topicId)` 是三个实现共有的只读旁路：mock 直接深拷贝内部数据，http 与 native 复用既有的详情请求和 `mapApiTopicDetail` 映射，但都不写回 `#topics`/`#activeTopicId`/`#snapshot`，也不调用 `#publishSnapshot`/`#publish`，因此不会改变当前选中议题，也不会触发订阅者收到新快照；native 实现中该方法不做设置世代校验，因为它本身无状态、不缓存任何跨调用结果。

SSE 的 `council.changed` 传总 revision；两个仓储收到事件后各自读取 `/api/v1/status`
分流。内容仓储仅在 `revisions.content` 变化时读取 Topic，编排仓储仅在
`revisions.orchestration` 变化时读取当前议题 Runs。`agent.output` 不触发 REST 重读，
而是按 run/adapter/sequence 在内存合并 `snapshot/reset/append/replace/complete`；快照只向
当前议题投影，切换回来仍可恢复同一活动 Run，正式状态刷新后清理临时草稿。事件前已经启动的
读取不会消费该 revision；刷新按 `VITE_COUNCIL_EVENT_REFRESH_*` 做有界串行重试。快速退避和
低频恢复 timer 都绑定 listener 生命周期，最后一个 listener 退出会清理 timer 并唤醒等待中的
drain；立即重订时，旧事件世代不能消费新世代的排队 revision。内容与编排分别通过对应
recovery 配置持续校准；EventSource 再次 open 也会立即重试失败版本。

`NativeCouncilRepository` 复用相同 parser 和 mapper，Rust 返回未经信任的裸领域对象仍必须先校验。Tauri 本进程写入通过 `council://changed` 立即刷新；其他 Codex/Claude MCP 进程写入通过配置化 status 轮询发现。项目或日志库变化会递增设置世代并废弃旧的在途加载，防止旧项目结果覆盖新项目。最后一个 listener 退出时同时撤销事件监听并清理轮询。

桌面自动轮次不再是显式 stub：`DesktopOrchestrationRepository` 通过 `get_orchestration_config` 从 Rust 设置层拿到本地 Agent 服务地址（默认集中在 Rust `settings.rs` 一处，前端不硬编码），用 `check_orchestration_service` 做 Rust 侧健康探测（不受 CORS 影响），可达时创建 `HttpOrchestrationRepository` 直连编排 REST/SSE；不可达时返回带诊断指引的离线快照（含服务地址），按 `VITE_COUNCIL_DESKTOP_HEALTH_INTERVAL_MS` 周期重试。Rust 桌面层在 App 打开或日志库切换后自动托管内置 sidecar，前端的单次 autostart 调用只负责恢复竞态或异常退出。服务就绪后自动转 LIVE：重新加载能力、回放当前议题选择并停止健康轮询，无需重启应用。写操作在离线态直接抛出与面板一致的诚实指引。
