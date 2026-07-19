# Council

Council 是一个本地、可追踪的多 Agent 架构讨论项目。它让 Codex App、Claude Desktop Code 和可选的 Claude Code CLI 围绕同一议题交换公开方案、批评、反驳和决策，避免人工复制粘贴。

> ⚠️ 任何功能、架构或写法更新后，必须同步更新相关目录的 `_README.md` 和本文件。

## 架构

```text
Codex App ───────┐
                 ├── Council MCP ─────────────── SQLite
Claude Desktop ──┘                │
                                  └── Claude Code CLI（可选自动顾问）

浏览器 ───────────── Operator Console ── REST/SSE ─┘

Council.app ───────── React UI ── Tauri IPC ── Rust council-core ── SQLite

Operator Console ──运行 REST──> ExecutionManager ──> ClaudeRuntime
                                      │
                                      └── SQLiteCouncilStore / lease fencing

全局 Skill ──软链──> skills/council
```

- `skills/council/`：Agent 触发规则、协作流程和讨论协议。
- `packages/mcp-server/`：MCP、版本化本地 API、SSE、SQLite 和后台 Claude 适配器。
- `packages/web/`：方案 A 的 React Operator Console，支持显式 `mock` 或真实 `http` 数据模式。
- `packages/desktop/`：Tauri 2 桌面壳、本机日志库设置、原生项目切换和 Rust IPC。
- `crates/council-core/`：与现有 TypeScript schema 同构的 Rust SQLite 内容核心。
- `packages/orchestrator/`：与具体模型解耦的受控轮次状态机和适配器接口。
- 运行数据：由 `COUNCIL_DATA_DIR` 指定，始终放在源码目录之外，不提交 Git。

## 当前能力

- 创建、查询和分页列出架构议题。
- 发布带类型的方案、批评、反驳、综合与备注。
- 记录可追踪的架构决策及其状态。
- 让多个 MCP 客户端共享同一份本地 SQLite 数据。
- 可选通过兼容 MCP 工具调用 Claude Code CLI，并保留该直调工具的顾问 session。
- 明确隔离私有聊天历史，只共享主动发布的公开结论与证据。
- 提供安全的 loopback REST API 和跨进程 SQLite revision 事件流。
- Operator Console 可读取真实议题；Agent 写回同一 topic 后页面自动刷新，无需复制粘贴。
- Operator Console 可创建、启动、批准、取消和恢复 Claude 自动轮次。
- 提供 SQLite 持久化运行、人工批准、进程重启恢复、lease/epoch fencing 和同议题单活动运行约束。
- Claude 自动轮次使用无 session 的公开上下文；取消、超时和 lease 丢失会终止后台 CLI，迟到回复不能写入。
- 提供无需手动启动 Web/API 服务的桌面模式；桌面端直接通过 Rust 读取共享 SQLite。
- 桌面端可用原生目录选择器设置日志库和切换项目，设置只保存在操作系统应用配置目录。
- 桌面端使用独立的多 Agent 圆桌图标，并生成各平台所需的打包尺寸。

## 开发

```bash
npm run install:all
npm run check
npm test
npm run test:e2e
npm run audit
npm run build:desktop
```

`test:e2e` 需要本机已安装 Python Playwright 及 Chromium；它使用临时 SQLite 和测试专用 Claude CLI 协议替身，不读写日常 Council 数据，也不产生真实模型费用。

真实数据模式需要先分别复制并填写两个包的环境文件：

```bash
cp packages/mcp-server/.env.example packages/mcp-server/.env
cp packages/web/.env.example packages/web/.env.local
npm run dev
```

API 的 `COUNCIL_DATA_DIR` 必须与 Codex、Claude MCP 使用同一目录；Web 数据模式改为 `http`，`VITE_COUNCIL_PROJECT_PATH` 填当前项目绝对路径，API origin 与 CORS 白名单必须精确匹配。`npm run dev` 会先构建编排包，再同时启动 API 与 WebUI。单独运行可使用 `npm run dev:api` 或 `npm run dev:web`。

Node 与 React 构建产物位于各包的 `dist/`。Codex 和 Claude 的 MCP 配置应调用 MCP 构建产物，并通过环境变量注入数据目录和运行参数。

桌面开发使用 `npm run dev:desktop`；正式构建使用 `npm run build:desktop`。桌面内容读写不依赖本地 HTTP 服务。首次启动时选择日志库和项目目录；MCP 客户端的 `COUNCIL_DATA_DIR` 必须指向同一日志库，才能继续共享议题。

## 使用方式

最短用法是在 Claude Desktop Code 中发布方案：

> 使用 council，把当前架构方案发布到 Council，并告诉我 topic ID。

再到 Codex App 中审查：

> 使用 `$council` 读取 topic `<topic-id>`，检查项目代码，审查方案并把 critique 发布回去。

自动调用后台 Claude 前，需要先完成 Claude Code CLI 登录。手动双桌面接力不依赖 CLI 登录。Web 能主动调用 Claude；Codex App 当前没有经过验证的后台唤醒接口，仍通过 Council MCP 参与和自动传播公开回帖。

完整步骤、提示词模板和故障排查见 [Council 使用指南](docs/usage.md)。

## WebUI 设计探索

第一轮包含三种信息架构。当前已选择方案 A，并完成深色 Operator Console、真实 REST/SSE 数据层及 Tauri 桌面适配；设计稿、实现截图与取舍见 [WebUI 设计方向](docs/designs/ui-directions.md)。

当前边界：消息自动传播与后台 Claude 自动触发是两个独立能力。浏览器 HTTP 模式已有 Claude 自动轮次；桌面 V1 先提供共享内容读写和项目切换，自动轮次明确显示不可用。Codex 没有经过验证的后台适配器；系统不会伪装成已经唤醒 Codex，也不会把模型输出自动标记为 `accepted`。

## 后续演进

优先顺序建议：

1. 把受控 Claude Runtime 迁到 Rust 桌面服务层，恢复桌面自动轮次。
2. 在没有可靠 Codex 后台适配器前，以人工门承接 Codex 轮次。
3. 将最终决策导出为项目 ADR。
4. 增加运行审计视图和跨项目筛选，不把协议绑定到单一模型。
5. 如果未来出现稳定的 Codex 外部触发接口，再实现真实适配器和对应取消语义。
