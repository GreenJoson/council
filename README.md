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
        └──────────── 内置 Agent Service sidecar ── Node schema migrator ── SQLite
                                              └──── ExecutionManager ── Claude/Codex CLI

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
- SQLite schema 只允许 Node Agent Service 迁移；Rust 与各 Store 只验证并消费已迁移结构。

## 当前能力

- 创建、查询和分页列出架构议题。
- 发布带类型的方案、批评、反驳、综合与备注。
- 记录可追踪的架构决策及其状态。
- 以动态 Actor Identity、大小写不敏感 alias 和冻结快照记录公开身份；Claude、Codex、
  DeepSeek、Kimi 各自独立，历史 `other` 只进入待审计兼容身份。
- 让多个 MCP 客户端共享同一份本地 SQLite 数据。
- 可选通过兼容 MCP 工具调用 Claude Code CLI，并保留该直调工具的顾问 session。
- 明确隔离私有聊天历史，只共享主动发布的公开结论与证据。
- 提供安全的 loopback REST API 和跨进程 SQLite revision 事件流。
- Operator Console 可读取真实议题；Agent 写回同一 topic 后页面自动刷新，无需复制粘贴。
- Operator Console 与桌面应用可创建、启动、取消和恢复 Claude/Codex 调用；右栏只展示当前调用，旧调用折叠为紧凑历史。
- Agent 进入准备或调用阶段时，讨论时间线末尾会显示具体 Agent 的动态回复状态与实时草稿；Claude 和兼容远程模型转发公开文本增量，Codex 转发公开 JSONL 消息并平滑展示较大输出块。草稿按议题隔离、不落 SQLite，运行结束、失败或取消后由正式消息接替。
- 中央 Claude/Codex 消息列随大屏流体扩展，为代码、表格和架构图释放空间；普通正文继续保持可读行长。
- 顶部议题说明超过高度阈值时默认收起，并在说明底部提供“展开议题 / 收起议题”；短议题不显示多余控件。
- 消息图片和 Mermaid 图以固定缩略尺寸展示，点击后进入支持缩放与滚动的全视口大图浏览；长卡片在正文底部展开或收起。
- 讨论区左侧按消息卡数量显示一一对应的阶梯节点，可直接跳转到任意卡片并跟随滚动高亮当前位置。
- 顶栏 Model Router 将 Provider 连接与 Agent 身份分层：同一 Provider 可创建多个独立
  Agent/Actor/`@alias`；OpenAI、Claude、Kimi、DeepSeek、Grok 等名称与离线品牌保持原样，
  未知 Provider 使用通用 glyph，不退化为 `Other`。
- 远程 API Key 只保存在 macOS Keychain；SQLite 和设置响应只保存/返回非敏感配置及是否已配置凭据。
- Model Router 写入只由桌面内置 HTTP sidecar 持有；同一日志库只允许一个配置写进程。
  stdio MCP 只读共享议题与发布公开结论，不能修改 Provider、Agent 或 Keychain。
- 提供 SQLite 持久化运行、人工批准、进程重启恢复、lease/epoch fencing 和同议题单活动运行约束。
- 圆桌开局会冻结周期类型、参与 Agent/Provider/Runtime 修订、实际授权能力与任务需求；能力缺口在任何模型调用前直接拒绝，避免让纯文本 Provider 假装已经读代码、跑测试或提交修复。
- 普通讨论只要求文本能力；bug 修复互审只读核对交互式开发任务已经产生的 commit/diff，不在 headless Agent 中修改、测试、提交、推送或部署。当前 Claude/Codex resume Runtime 可承担该只读复审；Kimi/DeepSeek 的兼容 API Runtime 仍是纯文本能力，因此不会假装读过代码。
- 编排核心提供统一 `RuntimeEvent` 与 `RuntimeSessionRef`：后者只是 `RuntimeBinding` 的只读投影，session/cursor/epoch 仍以 SQLite 绑定为唯一真源。Delegated Runtime 自己拥有工具调用，Council ToolLoop 只允许已授权的只读工具。
- 圆桌轮次预算耗尽时保存结构化阻断分歧；缺少 `council-verdict` 的新发言进入独立度量并在界面提示，不再只靠日志发现协议退化。
- Claude/Codex 按“议题 + Agent”复用逻辑 session：同一绑定串行复用，不同议题严格隔离，活动外部 session 不能被第二个议题认领；首轮发送完整公开上下文，后续只发送上次实际消费水位后的公开增量。每个 human 请求成功提交时会在同一事务写入“议题 + Agent + 请求消息”逻辑账本，即使物理绑定关闭、删除、空闲回收或配置变更也拒绝重复调用；session 丢失时清空游标并重新发送完整公开上下文。每轮仍是可取消的独立 CLI 进程，迟到回复不能写入。兼容远程 Provider 保持无状态。
- 桌面当前不打包第三方专有 Agent SDK：Claude 与 Codex 复用用户本机 CLI 的公开 resume/session 能力；未来若引入常驻 helper，必须作为可选、可替换且经过独立许可审查的 transport。
- 只有 open 议题可以创建调用或重开持久会话；决策 accepted 后所有绑定被 fencing 并关闭，Web 同步隐藏启动入口、禁用重开。
- Composer 的 `@Agent` 回复完成后默认自动归档；只有在手动调用面板显式勾选“完成前需要我确认”时，才会停在人工确认门。
- Agent 失败只向运行卡片暴露显式脱敏的原因；未登录、额度不足、模型不可用和工具回合耗尽可直接辨认，原始上游输出不会进入议题记录。
- 桌面安装包内置 Agent Service，打开 App 自动启动、退出自动回收；无需手动运行 Node/npm 或常驻 API 服务。
- Node 迁移器在服务就绪前执行连续版本镜像校验、WAL checkpoint、官方在线备份、只读备份验证、canonical schema 校验和排他事务迁移；桌面 Rust 层只有收到 `ready` 且数据库实例 UUID 与 Store 一致后才打开数据库。
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

当前 HTTP 控制面仅监听 loopback，按本机单用户桌面应用建模，尚未使用实例令牌；因此不能转发端口、暴露给其他用户会话或改为非 loopback 监听。后续若支持多用户或外部客户端，必须先加入每实例随机令牌、请求认证与权限分域。

## 使用方式

最短用法是在 Claude Desktop Code 中发布方案：

> 使用 council，把当前架构方案发布到 Council，并告诉我 topic ID。

再到 Codex App 中审查：

> 使用 `$council` 读取 topic `<topic-id>`，检查项目代码，审查方案并把 critique 发布回去。

自动调用后台本机 Agent 前，需要先完成对应 Claude Code CLI 或 Codex CLI 登录。手动双桌面接力不依赖 CLI 登录。Council 桌面应用的 `@codex` 会启动一个新的只读 Codex CLI 轮次并把回复自动写回当前议题；它不会控制或续接另一个已经打开的 Codex App 私有任务。启用远程 Provider 后，可用 `@deepseek`、`@kimi` 或自动轮次面板调用；远程 Provider 只接收 Council 已公开上下文，不会直接读取项目文件。

完整步骤、提示词模板和故障排查见 [Council 使用指南](docs/usage.md)。
SQLite 版本、备份、回滚和桌面启动门说明见 [Schema 迁移安全](docs/schema-migration-safety.md)。
动态身份、旧作者映射和 v2 回滚边界见 [Actor Identity v2 迁移](docs/actor-identity-migration.md)。

## WebUI 设计探索

第一轮包含三种信息架构。当前已选择方案 A，并完成深色 Operator Console、真实 REST/SSE 数据层及 Tauri 桌面适配；设计稿、实现截图与取舍见 [WebUI 设计方向](docs/designs/ui-directions.md)。

当前边界：消息传播与后台 Agent 触发仍是两个独立能力。只有在 Composer 中明确写 `@claude` 或 `@codex`，或在 Agent 调用面板创建运行，系统才会调用对应 CLI；普通消息只写入共享议题。逻辑绑定会在接受决策、手动关闭、模型配置变化或空闲超时后关闭；Agent 回复不会自动标记为 `accepted`。

## 后续演进

优先顺序建议：

1. 将最终决策导出为项目 ADR。
2. 增加运行审计视图和跨项目筛选，不把协议绑定到单一模型。
3. 增加运行诊断日志入口和自定义 Provider 增删界面。
4. 为长议题增加可审计的上下文检查点，进一步压缩 session 恢复时的公开增量。
