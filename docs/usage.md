# Council 使用指南

Council 让 Codex App 与 Claude Desktop Code 共享经过整理的架构议题、方案、批评和决策。它不会读取或合并两个桌面应用的完整私有聊天记录。

## 目录

- [先选使用模式](#先选使用模式)
- [首次使用](#首次使用)
- [模式一：两个桌面手动接力](#模式一两个桌面手动接力)
- [模式二：Codex 自动调用 Claude](#模式二codex-自动调用-claude)
- [查看 WebUI 原型](#查看-webui-原型)
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

日常建议优先使用双桌面手动接力。你仍然使用熟悉的两个桌面界面，只是不再复制粘贴内容。

## 首次使用

1. 重启 Codex App 和 Claude Desktop，或分别新建一个任务，让客户端重新加载 `$council` Skill 和 `council` MCP。
2. 在两个客户端中打开同一个项目。
3. 让第一个 Agent 创建议题时写入项目绝对路径、问题、约束和验收标准。

可以先检查状态：

> 使用 `$council` 检查 Council 状态，并告诉我 MCP 是否正常。

如果只使用双桌面接力，到这里就可以开始，不需要打开终端。

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

## 查看 WebUI 原型

首次安装并启动：

```bash
npm run install:web
npm run dev:web
```

浏览器打开终端输出的本地地址。当前原型可以搜索和切换议题、发布消息、创建议题及确认决策，所有数据来自内存中的 mock repository，刷新后会恢复示例数据。

当前页面上的“自动同步”表示前端订阅接口已经就位，不代表已经连通 Claude、Codex 或 SQLite。后续接入本地 API 后，只要任一 Agent 把回复发布到同一 topic，WebUI 就能自动更新，不需要你再复制粘贴；如果没有开启自动编排，你仍需在另一个客户端发一句“继续这个 topic”来唤醒它。

## 继续已有议题

知道 topic ID 时，直接指定：

> 使用 `$council` 继续 topic `<topic-id>`，读取最新消息并处理尚未解决的分歧。

不知道 topic ID 时：

> 使用 `$council` 列出当前项目最近的 open 议题，包括标题、更新时间和 topic ID。

跨项目使用时，要明确项目绝对路径：

> 使用 `$council` 列出项目 `<项目绝对路径>` 的最近议题。

如果后台 Claude 会话明显串题或保留了错误上下文：

> 使用 `$council` 重置 topic `<topic-id>` 的 Claude 顾问会话。不要删除议题和已有消息。

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

### Claude 回答与议题无关

让 Council 重置该 topic 的 Claude 顾问 session，然后用完整问题、约束和项目路径重新询问。重置 session 不会删除既有议题、消息和决策。
