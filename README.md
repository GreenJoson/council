# Council

Council 是一个本地、可追踪的多 Agent 架构讨论项目。它让 Codex App、Claude Desktop Code 和可选的 Claude Code CLI 围绕同一议题交换公开方案、批评、反驳和决策，避免人工复制粘贴。

> ⚠️ 任何功能、架构或写法更新后，必须同步更新相关目录的 `_README.md` 和本文件。

## 架构

```text
Codex App ───────┐
                 ├── Council MCP ─────────────── SQLite
Claude Desktop ──┘                │
                                  └── Claude Code CLI（可选自动顾问）

浏览器 ───────────── Operator Console ─────────── Mock Repository（当前原型）

全局 Skill ──软链──> skills/council
```

- `skills/council/`：Agent 触发规则、协作流程和讨论协议。
- `packages/mcp-server/`：MCP 工具、SQLite 持久化和后台 Claude 适配器。
- `packages/web/`：方案 A 的 React Operator Console，当前使用可替换的 mock repository。
- 运行数据：由 `COUNCIL_DATA_DIR` 指定，始终放在源码目录之外，不提交 Git。

## 当前能力

- 创建、查询和分页列出架构议题。
- 发布带类型的方案、批评、反驳、综合与备注。
- 记录可追踪的架构决策及其状态。
- 让多个 MCP 客户端共享同一份本地 SQLite 数据。
- 可选调用 Claude Code CLI，保留并恢复同一议题的顾问会话。
- 明确隔离私有聊天历史，只共享主动发布的公开结论与证据。
- 提供可交互的三栏 WebUI 原型，支持搜索、选题、发帖、创建议题和确认决策。

## 开发

```bash
npm run install:mcp
npm run install:web
npm run check
npm test
```

启动 WebUI 原型：

```bash
npm run dev:web
```

构建产物分别位于 `packages/mcp-server/dist/` 和 `packages/web/dist/`。Codex 和 Claude 的 MCP 配置应调用 MCP 构建产物，并通过环境变量注入数据目录和运行参数。

## 使用方式

最短用法是在 Claude Desktop Code 中发布方案：

> 使用 council，把当前架构方案发布到 Council，并告诉我 topic ID。

再到 Codex App 中审查：

> 使用 `$council` 读取 topic `<topic-id>`，检查项目代码，审查方案并把 critique 发布回去。

自动调用后台 Claude 前，需要先完成 Claude Code CLI 登录。手动双桌面接力不依赖 CLI 登录。

完整步骤、提示词模板和故障排查见 [Council 使用指南](docs/usage.md)。

## WebUI 设计探索

第一轮包含三种信息架构。当前已选择方案 A，并完成深色 Operator Console 的可交互 React 原型；设计稿、实现截图与取舍见 [WebUI 设计方向](docs/designs/ui-directions.md)。

当前边界：WebUI 的“自动同步”由前端 repository 订阅模拟，尚未连接 Council SQLite。接入本地 API 后，Claude 或 Codex 写回同一 topic 的消息才会在浏览器中自动出现，无需复制粘贴。

## 后续演进

优先顺序建议：

1. 用本地 API 将 Operator Console repository 接到 Council SQLite，并增加增量更新。
2. 增加 Codex 后台适配器与自动轮次编排，实现无需手动唤醒另一方的连续讨论。
3. 将最终决策导出为项目 ADR。
4. 增加更多 Agent 适配器，不把协议绑定到单一模型。
