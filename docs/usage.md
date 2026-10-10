# Council 使用指南

Council 让 Codex App 与 Claude Desktop Code 共享经过整理的架构议题、方案、批评和决策。它不会读取或合并两个桌面应用的完整私有聊天记录。

## 目录

- [先选使用模式](#先选使用模式)
- [首次使用](#首次使用)
- [桌面应用](#桌面应用)
- [模型与 Provider 设置](#模型与-provider-设置)
- [模式一：两个桌面手动接力](#模式一两个桌面手动接力)
- [模式二：Codex 自动调用 Claude](#模式二codex-自动调用-claude)
- [模式三：Operator Console 自动轮次](#模式三operator-console-自动轮次)
- [继续已有议题](#继续已有议题)
- [常用提示词](#常用提示词)
- [议题和决策规则](#议题和决策规则)
- [隐私边界](#隐私边界)
- [故障排查](#故障排查)

## 先选使用模式

| 模式 | 适用场景 | 是否需要 Claude CLI 登录 |
|---|---|---|
| 双桌面手动接力 | 你习惯分别在 Claude Desktop Code 和 Codex App 中讨论 | 不需要 |
| Codex 自动讨论 | 希望只在 Codex App 发一次指令，由 Codex 自动调用 Claude | 需要 |
| Web 自动轮次 | 希望在 Operator Console 创建、观察、批准、取消或恢复多 Agent 轮次 | 本机 Agent 需要登录；远程 Provider 需要 API Key |
| 桌面工作台 | 希望双击启动、原生切项目并用本机或远程 Agent 直召 | 内容协作不需要；直召需要相应 CLI 登录或 API Key |

桌面工作台可以独立使用；双桌面手动接力适合继续沿用熟悉的客户端界面，共享同一议题而不再复制粘贴。

## 首次使用

首次接入在「设置 → 客户端接入」一键写入 Claude Code / Codex 配置，细节与手动备用方式见 [MCP 接入](mcp-setup.md)；单独使用桌面应用无需配置 MCP。

1. 重启 Codex App 和 Claude Desktop，或分别新建一个任务，让客户端重新加载 `$council` Skill 和 `council` MCP。
2. 在两个客户端中打开同一个项目。
3. 让第一个 Agent 创建议题时写入项目绝对路径、问题、约束和验收标准。

可以先检查状态：

> 使用 `$council` 检查 Council 状态，并告诉我 MCP 是否正常。

如果只使用双桌面接力，到这里就可以开始，不需要打开终端。

## 桌面应用

开发和构建：

```bash
npm run install:all
npm run dev:desktop
npm run build:desktop
```

正式构建会生成可双击启动的系统应用。桌面窗口直接通过 Tauri IPC 调用 Rust 内容核心，不需要另外启动 WebUI 或 HTTP API。

首次启动时：

1. 选择一个源码目录之外的“日志库”。Council 会在其中读取或创建 `council.sqlite3`。
2. 选择当前项目目录。新建议题会记录该项目路径，后台 Agent 才能检查正确的代码。
3. 以后点击左上角项目名即可切换，最近使用的项目会保存在本机应用设置中。

日志库和项目目录只保存在操作系统应用配置及 SQLite 运行数据中，不写进仓库。Codex 与 Claude 的 MCP 配置仍要把 `COUNCIL_DATA_DIR` 指向同一日志库；修改后重启两个桌面客户端，让新进程重新加载配置。

工作区按视图切换，地址栏 hash 即入口：`#/discussion/<topicId>` 讨论、`#/tasks` 与 `#/tasks/<taskId>` 任务、`#/assets` 与 `#/assets/<assetId>` 资产、`#/pipelines` 与 `#/pipelines/<pipelineId>` 流水线、`#/decisions` 决策、`#/architecture` 架构、`#/attention` 关注。刷新或从外部链接打开都能回到同一视图。

界面是三栏壳（截图见 `docs/designs/council-v2-*.png`）：最左侧图标栏自上而下是会话、需要我处理、资产、架构档案、决策记录五个入口，底部是「偏好」与「模型与 Provider 设置」；会话入口上的徽标是当前项目运行中的 Agent 数，需要我处理入口上的徽标是待处理议题数，为 0 不显示。中间是会话列表：顶部切换项目与新建议题，⌘K 聚焦搜索，「全部 / 议题 / 任务 / 流水线」筛选同一条流里的三类条目。打开议题后右侧是「上下文」栏：圆桌、决策包、实施进度、自动轮次、状态与参与者，以及默认只露标题和数量的约束 / 证据 / 备选方案（点标题展开，展开状态跨会话记住）；桌面端可从讨论头部收起整栏，窄屏作为抽屉打开。底部状态条左侧是同步状态与活动 Agent 计数（运行中的调用加执行 / 审核中的委派），右侧是构建身份。编辑器顶部的「讨论 / 派任务 / 起流水线」分段决定当前输入去向：后两者把草稿带进新建任务或新建流水线对话框。「偏好」里设置主题、界面语言与圆桌轮次上限，发起圆桌时不再逐次填写轮数。

“任务”页是不经议题的工作入口：列表按状态分组，可按类型和来源筛选；“新建任务”只需标题和可选说明，当前开放代码与图像任务（原型任务由流水线的原型阶段生成，调研任务在后续阶段接入；流水线在“流水线”页创建，不走“新建任务”）；图像任务可在创建时附带 `council-brief` 简报（目标、交付物尺寸与数量、是否透明、配色、风格约束、验收条目），也可以创建后在详情页编写，表单和 JSON 两种编辑方式会按服务端规则校验。任务详情里更新状态（完成或受阻必须填写证据）、查看所属议题、发起或取消 Agent 委派并查看委派历史；单条委派的入口已从讨论页迁到这里，讨论页的“实施进度”只显示最近一次委派的状态与执行段，并提供“在任务页管理委派”跳转。议题派生的实施项也会出现在同一项目的任务列表中。

代码任务可以用“团队模式”交给一个 Lead 并行拆分：在任务详情的委派区选好执行者与审核者后勾选“团队模式（允许执行者并行派发 Worker）”，设定并行上限（1–6，默认 3）再发起；该任务已有活动团队时不能再勾选，图像委派没有这个选项。执行者作为 Lead 运行，在自己的会话里用 MCP 工具管理 Worker：`council_dispatch_worker` 派发（每个 Worker 在独立分支上工作，可声明负责的目录范围）、`council_list_workers` 查看、`council_wait_worker` 等待结束、`council_interrupt_worker` 打断、`council_merge_worker` 把已完成 Worker 的分支受控合并回 Lead 分支、`council_archive_worker` 归档；同时运行的 Worker 不超过并行上限。任务有团队时详情页变为“主列 + 右栏”（窄屏右栏在主列下方）：右栏“团队”显示团队状态（活动中 / 已结束）、跳到 Lead 委派的链接与并行上限，以及每个 Worker 的名称、角色、状态（待命 / 运行中 / 已完成 / 出错 / 已归档）、分支短名、已合并提交与目录范围。你能做四件事：“聚焦”某个 Worker（单选，只影响展示，展开它的执行进度与失败分类）、“打断”待命或运行中的 Worker（需确认，其余 Worker 不受影响）、“归档”已完成或出错的 Worker（默认隐藏，可点“显示已归档”找回）、“结束团队”（需确认，仍在运行的 Worker 会被打断，已合并的提交保留）。在 Web 上不能直接派发 Worker，派发只由 Lead 完成；HTTP 对应 `/api/v1/tasks/:taskId/team`。

“资产”页是当前项目的资产库：图像、3D 模型、文档、归档包按类型筛选、分页浏览；“从项目导入”填写相对项目根目录的路径即可入库，绝对路径、越出项目目录的路径和符号链接会被拒绝，同一文件重复导入返回已有资产。资产详情显示缩略图、尺寸、SHA-256、生成者、来源委派与挂接关系；挂为任务产物的资产可以设为最终稿；删除是软删除，原文件保留在资产目录但不再可读。勾选「只看未引用」只列出没有挂到任何任务、消息或决策的资产；「清理未引用」先统计数量并弹窗确认，再逐个软删除这些资产，总量配额只计未删除资产，因此清理会释放配额但不会动资产目录里的文件。图像委派生成的图片会自动入库并出现在任务详情的“产物”区。讨论消息里引用的图片也进这里：编辑器的“引用图片”在桌面端打开原生文件选择器选一张本机图片（例如下载目录里的截图），浏览器端则选择文件或直接粘贴图片，图片按内容哈希存入当前项目的资产库，原文件不复制进项目目录也不移动，正文只写 `![说明](council-asset:<资产 ID>)`，发布后该资产自动挂到这条消息（角色 reference），资产详情能回溯到消息；Agent 在消息里引用项目内相对路径的图片（如 `![草图](docs/x.png)`）由本地服务只读出站，同样内嵌缩略图并可点击放大，不入库。

“流水线”页把“写简报 → 出图 → 复盘 → 选定（→ 原型）”串成一条可追踪的链路，只需要一句话目标：模板有“应用视觉稿”（出图后再把选定的图交给 Agent 做可点击原型）、“游戏素材包”（至少 6 张透明 sprite）与“概念设定图”；新建时可附约束与最多 8 张参考图，Agent 不选则按已启用的 Claude（写简报、复盘）与通过生图探针的 Codex（出图、原型）自动选择。列表按“等待我处理 / 进行中 / 失败 / 已完成”分组；详情页的阶段轨道显示每段状态，只有两个节点需要你动手：确认 Agent 起草的简报（可先改再确认），以及在并排对比里勾选最终稿。复盘由 Claude 看图给出通过或修订意见，修订会自动重跑出图，轮数受 `COUNCIL_PIPELINE_MAX_REVISIONS` 限制；失败的阶段可“恢复”重跑，进行中的流水线可“取消”。流水线本身是一条 `kind=pipeline` 的任务，各阶段生成的图像/原型子任务会出现在“任务”页，选定的最终稿同时挂到资产库；“应用视觉稿”的原型委派通过后流水线即归入“已完成”，原型任务本身仍在“任务”页等你验收。流水线依赖本地 Agent 服务，离线时列表为空并禁用新建。

桌面应用支持议题、消息、决策、项目切换、跨进程刷新和 Agent 调用。Composer 输入 `@` 后选择可用 Agent 并发布，会先保存公开消息，再创建对应后台运行；回复成功后自动回贴并完成，不需要复制、再次转发或额外批准。每次 `@` 都是独立的可审计调用；存在调用或持久会话时，右侧「上下文」栏的自动轮次区块才显示紧凑运行状态、取消、恢复和历史。直召依赖本地 Agent 服务；离线时内容协作仍可用，但不会把 `@` 悄悄当普通消息发布。

`@codex` 调用的是本机 Codex CLI，不是当前 Codex App 里的私有任务；`@claude` 同理调用 Claude Code CLI。两者只接收当前议题的公开上下文和项目目录，并按“议题 + Agent”复用逻辑 session：首次调用发送完整公开上下文，后续调用通过 `codex exec resume` 或 `claude -p --resume` 恢复，同时只补充上次成功回复后的公开增量。Claude/Codex 每轮仍启动一个可取消的独立 OS 进程。

Kimi 有两个不同入口，不能混为一谈：

- `Kimi Code`：通用 ACP DelegatedRuntime 的一个 RuntimeDefinition，不需要在 Council 填 API Key；先在本机完成 Kimi Code 登录，再从 catalog 添加 `Kimi Code` Provider 和 Agent。同一议题同一 Agent 会常驻复用一个 ACP 进程与 session，可读取当前项目内普通文本文件和受控已提交 Git diff；Council 拒绝未提交工作区读取、Shell、文件写入、提交、推送和部署。
- `Kimi`：OpenAI-compatible API 连接，需要单独 API Key；接收公开上下文，并通过 Council 只读 ToolLoop 按需读文件、列目录、搜索文本及核对已提交 Git diff。

ACP 进程不会永久常驻：accepted 决策、配置变更、手动关闭或空闲回收都会关闭 RuntimeBinding 和进程。服务或 App 重启后会用 SQLite 保存的 ACP session ID 恢复，而不是重新发送全部历史。Provider 持久化 `runtimeDefinitionId`；注册表决定实际命令、启动参数、模型选择协议与能力，Runtime 本体不按供应商分支。catalog 当前提供 Kimi Code、Gemini CLI、Grok Build、Codex ACP 和 Claude Agent ACP；未安装的本机命令只显示为不可用，不会自动下载。RuntimeBinding 的 session/cursor/epoch 仍是唯一真源，草稿和 ACP 事件不会绕过 lease/fencing 直接写消息。

生产注册表当前对应以下本机入口；可执行命令均可通过 `COUNCIL_*_ACP_COMMAND`
集中配置，不在业务代码写绝对路径：

```text
Kimi    → kimi acp
Gemini  → gemini --acp
Grok    → grok agent stdio
Codex   → codex-acp
Claude  → claude-agent-acp
```

### 从首次运行到跑通「应用视觉稿」

只靠桌面应用就能走完一条「一句话目标 → 简报 → 出图 → 复盘 → 选定 → 原型」的流水线，不需要先配 MCP：

1. 首次启动按上面的提示选好日志库和当前项目，进入会话列表。
2. 点图标栏底部的「模型与 Provider 设置」：Claude 一侧启用并填写 Agent 模型（留空不算可用）；Codex 一侧启用后点「测试」确认 CLI 已登录。生图探针随可用性检查自动运行，本机已用 ChatGPT 登录并开启生图才会通过；是否通过在第 3 步的「出图 Agent」下拉里能看出来，只有通过探针的 Codex 会出现在列表里。
3. 在任意议题的编辑器里切到「起流水线」并输入一句话目标，或从会话列表筛选「流水线」后点「新建流水线」。模板选「应用视觉稿」，可附约束与最多 8 张参考图；Agent 留空会按第 2 步的结果自动选择。
4. 打开新建的流水线，阶段轨道停在「简报」：看一遍 Claude 起草的简报，需要就直接改，然后点「确认简报」。
5. 「出图」与「复盘」自动进行：Codex 出图、Claude 看图给意见，修订会自动重跑出图，轮数受 `COUNCIL_PIPELINE_MAX_REVISIONS` 限制。中途不需要操作，底部状态条的活动 Agent 计数会随之变化。
6. 轨道到「选定」时在并排对比里勾选最终稿并点「选定」；最终稿同时挂到资产库，资产卡上带「最终稿」标记。
7. 「原型」阶段由 Codex 在隔离工作区做可点击原型并经 Agent 审核；审核通过后流水线归入「已完成」，原型任务本身仍在「任务」页等你验收：在任务状态中填写验收证据并完成。

任一阶段显示「失败」时先看阶段错误码，按 [故障排查](#故障排查) 的「流水线创建返回 409 或 503」条目处理；多数情况点「恢复」即可接续而不必重来。

## 圆桌能力与周期类型

开始圆桌时，Council 会一次性冻结参与名册、周期类型、任务需求，以及每个参与者当时的
Agent/Provider/Runtime 修订和实际授权能力。运行期间修改模型或 Provider 不会改写已经开始的
cycle；服务重启后仍从冻结快照恢复。开局可选三种审查范围：

- `方案`：评审设计、约束与取舍，可以复用已有 proposal 或开场 brief。
- `工作区`：所有参与者必须能读取项目；议题发起人入选时跳过其首轮自审，其他评审直接检查当前文件。支持未提交代码，但结论只针对可变快照，审查期间应保持文件状态不变。
- `Commit`：评审冻结提交。议题发起人入选时，Council 从议题正文与它最新的 proposal/brief 提取当前或同级仓库 commit，直接交给其他评审；结构化 `council-fix` 优先，自然语言证据也会按仓库标签解析并校验。

本机 Claude/Codex 可在只读 Shell 中检查工作区状态和 diff。ACP 与兼容 API Agent 可以读取当前项目文件及受控已提交 diff，但无法验证跨项目或未提交 diff 时必须阻断，不能根据描述假装已经检查。

- 发起人首轮跳过：只要议题创建者是本轮选中的 Agent，服务端就按 Actor 身份自动把它
  置为提案人，并把议题正文冻结成第一轮提案；勾选顺序不能让其他 Agent 抢走提案人身份。
  第一条真实调用从其他评审的 `critique` 开始，只有出现异议或最终汇总时才召回发起人。
- 非发起人提案复用：发起人未入选时，首位 Agent 已公开的 `proposal` 可以复用；普通
  `note`、评审意见和其他作者的 brief 不会被误认成提案。
- 普通讨论：只要求公开文本能力。审核未提交工作区时使用此模式；具备项目读取能力的
  Runtime 必须自己检查当前 diff，并明确结论针对可变工作区快照。
- bug 修复互审：只用于**已经提交的修复**。修复必须先由 Codex App、Claude Code 等交互式开发任务完成并提供真实
  commit；Council 圆桌只读核对该 commit/diff。参与者需要仓库读取和 diff 能力，但不会
  获得修改文件、写 Shell、运行写操作、创建提交、推送或部署权限。议题及发起人说明中
  没有可验证仓库/commit 时会在调用模型前拒绝，不会再次召唤发起人补做一轮自审。
- 附件任务：可以额外声明媒体读取、视觉等能力。

若任何参与者缺少所需能力，Council 会在启动模型前直接列出缺口，不消耗额度，也不允许
模型声称执行了未授权操作。Claude/Codex resume Runtime 和获授权的 ACP Runtime 具备
只读项目与已提交 diff 能力；Kimi API、DeepSeek 等兼容 API Runtime 通过 Council ToolLoop
获得受控 `repository_read + git_diff`，可读文件、列目录、搜索文本和指定 commit/ref 的
安全 diff，但没有未提交工作区读取、Shell、写文件、提交、推送或部署能力。
工具事件不能自报权限：模型只返回工具名与参数，Council 从本地 ToolHost 注册表解析所需
能力；未注册工具在执行前失败关闭。

兼容 API ToolLoop 不再让同一轮中的每个工具分别占满输出上限：一轮请求的全部工具共享
结果预算。模型已经读过的旧工具结果在需要腾出空间时会变成带工具参数、原文长度、SHA-256
和首尾摘录的证据凭据，原始结果在本轮执行内仍保留。若新结果仍使上下文接近硬上限，
Council 会停止继续提供工具并要求 Agent 直接收尾，并在回复末尾追加状态机优先读取的
`blocking` 覆盖保护；Agent 必须列出待重读的 commit、文件或行范围，不能据此放行。只有议题与可信本轮指令本身已经大到
连必要收尾指令都放不下时，运行才会以 `tool_context_limit` 失败关闭。

轮次预算耗尽时，界面会显示结构化的阻断分歧与停止原因，并给出两个出口：「我来裁决」打开人工决策直接结束议题，「再给 1 轮」按同一名册与范围续一轮。轮次上限在「偏好」里统一设置。新发言如果缺少
`council-verdict` 尾块，会按阻断处理并计入“缺少 verdict”度量，避免协议失效却继续显示
为已收敛。

## 模型与 Provider 设置

点击图标栏底部的「模型与 Provider 设置」打开 Model Router。设置明确分为两层：

- Provider 连接：保存协议、API Base URL、Keychain 凭据、品牌和启用状态；Claude Code、
  Codex CLI 与本机 ACP Agent 复用各自登录，远程连接使用兼容 Chat Completions API。
- Agent：在某个 Provider 下保存独立名称、模型 ID、`@mentionAlias` 和启用状态。同一个
  Kimi、DeepSeek 或其他 Provider 可创建多个 Agent，每个 Agent 都拥有独立 Actor，
  不会统一显示成 `Other`。

从 catalog 按需添加 Provider 后，再在该连接下创建 Agent。模型 ID 自由输入，不把会频繁
变化的型号写死在 Council 版本里。保存后，后续调用和失败运行的显式恢复会读取新路由；
已经在执行中的调用不会被中途切换。在 Claude Code 里执行 `/model` 只会修改 Claude
自身的新会话默认值，不会覆盖 Council Agent 保存的模型。

远程 Provider 使用 OpenAI Chat Completions 兼容协议。API Key 保存于 macOS Keychain，不进入 Council SQLite、源码或设置 API 响应；界面只显示“是否已保存”。远程 Provider 先收到议题标题、问题、约束、本轮指令和已公开消息；需要代码证据时，模型只能调用 Council 提供的只读文件、目录和文本搜索工具。工具主机以真实路径限制当前项目，拒绝符号链接逃逸、敏感配置、Shell 和一切写操作。需要核对完整 Git diff、运行测试或修改代码的轮次仍应交给本机 Claude/Codex 或 Kimi Code ACP。

Model Router 的配置写入由桌面应用内置 sidecar 独占。同一个日志库不能同时启动第二个配置写进程；Codex/Claude 的 stdio MCP 只能读取议题、发布公开结论和 proposed 决策，不能新增、修改或删除 Provider/Agent，也不能访问 Keychain。当前 HTTP 控制面只监听 loopback，并按本机单用户场景设计，没有实例令牌；不要端口转发或暴露给其他用户。未来若支持外部客户端，必须先增加每实例随机令牌和权限校验。

完成设置后，编辑器的 `@` 补全和右侧 Agent 调用都会即时读取新的
`mentionAlias`，无需重启服务。catalog 内置 Claude、Codex、OpenAI、Kimi API、DeepSeek、
Grok、自定义兼容模板，以及 Kimi Code、Gemini CLI、Grok Build、Codex、Claude 的 ACP
模板；模板未添加时不占路由列表空间。系统 Provider 不可删除，已知模板的供应商名称和品牌不可修改。删除远程 Provider 会同步清除其受管 Keychain 凭据；Provider/Agent 使用软删除，
活动 Run 正在引用时会失败关闭。

## 模式一：两个桌面手动接力

### 第一步：在 Claude Desktop Code 发布方案

在 Claude 中说：

> 使用 council，为当前项目创建议题：“如何设计支付回调的幂等处理”。先检查项目代码，给出方案、约束、失败路径和验证方法，然后把公开结论发布到 Council。最后告诉我 topic ID。

Claude 会创建议题并写入一条 `proposal`。记下返回的 topic ID；它是两个客户端继续同一讨论的稳定标识。

### 第二步：在 Codex App 独立审查

在 Codex 中说：

> 使用 `$council` 读取 topic `<topic-id>`。检查当前项目代码，对 Claude 的方案做独立、对抗性审查，指出具体反例、并发风险、迁移风险和验证缺口，然后把批评发布回该议题。

Codex 会读取 Claude 的公开方案，检查项目证据，并发布一条 `critique`。

### 第三步：回到 Claude 回应批评

在 Claude 中说：

> 使用 council 读取 topic `<topic-id>` 的最新批评。逐项回应，必要时修订方案，并把回应作为 rebuttal 发布回 Council。

### 第四步：让 Codex 综合

回到 Codex 中说：

> 使用 `$council` 综合 topic `<topic-id>` 的方案、批评和回应。明确共识、保留分歧、推荐方案、验证步骤和回滚条件。用户尚未确认，只记录 proposed 决策。

当你明确接受方案后，在 Council 桌面端点击接受决策。MCP 工具只能记录 `proposed`，不能把
Agent 身份伪装成用户并写入 `accepted`；桌面/HTTP 用户入口确认后，议题才标记为 `decided`。

决策进入 Accepted 后，右侧会出现“实施进度”。可以先在界面添加功能项，也可以让正在实现的
Codex/Claude 调用 `council_add_work_items` 批量拆分；实现过程中用
`council_update_work_item` 更新为 `in_progress`、`blocked` 或 `completed`。每次更新必须携带
最新 `expected_version`，过期写入会被拒绝。标记完成时应在 `status_note` 写明测试、构建或交付证据。

不需要讨论的工作可以直接建任务，不必先建议题和决策：界面在“任务”页点“新建任务”，MCP 用 `council_create_task`（必填项目路径与标题）、
`council_list_tasks`、`council_get_task`，HTTP 对应 `/api/v1/tasks`。直接任务同样可以委派给 Agent
（`council_delegate_task` 或 `POST /api/v1/tasks/:taskId/delegations`），支持 `kind=code` 的代码任务与 `kind=image` 的生图任务；
生图任务先写 council-brief（新建时带 `brief`、`PUT /api/v1/tasks/:taskId` 或 MCP `council_submit_brief`），
执行者必须是本机已用 ChatGPT 登录且开启生图的 Codex，监督者可省略（默认 Claude），可带最多 8 个同项目图像资产作参考图；
产物去重入库并挂到任务，任务停在进行中等你在资产库/任务页人工验收；
MCP 的委派请求会交给本机 Council HTTP 服务执行，因此桌面 app 或 `start:http` 需要在运行。
议题实施项也会出现在同一项目的任务列表中。

资产库对 Agent 开放同样的能力：MCP 用 `council_list_assets`（`unlinked=true` 只看未挂任何目标的资产，不能与 target 过滤同用）、`council_get_asset`、`council_import_asset`（项目内相对路径）、
`council_attach_asset`（把资产挂到任务、消息或决策，角色为 reference/output/final/brief）；HTTP 对应 `/api/v1/assets`（`?unlinked=true` 同义）、
`POST /api/v1/assets/import`、`POST /api/v1/assets/upload?project=`（请求正文为图片字节，只收图片）、`POST /api/v1/assets/ingest`（`{projectPath, sourcePath}` 本机绝对路径，只收图片，桌面端“引用图片”用）、`/api/v1/assets/:assetId`（`/content` 取原文件、`/thumbnail` 取缩略图、`/links` 管理挂接，`DELETE` 软删除）。
消息正文里的 `council-asset:<资产 ID>` 引用在发布时自动挂到该消息；`GET /api/v1/topics/:topicId/files/image?href=<项目内相对路径>` 只读出站项目内图片供消息内嵌，不入库。
入库按文件头嗅探类型，只接受 `COUNCIL_ASSET_MIME_ALLOWLIST` 内的类型，单文件与总量受 `COUNCIL_ASSET_MAX_BYTES`、
`COUNCIL_ASSET_MAX_TOTAL_BYTES` 限制；文件按内容哈希存放在 `COUNCIL_ASSET_DIR`（留空为日志库下的 `assets` 子目录），
缩略图由 `COUNCIL_ASSET_THUMBNAIL_COMMAND` 生成并缓存。资产只属于一个项目，跨项目不可见。

流水线也能从 Agent 侧发起：MCP 用 `council_start_pipeline`（`project_path`、`template` 取 `app-mockup`/`game-asset-pack`/`concept-sheet`、`goal`，可选 `constraints`、`reference_asset_ids`）与 `council_get_pipeline`（`pipeline_id`，返回阶段进度、简报与复盘记录、子任务和产物 ID）；HTTP 对应 `POST /api/v1/pipelines`、`GET /api/v1/pipelines?project=`、`GET /api/v1/pipelines/:pipelineId`，人工节点经 `POST …/:pipelineId/brief`（确认简报）、`…/final`（选定终稿）、`…/resume`（重跑失败阶段）、`…/cancel`，写操作都带父任务 `expectedVersion`，过期返回 `409`。两个 MCP 工具同样转发给本机 Council HTTP 服务，确认简报与选定终稿只在 WebUI 完成。阶段数上限 `COUNCIL_PIPELINE_MAX_STAGES`、自动修订轮数 `COUNCIL_PIPELINE_MAX_REVISIONS`（默认 3）与原型委派权限档 `COUNCIL_PIPELINE_PROTOTYPE_PERMISSION`（默认 `workspace_write`）可在 `.env` 调整。

如果实现、验证或部署已经在 Council 外完成，不必再叫 Agent 总结：打开该议题的“决策”页，
点击“记录人工决策”，填写最终结论和可选的验证/部署说明，再点击“记录并结束议题”。Council
会以 Human 身份直接写入 `accepted`，关闭圆桌、持久会话和后续 Agent 入口；整个过程不会创建
Run，也不会产生模型调用或额度消耗。

## 模式二：Codex 自动调用 Claude

这种模式不需要切换窗口，但 Codex 会在后台调用 Claude Code CLI。

### 一次性准备

在终端完成 Claude Code 登录：

```bash
claude auth login
```

登录后，可以在 Codex App 中先检查：

> 使用 `$council` 检查后台 Claude 顾问是否已安装并登录。

### 发起自动讨论

在 Codex App 中说：

> 使用 `$council` 对当前项目的“是否把订单状态机改成事件驱动”进行自动架构讨论。让 Claude 先独立提案；你检查真实代码并批评；再让 Claude 回应；最后综合方案、风险、验证和回滚条件。未经我确认，只记录 proposed 决策。

Council 会按以下顺序执行：

1. 创建议题。
2. 后台 Claude 独立提出方案。
3. Codex 检查项目并发布批评。
4. Claude 阅读批评并回应。
5. Codex 综合结果并记录候选决策。

后台 Claude 默认以规划权限运行。架构讨论本身不应直接修改项目代码。

## 模式三：Operator Console 自动轮次

首次安装：

```bash
npm run install:all
cp packages/mcp-server/.env.example packages/mcp-server/.env
cp packages/web/.env.example packages/web/.env.local
```

编辑两个本地环境文件：

- API 的 `COUNCIL_DATA_DIR` 必须与 Codex、Claude MCP 配置使用同一数据目录。
- 两个 stdio MCP 进程还必须分别显式配置调用者：Codex 使用
  `COUNCIL_CALLER_ACTOR_ALIAS=codex`，Claude 使用
  `COUNCIL_CALLER_ACTOR_ALIAS=claude`。该身份不会由工具参数覆盖。
- Web 的 `VITE_COUNCIL_DATA_MODE` 设为 `http`。
- `VITE_COUNCIL_API_URL` 填写本地 API origin。
- `VITE_COUNCIL_PROJECT_PATH` 填写当前项目的绝对路径；Web 新建议题会把它保存为 Claude 的可信工作目录。
- `COUNCIL_HTTP_CORS_ORIGINS_JSON` 精确列出 WebUI origin。

然后运行：

```bash
npm run dev
```

浏览器打开终端输出的 Web 地址。页面可以搜索和切换议题、发布消息、创建议题及确认决策。图标栏底部的「模型与 Provider 设置」管理模型和 Provider，「偏好」管理主题、语言与圆桌轮次上限；单次 Agent 调用统一从 Composer 输入 `@Agent` 发起，多 Agent 自动互审从右侧「上下文」栏的“圆桌讨论”发起。存在调用或持久会话时，「上下文」栏的自动轮次区块提供取消、失败恢复、历史和会话关闭；没有调用时该区块不占空间。

启动、恢复和批准只完成原子状态转换后就返回，Agent 在后台继续执行；浏览器刷新或 HTTP 连接断开不会取消任务。显式取消会使持有 lease 的执行者终止 CLI，版本 CAS 会拒绝迟到回复。进程重启时，`running` 可以安全续跑；中断在 `waiting_agent` 的调用不会自动重放，而会转成需要人工恢复的失败状态。

HTTP 模式只加载议题列表、当前议题详情和当前议题的运行列表。内容与编排使用独立 revision 校准，lease 心跳不会触发页面请求风暴。

只想查看视觉原型时，将数据模式保持为 `mock` 并运行 `npm run dev:web`。

只要任一 Agent 把回复发布到同一 topic，SQLite revision 会通过 SSE 通知 WebUI，页面自动更新，不需要你再复制粘贴或手动刷新。Web 与 Council 桌面应用都能主动调用已启用的 Agent；普通数据库消息仍不会自动唤醒另一个闲置的 Codex App 或 Claude Desktop 私有会话。

## 继续已有议题

知道 topic ID 时，直接指定：

> 使用 `$council` 继续 topic `<topic-id>`，读取最新消息并处理尚未解决的分歧。

不知道 topic ID 时：

> 使用 `$council` 列出当前项目最近的 open 议题，包括标题、更新时间和 topic ID。

跨项目使用时，要明确项目绝对路径：

> 使用 `$council` 列出项目 `<项目绝对路径>` 的最近议题。

如果通过兼容 MCP 工具直调的后台 Claude 会话明显串题或保留了错误上下文：

> 使用 `$council` 重置 topic `<topic-id>` 的 Claude 顾问会话。不要删除议题和已有消息。

Operator Console 会显示每个 Agent 当前逻辑绑定的状态。手动关闭后可以重新打开，但会创建新的绑定和新 session，旧绑定只保留为审计记录。接受议题决策、修改模型/Provider 配置或达到空闲超时时，系统会自动关闭相关绑定；兼容 OpenAI 协议的远程 Provider 仍是无状态调用。

## 常用提示词

### 创建架构议题

> 使用 `$council` 为当前项目创建一个议题。问题是：`<问题>`。约束：`<约束>`。验收标准：`<验收标准>`。检查真实代码后发布你的 proposal。

### 审查另一模型的方案

> 使用 `$council` 读取 topic `<topic-id>`，不要默认同意现有方案。根据代码、测试和不变量找出具体失败路径，并发布 critique。

### 讨论 Bug 根因

> 使用 `$council` 创建 Bug 诊断议题。先写清预期行为、实际行为、证据和根因假设，再让 Claude 与 Codex 分别验证。不要在根因未证实时记录 accepted 决策。

### 比较多个技术方案

> 使用 `$council` 比较 `<方案 A>`、`<方案 B>` 和 `<方案 C>`。要求双方分别评估复杂度、性能、安全、迁移、可测试性和回滚成本，最后保留仍未证实的假设。

### 只读取，不写入

> 使用 `$council` 读取 topic `<topic-id>` 并向我总结，不发布新消息，不记录决策。

### 查看总体状态

> 使用 `$council` 告诉我当前有多少议题、消息、决策和实施项。

### 继续实现并回写进度

> 使用 `$council` 读取 topic `<topic-id>` 的 Accepted 决策和实施项。实现尚未完成的项目；开始时标记 `in_progress`，受阻时记录具体依赖，代码与必要验证都完成后再标记 `completed` 并附验证证据。

## 议题和决策规则

- 一个 topic 只解决一个具体决策；无关问题应新建议题。
- `proposal` 是方案，`critique` 是具体批评，`rebuttal` 是回应，`synthesis` 是综合。
- 用户未明确接受时，决策状态必须是 `proposed`。
- `accepted` 表示已经确认采用，不是“两个模型看起来意见一致”。
- 实施项只绑定 Accepted 决策；`completed` 表示对应交付已真实完成并有证据，不表示“已经决定要做”。
- 外部工作已经完成时，可以由用户在“决策”页直接记录人工 `accepted` 并结束议题，无需先生成 Agent 决策。
- 长期有效的最终结论应同步写入项目 ADR 或架构文档；SQLite 讨论记录不是项目文档的替代品。

## 隐私边界

Council 只共享 Agent 主动发布的内容，不共享隐藏推理和完整聊天历史。发布内容前应删除：

- API key、Token、账号密码和私有凭据。
- 真实用户身份信息。
- 私有网络、服务器和 SSH 配置细节。
- 与架构决策无关的原始日志。

运行数据由 `COUNCIL_DATA_DIR` 指定，位于源码目录之外，不应提交 Git。

## 故障排查

### 找不到 `$council`

重启桌面应用或新建任务。Skill 在任务启动时加载，已经打开的旧任务不一定立即刷新名称。

### MCP 没有连接

在终端检查两个客户端的用户级配置：

```bash
claude mcp get council
codex mcp get council
```

Claude 应显示 `Connected`，Codex 应显示 `enabled: true`。
若日志提示缺少 `COUNCIL_CALLER_ACTOR_ALIAS`，分别在两个客户端的 MCP 环境配置中绑定
`claude` / `codex`，不要让它们共用同一个调用者值。

### 手动接力正常，但自动 Claude 不可用

检查登录状态并重新登录：

```bash
claude auth status
claude auth login
```

这不会影响双桌面手动接力；只影响 `council_ask_claude` 后台调用。

### 找不到以前的议题

先让 Agent 读取 Council 总体状态，再确认两个客户端使用相同的 `COUNCIL_DATA_DIR`。不要新建空数据库覆盖原数据。

### WebUI 显示 API 离线

依次确认：

1. API 与 MCP 使用相同的 `COUNCIL_DATA_DIR`。
2. HTTP host 是 loopback 主机，API 进程已经启动。
3. Web API origin 与 HTTP CORS 白名单精确匹配。
4. `VITE_COUNCIL_PROJECT_PATH` 是存在的项目绝对路径。
5. 修改环境文件后已经重启对应开发进程。

### 自动轮次显示 Agent 不可用

确认对应 CLI 已安装并登录。创建运行时会强制复检能力，通常不必重启服务：

```bash
claude auth status
codex login status
```

如果失败卡片提供“恢复”，表示故障被判定为临时失败，可直接恢复。兼容 Provider 会显示脱敏后的 HTTP 原因：401/403 表示认证或模型权限，402 表示 API 额度，429 表示请求速率、Token 速率、并发或账户限制，5xx 表示服务暂时不可用；其他 4xx 应检查模型 ID、API 地址和参数兼容性。登录、模型权限或最终正文超限等确定性错误需要先修正配置。

远程 Provider 则在「模型与 Provider 设置」中确认模型、API Base URL、API Key 和“启用”状态，然后执行连接测试。连接测试不会回显上游响应正文或 API Key。

### 资产导入被拒绝

`415` 表示文件头不是允许的类型（扩展名不算数，改名的文本文件仍会被拒）；`413` 表示超出单文件或总量配额，
调大 `COUNCIL_ASSET_MAX_BYTES` / `COUNCIL_ASSET_MAX_TOTAL_BYTES` 后重启服务；`403` 表示路径越出项目目录或是符号链接，
把文件复制进项目后再导入。缩略图返回 `404` 多半是 `COUNCIL_ASSET_THUMBNAIL_COMMAND` 不可用或超时，原文件仍可经 `/content` 读取。
编辑器“引用图片”与粘贴上传走同一套校验：非图片 `415`、超限 `413`；桌面端本机图片入库对符号链接与非普通文件返回 `403`。
消息里项目内相对路径的图片显示“加载失败”时，多半是路径越出项目（`403`）、文件不存在（`404`）或不是图片（`415`），可用该议题的项目文件预览确认路径；显示“需连接项目后查看”表示当前是演示模式或本地服务未启动。

### 图像任务的简报被拒绝

新建图像任务、`PUT /api/v1/tasks/:taskId` 或 `council_submit_brief` 返回 `400 council-brief 无效：<字段路径>: <原因>` 时按字段路径改简报：
`style.palette` 是一段文字而不是数组，交付物的 `size` 写成 `宽x高`、`id` 不能重复、`count` 不超过 16。委派时报“图像任务需要先提交 council-brief”
说明任务还没有通过校验的简报，先补简报再委派；代码任务的简报不做协议校验，只限制是 JSON 对象且不超长。

### 流水线创建返回 409 或 503

`503 流水线需要本地 Agent 服务，当前未启用。` 表示桌面 app 或 `start:http` 没有在运行，先启动再试。`409` 带 Agent 提示时按文案处理：写简报与复盘需要已启用、已填写模型且可用的 Claude CLI（Claude Agent 模型留空时不算可用，先在“模型与 Provider 设置”里填写），出图需要通过生图探针（本机 ChatGPT 登录）的 Codex，可在“模型与 Provider 设置”里启用后重试，或在新建对话框里显式指定。确认简报返回 `400` 时按字段路径修改简报（规则同图像任务；交付物 count 合计不能超过 `COUNCIL_CODEX_IMAGE_MAX_OUTPUTS`，默认 16 张，Claude 写的草稿超限会直接让 brief 阶段失败，“恢复”即重写）；阶段显示“失败”时先看阶段错误码：`image_unavailable` 带 Codex 侧原因，其中“生图超时”按每张约 1 分钟估算，交付物多时调大 `COUNCIL_CODEX_IMAGE_TIMEOUT_MS`（默认 15 分钟）或在简报里减张数，`outputs_missing` 多为 Codex 只给了清单没写文件，`manifest_invalid` 是清单损坏或答非所问（已找到的图仍会入库挂在出图子任务上，但复盘只看重跑后那一次的产物，之前的图只出现在并排对比里），`interrupted` 是服务重启时该阶段正在跑，三者都可直接“恢复”；原型阶段的 `execution_checkpoint`（以及 `execution_no_progress` 等交接类错误）表示 Agent 已把代码存在隔离工作区并停下，常见原因是沙箱不允许起服务或浏览器做验证，“恢复”会从交接点接续而不是重做（`review_revision_limit`：Agent 审核在修订轮次内没通过，提交与审核意见都保留，“恢复”同样接续原工作区按上次审核继续改）；原型任务说明已要求 Agent 遇到沙箱拒绝时不停下等放行、把未验证项写进收尾说明交人工验收，要让 Agent 自己起服务和浏览器验证，可把 `COUNCIL_PIPELINE_PROTOTYPE_PERMISSION` 设为 `danger_full_access`（Codex 将不带沙箱运行，执行 Agent 的权限档也得是该档，只建议在隔离机器上开）；复盘轮数用尽会停在“选定”等你定夺。

### `@claude` 已识别但运行失败

先在 Model Router 中确认 Claude Agent 的模型，并点击“测试”。Council 保存的模型优先于 Claude Code 交互会话里的 `/model` 默认值。额度不足、模型无权限等确定性错误不会继续盲目重试；修改模型后可从失败卡片显式恢复。Council 默认连续 5 分钟没有协议、工具或文本活动才判定空闲超时；只要 Agent 仍在工作就可继续，单次调用仍受 60 分钟绝对上限保护。

### `@codex` 已识别但运行失败

消息中的 `@codex` 芯片和运行卡片说明召唤语法已经解析成功，问题发生在 CLI 调用阶段。先确认本地 Agent 服务在线和 `codex login status` 正常，再查看运行是否允许“恢复”。Codex 的 JSONL 过程事件采用有界截断，最终正文单独限长；每个合法 JSONL 事件都会刷新 5 分钟无活动计时器，但不能越过 60 分钟绝对上限。仍可在运行卡片中手动取消，两项上限均由环境配置统一注入。本地日志只保留脱敏诊断码，不记录 prompt、项目路径或 CLI stderr。

### Claude 回答与议题无关

在 Agent 调用面板关闭对应持久会话后再“重新打开”，下一次调用会用完整问题、约束和公开记录创建新 session。关闭或重开不会删除既有议题、消息、决策和旧绑定审计记录。

同一议题的同一 Agent 会复用自己的逻辑 session；切换到另一个议题会创建独立绑定，绝不会借用前一议题的 session。调用开始后新到达的消息不会被提前标记为已读，下一轮仍会作为增量发送。成功回复会原子记录本次 human 请求的消费凭证，重复点击或重放同一请求会在再次调用模型前被拒绝。

若取消、失败清理导致 session 失效，Council 会同时清空增量游标，下一次调用重新发送完整公开上下文。服务重启时只有仍可恢复的 session 才沿用增量；缺失 session 一律回到完整上下文。议题接受决策后不能再启动 Agent 或重开持久会话，如需继续讨论应显式创建新议题。
