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

日常建议优先使用双桌面手动接力。你仍然使用熟悉的两个桌面界面，只是不再复制粘贴内容。

## 首次使用

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

桌面应用支持议题、消息、决策、项目切换、跨进程刷新和 Agent 调用。Composer 输入 `@` 后选择可用 Agent 并发布，会先保存公开消息，再创建对应后台运行；回复成功后自动回贴并完成，不需要复制、再次转发或额外批准。每次 `@` 都是独立的可审计调用，但右栏只展示一张当前调用卡，旧调用折叠在“历史调用”中。直召依赖本地 Agent 服务，界面右上角显示连接状态；离线时内容协作仍可用，但不会把 `@` 悄悄当普通消息发布。

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

## 圆桌能力与周期类型

开始圆桌时，Council 会一次性冻结参与名册、周期类型、任务需求，以及每个参与者当时的
Agent/Provider/Runtime 修订和实际授权能力。运行期间修改模型或 Provider 不会改写已经开始的
cycle；服务重启后仍从冻结快照恢复，不再从消息里猜这是普通讨论还是修复互审。

- 普通讨论：只要求公开文本能力。
- bug 修复互审：修复必须先由 Codex App、Claude Code 等交互式开发任务完成并提供真实
  commit；Council 圆桌只读核对该 commit/diff。参与者需要仓库读取和 diff 能力，但不会
  获得修改文件、写 Shell、运行写操作、创建提交、推送或部署权限。
- 附件任务：可以额外声明媒体读取、视觉等能力。

若任何参与者缺少所需能力，Council 会在启动模型前直接列出缺口，不消耗额度，也不允许
模型声称执行了未授权操作。Claude/Codex resume Runtime 和获授权的 ACP Runtime 具备
只读项目与已提交 diff 能力；Kimi API、DeepSeek 等兼容 API Runtime 通过 Council ToolLoop
获得受控 `repository_read + git_diff`，可读文件、列目录、搜索文本和指定 commit/ref 的
安全 diff，但没有未提交工作区读取、Shell、写文件、提交、推送或部署能力。
工具事件不能自报权限：模型只返回工具名与参数，Council 从本地 ToolHost 注册表解析所需
能力；未注册工具在执行前失败关闭。

轮次预算耗尽时，界面会显示结构化的阻断分歧与停止原因。新发言如果缺少
`council-verdict` 尾块，会按阻断处理并计入“缺少 verdict”度量，避免协议失效却继续显示
为已收敛。

## 模型与 Provider 设置

点击顶栏齿轮打开 Model Router。设置明确分为两层：

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

浏览器打开终端输出的 Web 地址。页面可以搜索和切换议题、发布消息、创建议题及确认决策。顶栏齿轮管理模型和 Provider；右侧“Agent 调用”卡片显示所有 Agent 的实时可用性。配置完成后可以输入本轮指令并“启动 Agent”；默认在回复成功后自动完成。只有显式勾选“完成前需要我确认”时，运行才会暂停并显示“确认并完成”；活动运行可以取消，临时失败在恢复预算内可以恢复。

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

> 使用 `$council` 告诉我当前有多少议题、消息和决策。

## 议题和决策规则

- 一个 topic 只解决一个具体决策；无关问题应新建议题。
- `proposal` 是方案，`critique` 是具体批评，`rebuttal` 是回应，`synthesis` 是综合。
- 用户未明确接受时，决策状态必须是 `proposed`。
- `accepted` 表示已经确认采用，不是“两个模型看起来意见一致”。
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

如果失败卡片提供“恢复”，表示故障被判定为临时失败，可直接恢复；登录、模型权限或最终正文超限等确定性错误需要先修正配置。

远程 Provider 则在顶栏齿轮中确认模型、API Base URL、API Key 和“启用”状态，然后执行连接测试。连接测试不会回显上游响应正文或 API Key。

### `@claude` 已识别但运行失败

先在 Model Router 中确认 Claude Agent 的模型，并点击“测试”。Council 保存的模型优先于 Claude Code 交互会话里的 `/model` 默认值。额度不足、模型无权限等确定性错误不会继续盲目重试；修改模型后可从失败卡片显式恢复。Claude 与编排单轮默认超时均为 10 分钟，避免代码分析在 3 分钟处被内部运行时提前终止。

### `@codex` 已识别但运行失败

消息中的 `@codex` 芯片和运行卡片说明召唤语法已经解析成功，问题发生在 CLI 调用阶段。先确认本地 Agent 服务在线和 `codex login status` 正常，再查看运行是否允许“恢复”。Council `0.3.1` 起，Codex 的 JSONL 过程事件采用有界截断，最终正文单独限长，长过程不会再被误判为正文超限；默认 Agent/Codex 超时为 10 分钟，仍可在运行卡片中取消或通过环境变量覆盖。本地日志只保留脱敏诊断码，不记录 prompt、项目路径或 CLI stderr。

### Claude 回答与议题无关

在 Agent 调用面板关闭对应持久会话后再“重新打开”，下一次调用会用完整问题、约束和公开记录创建新 session。关闭或重开不会删除既有议题、消息、决策和旧绑定审计记录。

同一议题的同一 Agent 会复用自己的逻辑 session；切换到另一个议题会创建独立绑定，绝不会借用前一议题的 session。调用开始后新到达的消息不会被提前标记为已读，下一轮仍会作为增量发送。成功回复会原子记录本次 human 请求的消费凭证，重复点击或重放同一请求会在再次调用模型前被拒绝。

若取消、失败清理导致 session 失效，Council 会同时清空增量游标，下一次调用重新发送完整公开上下文。服务重启时只有仍可恢复的 session 才沿用增量；缺失 session 一律回到完整上下文。议题接受决策后不能再启动 Agent 或重开持久会话，如需继续讨论应显式创建新议题。
