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
| 桌面工作台 | 希望双击启动、原生切项目并用 `@claude` / `@codex` / `@deepseek` / `@kimi` 直召 | 内容协作不需要；直召需要相应凭据 |

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

`@codex` 调用的是本机 Codex CLI，不是当前 Codex App 里的私有任务；`@claude` 同理调用 Claude Code CLI。两者都只接收当前议题的公开上下文和项目目录，并以无 session 的独立轮次运行。

## 模型与 Provider 设置

点击顶栏齿轮打开“模型与 Provider”。设置分为两类：

- Claude Code、Codex CLI：复用本机登录，只填写模型 ID。Claude 可填写 `claude-opus-4-8`；Codex 留空时使用 CLI 默认模型。
- DeepSeek、Kimi：填写 Provider 当前公布的模型 ID、API Base URL 和 API Key，打开“启用”，保存后再点“测试”。模型 ID 是自由输入，不把会频繁变化的型号写死在 Council 版本里。

保存后，后续调用和失败运行的显式恢复会读取新模型；已经在执行中的调用不会被中途切换。在 Claude Code 里执行 `/model` 只会修改 Claude 自身的新会话默认值，不会覆盖 Council 已保存的 Claude 模型。

远程 Provider 使用 OpenAI Chat Completions 兼容协议。API Key 保存于 macOS Keychain，不进入 Council SQLite、源码或设置 API 响应；界面只显示“是否已保存”。远程 Provider 只收到议题标题、问题、约束、本轮指令和已公开消息，不能直接读取项目目录，因此需要代码证据的轮次仍建议交给本机 Claude/Codex。

完成设置后，可在编辑器使用 `@deepseek` 或 `@kimi`，也可在右侧自动轮次选择对应 Agent。新 Provider 尚未提供增删界面；当前版本先提供 DeepSeek、Kimi 两个兼容槽位，后续可在同一运行时上扩展。

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

当你明确接受方案后，再说：

> 我接受这个方案。使用 `$council` 把 topic `<topic-id>` 的最终决策记录为 accepted。

`accepted` 决策会把议题标记为 `decided`。

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

Operator Console 的受控编排 V1 不复用 session；每轮只使用已经公开到 topic 的上下文，因此不需要重置该 session。

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

先在模型设置中确认 Claude 模型，并点击“测试”。Council 保存的模型优先于 Claude Code 交互会话里的 `/model` 默认值。额度不足、模型无权限等确定性错误不会继续盲目重试；修改模型后可从失败卡片显式恢复。Claude 与编排单轮默认超时均为 10 分钟，避免代码分析在 3 分钟处被内部运行时提前终止。

### `@codex` 已识别但运行失败

消息中的 `@codex` 芯片和运行卡片说明召唤语法已经解析成功，问题发生在 CLI 调用阶段。先确认本地 Agent 服务在线和 `codex login status` 正常，再查看运行是否允许“恢复”。Council `0.3.1` 起，Codex 的 JSONL 过程事件采用有界截断，最终正文单独限长，长过程不会再被误判为正文超限；默认 Agent/Codex 超时为 10 分钟，仍可在运行卡片中取消或通过环境变量覆盖。本地日志只保留脱敏诊断码，不记录 prompt、项目路径或 CLI stderr。

### Claude 回答与议题无关

如果使用兼容 MCP 直调工具，让 Council 重置该 topic 的 Claude 顾问 session，然后用完整问题、约束和项目路径重新询问。Operator Console 自动轮次没有私有 session，应检查 topic 的公开问题、约束、本轮指令和项目路径。重置 session 不会删除既有议题、消息和决策。
