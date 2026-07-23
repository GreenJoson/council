# Council

Council 是一个本地、可追踪的多 Agent 架构讨论项目。它让 Codex App、Claude Desktop Code 和可选的 Claude Code CLI 围绕同一议题交换公开方案、批评、反驳和决策，避免人工复制粘贴。

> ⚠️ 任何功能、架构或写法更新后，必须同步更新相关目录的 `_README.md` 和本文件。

## 架构

```text
Codex App ───────┐
                 ├── Council MCP ─────────────── SQLite
Claude Desktop ──┘                │
                                  └── Claude/Codex CLI + 兼容模型 API

浏览器 ───────────── Operator Console ── REST/SSE ─┘

Council.app ───────── React UI ── Tauri IPC ── Rust council-core ── SQLite
        └──────────── 内置 Agent Service sidecar ── ExecutionManager ── Claude/Codex CLI

Operator Console ──运行 REST──> ExecutionManager ──> ClaudeRuntime / CodexRuntime
                                      │
                                      └── SQLiteCouncilStore / lease fencing

全局 Skill ──软链──> skills/council
```

- `skills/council/`：Agent 触发规则、协作流程和讨论协议。
- `packages/mcp-server/`：MCP、版本化本地 API、SSE、SQLite 和 Claude/Codex 后台适配器。
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
- Operator Console 与桌面应用可创建、启动、批准、取消和恢复 Claude/Codex 自动轮次。
- 中央 Claude/Codex 消息列随大屏流体扩展，为代码、表格和架构图释放空间；普通正文继续保持可读行长。
- 消息图片和 Mermaid 图以固定缩略尺寸展示，点击后进入支持缩放与滚动的全视口大图浏览；长卡片在正文底部展开或收起。
- 讨论区左侧按消息卡数量显示一一对应的阶梯节点，可直接跳转到任意卡片并跟随滚动高亮当前位置。
- 顶栏模型路由台可即时切换 Claude/Codex 模型；DeepSeek、Kimi 等兼容 Provider 按需添加，右侧一次只编辑一项，候选数量不会撑高设置窗口。
- 远程 API Key 只保存在 macOS Keychain；SQLite 和设置响应只保存/返回非敏感配置及是否已配置凭据。
- 提供 SQLite 持久化运行、人工批准、进程重启恢复、lease/epoch fencing 和同议题单活动运行约束。
- 自动轮次使用无 session 的公开上下文；取消、超时和 lease 丢失会终止后台 CLI，迟到回复不能写入。
- Agent 失败只向运行卡片暴露显式脱敏的原因；未登录、额度不足、模型不可用和工具回合耗尽可直接辨认，原始上游输出不会进入议题记录。
- 桌面安装包内置 Agent Service，打开 App 自动启动、退出自动回收；无需手动运行 Node/npm 或常驻 API 服务。
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

桌面开发使用 `npm run dev:desktop`；正式构建使用 `npm run build:desktop`。两条命令都会先生成内置 Agent Service sidecar；构建配置固定在 `packages/desktop/sidecar-build.json`，下载的官方 Node 运行时必须通过锁定的 SHA-256 校验。安装后的 Council.app 打开即自动启动 sidecar，不需要 Node/npm。首次启动时只需选择日志库和项目目录；MCP 客户端仍应把 `COUNCIL_DATA_DIR` 指向同一日志库。

## 使用方式

最短用法是在 Claude Desktop Code 中发布方案：

> 使用 council，把当前架构方案发布到 Council，并告诉我 topic ID。

再到 Codex App 中审查：

> 使用 `$council` 读取 topic `<topic-id>`，检查项目代码，审查方案并把 critique 发布回去。

自动调用后台本机 Agent 前，需要先完成对应 Claude Code CLI 或 Codex CLI 登录。手动双桌面接力不依赖 CLI 登录。Council 桌面应用的 `@codex` 会启动一个新的只读 Codex CLI 轮次并把回复自动写回当前议题；它不会控制或续接另一个已经打开的 Codex App 私有任务。启用远程 Provider 后，可用 `@deepseek`、`@kimi` 或自动轮次面板调用；远程 Provider 只接收 Council 已公开上下文，不会直接读取项目文件。

完整步骤、提示词模板和故障排查见 [Council 使用指南](docs/usage.md)。

## WebUI 设计探索

第一轮包含三种信息架构。当前已选择方案 A，并完成深色 Operator Console、真实 REST/SSE 数据层及 Tauri 桌面适配；设计稿、实现截图与取舍见 [WebUI 设计方向](docs/designs/ui-directions.md)。

当前边界：消息传播与后台 Agent 触发仍是两个独立能力。只有在 Composer 中明确写 `@claude` 或 `@codex`，或在自动轮次面板创建运行，系统才会调用对应 CLI；普通消息只写入共享议题。Agent 回复不会自动标记为 `accepted`。

## 后续演进

优先顺序建议：

1. 将最终决策导出为项目 ADR。
2. 增加运行审计视图和跨项目筛选，不把协议绑定到单一模型。
3. 增加运行诊断日志入口和自定义 Provider 增删界面。
4. 在保持只读沙箱与恢复语义的前提下，评估 Agent session 续接。
