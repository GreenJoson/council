# Architecture Council

Architecture Council 是一个本地、可追踪的多 Agent 架构讨论项目。它让 Codex App、Claude Desktop Code 和可选的 Claude Code CLI 围绕同一议题交换公开方案、批评、反驳和决策，避免人工复制粘贴。

> ⚠️ 任何功能、架构或写法更新后，必须同步更新相关目录的 `_README.md` 和本文件。

## 架构

```text
Codex App ───────┐
                 ├── Architecture Council MCP ── SQLite
Claude Desktop ──┘                │
                                  └── Claude Code CLI（可选自动顾问）

全局 Skill ──软链──> skills/architecture-council
```

- `skills/architecture-council/`：Agent 触发规则、协作流程和讨论协议。
- `packages/mcp-server/`：MCP 工具、SQLite 持久化和后台 Claude 适配器。
- 运行数据：由 `COUNCIL_DATA_DIR` 指定，始终放在源码目录之外，不提交 Git。

## 当前能力

- 创建、查询和分页列出架构议题。
- 发布带类型的方案、批评、反驳、综合与备注。
- 记录可追踪的架构决策及其状态。
- 让多个 MCP 客户端共享同一份本地 SQLite 数据。
- 可选调用 Claude Code CLI，保留并恢复同一议题的顾问会话。
- 明确隔离私有聊天历史，只共享主动发布的公开结论与证据。

## 开发

```bash
npm run install:mcp
npm run check
npm test
```

构建产物位于 `packages/mcp-server/dist/`。Codex 和 Claude 的 MCP 配置应调用其中的 `src/index.js`，并通过环境变量注入数据目录和运行参数。

## 使用方式

在 Claude Desktop Code 中：

> 使用 architecture-council，把当前架构方案发布到 Council。

在 Codex App 中：

> 使用 $architecture-council，读取最近的议题，审查方案并回复。

自动调用后台 Claude 前，需要先完成 Claude Code CLI 登录。手动双桌面接力不依赖 CLI 登录。

## 后续演进

优先顺序建议：

1. 增加议题搜索、标签和项目过滤。
2. 增加本地 Web UI，查看讨论时间线和决策。
3. 将最终决策导出为项目 ADR。
4. 增加更多 Agent 适配器，不把协议绑定到单一模型。

