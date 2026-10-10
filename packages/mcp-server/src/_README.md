# src - MCP 服务核心源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `native-runtime-progress.ts` | 协议边界 | 原生 CLI 会话、回合、工具计数白名单与结构化失败分类 |
| `schema-v17-migration.ts` | 迁移步骤 | 追加私有委派检查点，保留旧记录 |
| `schema-v19-migration.ts` | 迁移步骤 | 资产库：新增 assets/asset_links 两表、两索引与内容 revision 触发器，不动旧表 |
| `schema-v20-migration.ts` | 迁移步骤 | Worker 团队：新增 task_teams/task_workers 两表、索引与编排 revision 触发器；委派表追加 team_worker 列，单活跃委派索引只约束主委派 |
| `schema-v18-migration.ts` | 迁移步骤 | 任务一等化：重建实施项/委派/审计三表，topic_id 可空，追加 kind/source/priority/project_path/brief 与 scope_key 树唯一性 |
| `schema-v15-migration.ts` | 迁移步骤 | 冻结完成策略与验收标准，约束人工验收；历史记录保留审核即完成语义 |
| `schema-v16-migration.ts` | 迁移步骤 | 增加追加审计、失败分类、恢复来源及审计 revision |
| `index.ts` | 入口 | 加载配置，等待 schema 迁移完成后连接 stdio MCP |
| `http-index.ts` | 入口 | 默认迁移 schema 后启动本地 REST/SSE；sidecar 子模式只启动 Kimi 使用的单工具 Git MCP |
| `server.ts` | MCP 入口 | 绑定不可伪造的 MCP 调用者 Actor，按 topic → message → work-item → task → asset → pipeline → claude → status → team 固定顺序装配 `mcp/` 工具模块；带 `COUNCIL_TEAM_LEAD_DELEGATION_ID`（团队 Lead 注入）时只装配六个团队工具；工具实现见 `mcp/_README.md` |
| `actor-identity.ts` | 身份正本 | 只定义 Human/Council/Claude/Codex/Legacy 永久 Actor 种子，以及动态 Actor、别名和冻结快照工具；品牌资源不进入领域层 |
| `legacy-dynamic-actors.ts` | 历史兼容 | 仅在旧设置、Session 或冻结 Run 仍引用时识别历史 Kimi/DeepSeek 固定 Actor 种子，禁止新 Agent 复用 |
| `schema-definitions.ts` | Schema 正本 | 保存 v1–v20 已发布 required objects、冻结 DDL 与 canonical schema 常量，不含迁移副作用 |
| `schema-migrator.ts` | 迁移边界 | 镜像版本、验证冻结 schema、逐版本事务迁移、备份与失败关闭 |
| `schema-migration-values.ts` | 迁移值边界 | 严格读取历史行字段并映射旧作者/Agent 身份，不接触迁移事务 |
| `schema-storage.ts` | 存储边界 | 提供迁移共用的 pragma/完整性/行数校验、schema 快照、在线备份验证和文件保护 |
| `schema-v3-migration.ts` | 迁移步骤 | 将 v2 `agent_settings` 按证据原子升级为 Provider/Agent/BrandAsset，并删除旧表 |
| `schema-v4-migration.ts` | 迁移步骤 | 增加 Provider/Agent 单调配置版本并扩展 v3 Run 快照容器；旧 v1/v2 Run 不猜补绑定 |
| `schema-v5-migration.ts` | 迁移步骤 | 将当前 Kimi/DeepSeek Agent 重绑到新 UUID Actor，冻结旧种子供历史读取，并恢复 Claude/Codex 不可变身份 |
| `schema-v6-migration.ts` | 迁移步骤 | 增加 RuntimeBinding、绑定 lease、议题级请求账本、活动 session 唯一约束、运行快照 v4、accepted fencing 与独立 revision 触发器 |
| `schema-v7-migration.ts` | 迁移步骤 | 增加 DiscussionCycle（固定四段收敛、轮次预算、冻结上下文游标、议题级 active 唯一）与 BlockingQuestion（公开提问/回答、cycle 内单一未答、按提问消息幂等） |
| `schema-v8-migration.ts` | 迁移步骤 | 为 DiscussionCycle 持久化周期类型、需求快照、Agent/Provider/Runtime 修订与能力快照，以及预算耗尽的结构化阻断结果 |
| `schema-v9-migration.ts` | 迁移步骤 | 原子扩展 Provider/Runtime 约束以接纳 Kimi ACP 与兼容 API ToolLoop，并保留 Provider、Agent、RuntimeBinding、lease、请求账本和 revision 触发器 |
| `schema-v10-migration.ts` | 迁移步骤 | 将 Kimi 专用协议/transport 原子归一为通用 ACP，并无损保留 Provider、Agent、RuntimeBinding session、lease 与请求账本 |
| `schema-v11-migration.ts` | 迁移步骤 | 增加实施项审核账本字段、父子任务、认领证据与 revision 触发器 |
| `schema-v12-migration.ts` | 迁移步骤 | 重建实施项表，固定树唯一性、父任务派生状态与审核发现约束 |
| `schema-v13-migration.ts` | 迁移步骤 | 将议题从单决策接受扩展为稳定 ID 的多决策包，最后一项接受后才结束议题 |
| `schema-v14-migration.ts` | 迁移步骤 | 为 Agent 增加职责/权限上限，并建立 supervisor→executor→review 的实施项委派账本 |
| `agent-execution-policy.ts` | 权限正本 | 定义顾问/执行/审核职责、只读/工作区/完全控制权限，以及每次委派与 Agent 上限的交集规则 |
| `database.ts` | 数据访问入口 | 验证已迁移 schema，持有 SQLite 连接、BEGIN IMMEDIATE 事务、外部 alias 与事务内 active actorId 解析，并以同名同签名转发把议题/消息/决策/实施项操作交给 `database/` 仓储；Session 历史与单调 revision 仍在此；仓储与行映射见 `database/_README.md` |
| `errors.ts` | 边界 | 定义协议层可安全识别的领域错误 |
| `project-path.ts` | 边界 | 统一 MCP 与 HTTP 的项目路径规范化和存在性校验 |
| `prompt-budget.ts` | 安全边界 | 保留可信指令并只裁较早的不可信公开历史 |
| `process-utils.ts` | 安全基础 | 提供有界子进程运行、含计数的输出超限错误、stdout 首尾截断与进程树终止；超限后停止解码后续洪流 |
| `project-path-policy.ts` | 路径策略 | 为文件工具与 Git diff 提供同一敏感目录/文件判定，防止入口间规则漂移 |
| `runtime-stream.ts` | 流式基础 | 定义公开文本增量事件并对任意 stdout 分片做 JSONL 解码 |
| `runtime-mcp-servers.ts` | 运行时配置 | 委派可注入的 MCP 服务定义（只有 Worker 团队 Lead 用到），转成 Codex `--config mcp_servers.*` 覆盖参数、Claude `--mcp-config` JSON 与允许工具名；未传时两边仍是空表隔离 |
| `claude-runtime.ts` | 核心 | 隔离 MCP 并按委派权限执行（唯一例外是 Lead 委派显式注入的 council MCP）；事件流与最终回复独立限额，单独提取最终结果，仅有监听时请求逐字预览 |
| `codex-runtime.ts` | 核心 | 按结构化权限执行并隔离 MCP；保留 CLI 认证，独立限制 JSONL/最终正文并报告具体超限计数；可用性检查在已登录时附带生图探针（`imageGeneration`，诊断码不含 CLI 原文），`generateImages` 以 workspace-write 跑 `exec --enable image_generation --output-schema -o [-i]` 并返回 `{ threadId, lastMessage }`。实测（codex-cli 0.162.0）：`-i` 生效、`-o` 清单可严格解析、`<codex-home>/generated_images/<threadId>/` 存在可兜底，详见 `pipelines/_README.md` |
| `codex-image-runtime.ts` | 纯函数 | Codex 生图的 features 判定、Provider 覆盖检测、输入校验与固定参数拼装（`-i` 可变参数前置，避免吞掉 stdin `-`） |
| `acp-runtime-registry.ts` | Runtime 注册 | 声明 Kimi、Gemini、Grok、Codex、Claude Agent 到 ACP 命令、模型选择协议、启动参数和 Runtime 能力的受控映射；实际授权再与独立 Council policy 取交集 |
| `acp-delegated-runtime.ts` | DelegatedRuntime | 通过 ACP 管理每 RuntimeBinding 常驻进程/session、当前及已关联仓库的只读文件、单工具 Git MCP、审批拒绝、取消与恢复 |
| `openai-compatible-model-client.ts` | ModelClient | 有界调用流式 OpenAI Chat Completions 兼容 Provider，解析公开文本与 Tool Call，并分类脱敏错误 |
| `read-only-tool-host.ts` | ToolHost | 以本轮仓库白名单和 realpath 限制当前/关联仓库，提供读文本、列目录、搜索文本和受控已提交 Git diff，拒绝敏感配置、符号链接逃逸与所有写操作 |
| `read-only-agent-loop.ts` | AgentLoop | 让同轮工具共享结果预算，保留本轮原始证据并将已读旧结果压成带哈希的首尾凭据；上下文吃紧时收回工具强制收尾并追加 blocking 覆盖保护，只有初始可信提示自身超限才失败关闭 |
| `read-only-git-diff.ts` | Git 安全边界 | 只接受本轮白名单中的当前/一层同级仓库，将 commit/ref 解析为 OID，过滤敏感路径后用固定 argv 生成有界 patch 或统计摘要，并阻止软链逃逸 |
| `trusted-git-targets.ts` | Git 授权桥 | 自动圆桌只从服务端阶段指令提取白名单；Composer 手动 @Agent 会移除自由文本伪造授权，再从议题最新结构化提交关联继承仓库/commit |
| `read-only-git-mcp.ts` | Delegated 工具桥 | 只向获授权 ACP Runtime 暴露支持 `repository` 参数的 `council_git_diff`；复用同一 sidecar，不暴露 Council 写工具或 Shell |
| `openai-compatible-runtime.ts` | 兼容层 | 复用 ModelClient 提供连接测试与旧绑定所需的纯文本生成接口 |
| `claude-client.ts` | 适配 | 组装公开上下文、恢复 session，并在成功后写入共享数据库 |
| `provider-catalog.ts` | 配置入口 | 严格加载打包 catalog，集中提供 Provider 模板与受控 BrandAsset 元数据 |
| `model-router-store.ts` | 数据 | 事务管理 Provider、Agent、单调 configRevision、Actor/alias 与 BrandAsset；支持已删除 Provider 原行复活，并阻止系统身份修改与活动 Run 下的危险变更 |
| `model-router-service.ts` | 应用 | 校验 Provider/Agent 命令、补偿 Keychain 写入/轮换、组合公开快照并执行连接测试；重建同模板 Provider 时复活旧行而非制造重复配置 |
| `keychain-secret-store.ts` | 安全边界 | 将远程 Provider API Key 隔离到 macOS Keychain，并区分凭据不存在与命令故障 |
| `config.ts` | 配置 | 集中校验通用运行参数、独立 CLI 事件流、委派 Git 检查预算与 Codex 生图开关/沙箱/超时/产物上限（`COUNCIL_CODEX_IMAGE_*`，沙箱只接受 workspace-write）、P3 流水线阶段数与修订轮数上限（`COUNCIL_PIPELINE_MAX_STAGES`/`COUNCIL_PIPELINE_MAX_REVISIONS`）、P4 Worker 并行上限（`COUNCIL_WORKER_MAX_PARALLEL`）与 Lead MCP 继承用的 `collectCouncilEnv()`，并导出 loopback 判定；stdio MCP 额外要求不可由工具覆盖的调用者 Actor alias，并持有本机 HTTP 服务地址（仅 loopback）与转发超时，HTTP 不受该必填项影响 |
| `constants.ts` | 常量 | 定义协议枚举（含任务 kind/source）和输入边界 |
| `types.ts` | 类型 | 定义共享领域模型与 RuntimeBinding HTTP 配置 |
| `logger.ts` | 基础设施 | 将结构化日志写入 stderr |
| `mcp/` | MCP 工具 | `council_*` 工具按议题/消息/实施项/Claude/状态分模块注册，共享 Zod 字段、脱敏错误与 Markdown 格式化 |
| `database/` | 领域仓储 | 议题/消息/决策/实施项仓储与行映射，`database.ts` 通过 `DatabaseContext` 闭包注入连接、事务与 Actor 解析 |
| `http/` | 协议 | 提供 WebUI 使用的 REST、安全基线与跨进程 SSE |
| `assets/` | 资产领域 | v19 资产库：入库嗅探/配额/内容寻址落盘、缩略图与 content 出口、链接与软删除用例；SQL 由 `database/asset-repository.ts` 承担，见 `assets/_README.md` |
| `tasks/` | 任务领域 | 直接任务与议题派生任务两个入口、任务读写/委派用例；任务存储仍由 `database/work-item-repository.ts` 承担，见 `tasks/_README.md` |
| `pipelines/` | 图像/原型协议与流水线 | P2 `council-brief` 与 `council-asset-manifest` 的严格解析、`--output-schema` JSON Schema 与生图提示词；P3 流水线模板、`council-pipeline` 文档、brief/review 提示词、状态读写、驱动器与用例（父任务 kind=pipeline，状态机由驱动器唯一推进），见 `pipelines/_README.md` |
| `teams/` | Worker 团队 | P4：Lead 委派 + `team_worker` 子委派的团队仓储、检查点/worktree/合并 Git 入口、Lead 注入 MCP 配置与「团队模式」提示词、团队用例；见 `teams/_README.md` |
| `orchestration/` | 编排 | 接入本机/远程纯 Agent、显式传递安全失败原因、后台 lease 执行、周期恢复与浏览器安全策略 |

## Schema 迁移纪律

- 已发布并被任何数据库应用过的迁移文件不可回改；修正只能追加下一版本迁移。
- 从 v11 起，所有 `INSERT ... SELECT` 必须在两侧显式列出字段，禁止使用按位置匹配的 `SELECT *`。

`native-runtime-progress.ts` 优先识别最终认证/服务错误，历史工具拒绝不能覆盖终止原因。

| `project-file-preview.ts` / `project-file-preview-config.ts` | 文件预览 | 绑定议题项目的只读文件边界与集中预算；文本直接返回，表格放入受限 Worker，`image` 校验后原样出站供消息内嵌图片；不持久化文件内容 |
| `spreadsheet-preview-worker.ts` | 隔离解析 | SheetJS 只读 XLSX/CSV/TSV，ZIP 声明及实际解压双重限额，工作表矩阵有界，SEA 构建内嵌 Worker 资源 |
| `client-config/` | 客户端接入领域 | P4 magpie 式配置分发：向 Claude（`.claude.json` 的 `mcpServers.council`）与 Codex（`config.toml` 受管块）写 MCP 注册并复制 `skills/council`，带 stash/applied/漂移/还原；目标路径来自 `config.ts` 的 `loadClientConfigSettings`，见 `client-config/_README.md` |
| `stdio-mcp.ts` | stdio MCP 启动 | `runStdioMcp` 供 `index.ts` 与 `http-index.ts --council-stdio-mcp`（桌面 sidecar 无独立 index.js）共用；`resolveStdioMcpLaunch` 是本机 stdio MCP 启动命令的唯一真源（sidecar 标记 / dist / tsx），客户端接入写入与团队 Lead 注入都从这里取 |
