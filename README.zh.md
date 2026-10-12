<p align="center"><img src="packages/desktop/src-tauri/icons/128x128.png" width="80" alt="Council 图标" /></p>

# Council

**让多个编程 Agent 共同审查方案、记录决策，并凭证据交付工作的本地工作台。**

[English](README.md) · 简体中文

Council 把 Claude、Codex 和其他已配置 Agent 放进同一个项目、同一个议题。从提案、独立审查、人工决策到隔离实施，不必再靠你在聊天窗口之间反复搬运消息。

当前桌面版本为 **0.10.0**。打包配置支持 macOS Apple Silicon 和 Intel；本次版本已在 Apple Silicon 上验收。当前构建配置尚未提供 Windows、Linux 桌面安装包。

## 解决什么问题？

同时使用多个 Agent 后，协作成本往往落到了人身上：

| 痛点 | Council 的做法 |
|---|---|
| 把一个 Agent 的回答复制给另一个，费时且容易丢上下文。 | 用同一个议题保存提案、批评、回应和综合，桌面端与 MCP 客户端共同读写。 |
| 模型都说“同意”，却没人记录到底接受了什么。 | 提案保持待确认；只有用户接受后，才进入可追踪的决策包。 |
| “完成”可能只是想好了，也可能真的改过并验证了。 | 任务冻结验收条件，保留执行证据，明确完成策略；新委派默认要求人工验收。 |
| 执行失败后，不清楚改了什么，也不敢直接重试。 | 用独立 Git worktree、已记录提交和失败分类保留现场；恢复前验证提交，不盲目重放写操作。 |
| 待确认决策和受阻任务散落在不同讨论里。 | “需要我处理”按当前项目聚合可处理事项，并跳回原议题。 |

委派保留代码提交、中断后的修正草稿和审核意见。审核材料按文件组织，证据不完整时阻止通过；长任务可在有限预算内保存交接并检查实际文件进展后接续；后台 Worker 在退出桌面后继续执行活动任务，具体见[执行与恢复边界](docs/execution-delivery.md)。

长背景不会挤掉当前任务、约束和已接受结论；关键材料超限会明确拒绝派发。阶段交接即使带说明或 Markdown 包装，也仍按未完成处理，不能直接变成交付提交。

Council 把讨论记录保存在本机。调用模型时，选定的议题上下文和获授权读取的代码证据仍会发送给你选择的 Provider 或 CLI。它不会导入其他聊天应用的完整私有历史。

## 从讨论到交付

```mermaid
flowchart LR
  T[议题与约束] --> R[提案与独立审查]
  R --> D[人工接受决策]
  D --> W[任务与验收条件]
  W --> E[显式委派至隔离工作区]
  E --> V[Agent 审核与执行证据]
  V --> H[默认人工验收]
  E --> F[失败并保留提交检查点]
  F --> V
```

1. **说明问题。** 选择项目，创建议题，写清问题、约束和预期结果。
2. **独立审查。** 在编辑器中 `@Agent`、发起圆桌，或让 MCP 客户端发布各自的分析。圆桌可按运行时能力审查方案、当前工作区或冻结提交。
3. **做出决策。** 由你接受选定的决策。模型意见一致不会自动等于用户接受；也可以直接记录人工决策，不调用模型。
4. **拆分任务。** 手动添加实施项，或显式让 Agent 为已接受决策生成计划。接受决策不会自动启动实施。
5. **明确委派。** 选择执行者、审核者、权限、验收标准和完成策略。支持单项委派和串行批量委派。
6. **凭证据验收。** 查看审核和执行记录。默认策略要求你填写本次验收依据后完成任务。失败或取消的委派若存在有效提交，可在新工作区恢复，并先复审已有成果；尚未提交时，可显式接续原工作区保留的代码。

委派产生的提交保留在对应分支和工作区，由你按项目的 Git 流程审查、整合；Council 不会自动合并或部署。

## 快速开始

### 不配置模型，先体验界面

需要 **Node.js 24 或更新版本**和 npm。

```bash
git clone https://github.com/GreenJoson/council.git
cd council
npm run install:all
npm run dev:web
```

打开 Vite 输出的本地地址。默认 `mock` 模式使用示例数据，不连接真实项目、不调用模型，也不持久化真实工作。界面是图标栏 + 会话流 + 上下文栏的三栏壳，议题讨论、任务、资产库与流水线的截图见 [`docs/designs/`](docs/designs)。

### 构建 macOS 桌面应用

还需安装当前稳定版 Rust 工具链和 Xcode Command Line Tools。Rust 包声明的最低版本为 1.85；请使用能满足锁定依赖的当前工具链。

```bash
npm run dev:desktop
# 或生成应用包和磁盘映像：
npm run build:desktop
```

产物位于 `packages/desktop/src-tauri/target/release/bundle/`。构建会下载锁定版本的官方 Node 运行时，通过 SHA-256 校验后生成内置 Agent Service。安装后的应用不需要 Node/npm；各模型 CLI 仍需单独安装。

首次启动：

1. 选择一个**源码目录之外的日志库**，Council 会在其中创建或打开 `council.sqlite3`。
2. 选择要讨论或实施的项目目录。
3. 打开“模型与 Provider 设置”，配置本机 CLI 或兼容 API Provider，再创建或启用对应 Agent。
4. 本机 Agent 需自行安装并登录相应 CLI；远程 Provider 的 API 地址、模型和自己的 Key 在设置中填写。
5. 创建议题，通过 `@Agent` 或圆桌开始讨论。

应用负责启动和回收内置本地服务。当前本地构建采用 ad-hoc 签名，默认流程不提供 Apple 公证。

### 用 WebUI 连接真实本地数据

```bash
cp packages/mcp-server/.env.example packages/mcp-server/.env
cp packages/web/.env.example packages/web/.env.local
```

运行 `npm run dev` 前编辑以下配置：

| 配置项 | 含义 |
|---|---|
| `COUNCIL_DATA_DIR` | 仓库之外的日志库绝对路径。 |
| `COUNCIL_MAX_OUTPUT_CHARS` | 最终回复 / 交付摘要限额；桌面默认 30,000 字符。 |
| `COUNCIL_CLI_MAX_STREAM_CHARS` | Claude/Codex CLI 累计事件流的独立限额，包含工具结果；默认 32,000,000 字符。调整它不会放宽最终回复限制。 |
| `VITE_COUNCIL_DATA_MODE` | 真实数据使用 `http`。 |
| `VITE_COUNCIL_API_URL` | 本地 API origin；后端示例为 `http://127.0.0.1:4317`。 |
| `VITE_COUNCIL_PROJECT_PATH` | 允许 Agent 检查的项目绝对路径。 |
| `COUNCIL_HTTP_CORS_ORIGINS_JSON` | 精确匹配 Vite 输出的 Web origin，例如 `http://localhost:5173`。 |

```bash
npm run dev
```

桌面服务与独立开发 API 不能同时持有同一日志库的 Model Router 写权限。请先退出桌面服务，或为开发环境使用另一份日志库和端口。

### 通过 MCP 接入已有 Agent 客户端

构建 MCP 服务后，打开「设置 → 客户端接入」，对 Claude Code 和/或 Codex 点「写入」：Council 会以同一日志库、各自的 `claude`/`codex` 调用者身份注册自己并安装 Council Skill，写入前备份原文件，可随时还原。文件位置、漂移处理与手动备用配置见 [MCP 接入 / MCP setup](docs/mcp-setup.md)。可选的 [Council Skill](skills/council/SKILL.md) 提供协作协议，单独使用桌面应用不需要安装它。

示例提示词：

> 使用 Council，为当前项目的重试策略创建议题。检查真实代码，发布提案，并说明失败条件和验证方法。

> 读取 topic `<topic-id>`，根据代码证据独立质疑现有方案，发布 critique。未经我确认，决策只能记录为 proposed。

`@codex` 会启动本机 Codex CLI 调用，不会控制另一个已打开的 Codex App 私有任务；Claude 同理。

## 架构

```mermaid
flowchart TB
  Clients[Agent 客户端] -->|MCP stdio| Node[Node 服务：MCP、HTTP、编排]
  Browser[React WebUI] -->|REST 与 SSE| Node
  Desktop[Tauri 桌面与 React 界面] -->|IPC| Rust[Rust council-core]
  Desktop -->|本地编排 API| Node
  Rust --> DB[(本地 SQLite)]
  Node --> DB
  Node --> Runtime[运行时适配与权限策略]
  Runtime --> CLI[Claude 与 Codex CLI]
  Runtime --> ACP[已注册 ACP Agent]
  Runtime --> API[兼容模型 API 与只读工具]
  Node --> Worktree[Git 工作区与提交检查点]
```

| 模块 | 职责 |
|---|---|
| [`packages/web`](packages/web) | React 界面（图标栏 + 会话流 + 上下文栏三栏壳）、仓储适配、议题讨论、任务 / 资产 / 流水线、决策与待处理视图。 |
| [`packages/desktop`](packages/desktop) | Tauri 壳、原生目录选择、本机设置和后台 Worker 连接。 |
| [`crates/council-core`](crates/council-core) | Rust 内容读写，以及共享 SQLite schema 的验证。 |
| [`packages/mcp-server`](packages/mcp-server) | MCP/HTTP 边界、唯一 schema 迁移器、Provider 路由、凭据、运行时适配和任务委派。 |
| [`packages/orchestrator`](packages/orchestrator) | 与模型无关的运行和圆桌状态机、持久化、租约与取消。 |
| [`skills/council`](skills/council) | 面向 Agent 客户端的共同讨论协议。 |

**数据与并发。** SQLite 是唯一事实来源。Node 负责迁移；Rust 等待服务就绪并核对数据库身份后才打开库。内容与编排 revision 驱动跨进程刷新。租约和 epoch 拒绝过期 Agent 回复，任务版本号阻止覆盖较新的人工作答。

**Agent、Provider、Runtime 分工。** Agent 是具有独立身份和模型配置的参与者；Provider 定义连接与凭据引用；Runtime 实现执行并声明能力。目录中有某个模板，不代表本机已经安装对应 CLI，也不代表其所有能力均已授权。

**讨论与实施。** 讨论工具受只读策略约束。显式实施委派目前使用受支持的原生 Claude/Codex CLI 执行者，并应用选定权限；ACP 与兼容 API ToolLoop 保持在已声明的只读能力内。Git worktree 用于隔离改动，不是操作系统级安全沙箱。

**权限与登录。** Agent 设置定义权限上限，每条委派另行保留本次执行权限。接续默认沿用原权限，可在当前上限内显式选择新权限；任务卡显示实际权限，历史记录保留。Claude OAuth 过期单独归类为认证失败，应先完成 `claude auth login` 再接续；完全控制不能恢复过期登录。

**恢复与证据。** 运行时事件经脱敏后持久化。恢复前检查同一仓库、受管目录、已记录 HEAD、权限和任务版本，再创建新运行。干净的交付提交先复审；提交前失败的任务可用“接续未完成工作”将检查过的代码带入新工作区，继续执行和审核，原文件与历史保留。没有提供的工具细节明确显示不可用；上下文占用不会被当成计费 Token 或推算费用。

**长任务执行。** 委派展示持久化的生成指令、执行验证、提交和审核阶段。Claude 分阶段配置回合预算：桌面讨论/指令默认 24，实施默认 120（`COUNCIL_CLAUDE_EXECUTION_MAX_TURNS`），审核默认 48（`COUNCIL_CLAUDE_REVIEW_MAX_TURNS`）。新委派默认最多 4 个执行段、累计 2 小时，分别通过 `COUNCIL_DELEGATION_MAX_EXECUTION_SEGMENTS` 和 `COUNCIL_DELEGATION_EXECUTION_TIMEOUT_MS` 配置。可自主继续的交接，或有会话和实际代码进展的回合耗尽，可在预算内接续；额度、权限、认证、连续无进展及总预算耗尽时暂停。保留有效指令和已有代码，新工作区使用新模型会话。工具计数和可观测回合数来自结构化事件，不公开工具参数和私有会话 ID。

## 模型发现与连接诊断

在 **Provider 与 Agent** 中保存连接后，选择 Agent 并点击“获取模型列表”。OpenAI 兼容连接使用已保存的凭据读取当前 Provider 的 `/models`。不支持列表的接口以及 CLI/ACP 连接继续允许手填；内置候选不代表当前账号可调用。

点击“测试”会检查已保存的 Agent。Claude/Codex 分别检查 CLI 启动、登录，以及模型能否只读读取随机临时文件；API 检查实际模型响应；ACP 目前检查会话握手。界面分别展示通过、失败、未验证项目，并显示请求模型和上游提供的返回模型；返回名称不能独立证明底层模型身份。测试可能产生模型费用，不验证项目写入权限，也不代表任务交付。修改配置后旧结果失效，失败不会自动更换模型或凭据。

## 项目附件与内部预览

架构档案中的“项目附件”自动汇总议题、消息和决策里的本地 Markdown 文件链接。例如 `[设计表](docs/design.xlsx)` 或 `[参数](config/model.json)`；已有的项目内绝对路径链接也可以打开。点击附件卡片或正文中的文件链接，即可在 Council 内只读查看，无需切换软件。

- XLSX 支持切换工作表；CSV/TSV 以网格显示。公式展示文件保存时的缓存值，不重新计算。
- Markdown 提供阅读与源码视图；JSON、YAML、配置和代码按文本展示，不执行脚本或 HTML，也不自动加载文档外链图片。
- 附件是**当前项目文件的引用**：议题保存链接，源文件仍在项目目录中，不自动复制或上传，也不是固定版本备份。移动或删除源文件后会提示失效。尚不支持上传附件、版本快照、PDF/Word 或旧版 XLS 预览。
- 只读取该议题绑定项目中的普通文件；拒绝目录越界、符号链接逃逸及私密配置路径（如 `.env` 和密钥）。大小、表格行列、解压量与解析时间由 `COUNCIL_FILE_PREVIEW_*` 配置限制；截取预览会明确提示，原文件不变。

## 安全与当前边界

- 使用你自己的 Provider 凭据。远程 API Key 保存在 macOS Keychain，SQLite 只存凭据引用与公开设置；项目不附带可用 Key。
- Provider catalog 中的官方 API 地址是可修改的默认配置，不是私有上游服务。随环境变化的目录、端口和运行参数放本地配置。
- HTTP 控制面**仅监听 loopback，面向本机单用户**，尚无每实例认证令牌。不要通过隧道、反向代理或公网监听暴露它。
- Agent 客户端之间只共享主动发布的议题内容。模型调用及获授权代码读取仍会经过选定 Provider；本地存储不等于离线推理。
- 本机 Node Worker 在退出桌面后继续运行，重新打开连接原服务。同一数据库的进程锁阻止重复 Worker；服务默认空闲 5 分钟退出。崩溃和系统重启后仍需显式恢复，残留 CLI 未退出时拒绝接管。替换二进制前应完成任务并停止旧服务。
- 新委派默认人工验收。未知写入错误不会被自动重放；有界接续要求可继续的交接，或有真实进展的回合耗尽；原工作区仍有效时，可显式接续未提交代码；私密配置、运行数据、二进制、符号链接和疑似凭据会被拒绝。
- SQLite 审计是本机执行证据，不是独立防篡改存证。原生 CLI 委派目前提供阶段和提交证据，不提供完整工具转录。
- 当前优先支持 macOS、本机单用户。多用户托管、Windows/Linux 桌面发布、费用核算、自动 ADR 导出、自动合并与部署均不属于本版承诺。

进一步说明：[安全说明](SECURITY.md)、[执行交付与恢复](docs/execution-delivery.md)、[Schema 迁移安全](docs/schema-migration-safety.md)。

## 开发与验证

```bash
npm run check       # TypeScript、Rust 格式和 Clippy
npm test            # 单元与集成测试，包含 Rust
npm run test:e2e    # 测试 Agent 下的真实 HTTP/SSE 和浏览器流程
npm run audit       # npm 依赖漏洞审计
```

E2E 需要 Python 3、Python Playwright 包及其 Chromium 浏览器，使用临时数据库和 Agent 替身。通过 E2E 不代表真实上游模型兼容性或回答质量已经验收。当前版本的验证结果见 [0.10.0 发布审核](docs/release-0.10.0.md)。

贡献时请说明实际用户问题，保持模块职责清晰，执行相关检查，并同步更新中英文 README 和受影响目录的 `_README.md`。不要提交本地数据库、`.env`、凭据或私人项目截图。详细流程与故障排查见 [使用指南](docs/usage.md)。

## 更新日志

发布审核记录放在 `docs/`，0.9.2 之前的版本只保留在 git 历史里。

### 未发布

- 桌面端：WebView CSP 的 `img-src` 放行本地 Agent 服务回环地址，资产缩略图、原图与消息图片在装好的应用里正常显示，不再是坏图占位（0.10.0 只通过 HTTP 验过图片接口）。
- 桌面端：「本地 Agent Service 未就绪」提示只在本次拉起的 sidecar 已退出时转述本次启动之后的日志错误，不再把以前会话里的任务失败当成原因。
- 出图不再要求项目是 Git 仓库：图像委派与流水线出图阶段改在委派根目录下的隔离空目录执行，不建 worktree，也不受工作区未提交改动影响；代码委派（含原型阶段）仍需要 Git，非仓库时直接提示先初始化并提交一次，而不是笼统的“Git 操作失败”。
- 图片查看：Lightbox 标题（如很长的生图提示词）不再把框体撑宽，大图完整居中显示而不是只露出一半；长标题单行省略、悬停看全文。
- 资产库排版：网格铺满可用宽度，卡片改 4:3 画框；详情页改为左图右信息两栏，左栏读原图、随窗口高度放大并在滚动时吸顶，点击查看原图；窄屏回落单栏。

### 0.10.0 — 2026-10-11

- V2 重构全部并入主分支：直接代码任务、资产库与 Codex 生图、多阶段流水线（简报 → 生图 → 评审 → 原型）、界面收口。
- Worker 团队：代码任务可交给 Lead 并行拆分，每个 Worker 在独立 worktree 和分支上工作，受控合并回 Lead 分支，全团队只审一次。
- 客户端接入：设置里一键把 Council MCP 注册与 Skill 写入本机 Claude Code / Codex 配置，只碰 Council 自己的片段，漂移时拒绝覆盖，随时还原。
- 消息图片附件：编辑器粘贴或引用图片，存入日志库资产库而不落项目目录，正文通过 `council-asset:` 引用内嵌渲染。
- 新应用图标：浅色底板上的三席位、三段弧与共识星，与应用内 `BrandLogo`、favicon 共用同一套几何。
- Schema v19 → v20 为破坏性迁移，旧二进制不读新库；迁移器会在同目录生成迁移前备份。
- 审核记录：[0.10.0 发布审核](docs/release-0.10.0.md)。

### 0.9.3 – 0.9.8 — 2026-09-21

- 委派链路加固：CLI 执行流与最终回复上限分离、未完成的委派代码在隔离工作区接续、委派进度持久化并拆分执行预算、保留显式接续权限、对齐委派历史、保留分段交付并要求完整评审证据。

### 0.9.2 — 2026-09-20

- 决策包、多 Agent 委派、任务验收、执行证据、当前项目待处理与提交检查点恢复；首个正式桌面图标；依赖安全更新。Schema v16。
- 审核记录：[0.9.2 发布审核](docs/release-0.9.2.md)。

## 许可证

[MIT](LICENSE)。第三方依赖与品牌资源保留各自许可及商标权；Provider 标识仅用于说明集成，不代表官方背书。资源来源记录于 [Provider catalog](packages/mcp-server/resources/provider-catalog.json)，桌面构建附带 Node 和打包依赖声明。
