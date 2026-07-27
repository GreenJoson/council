# src - MCP 服务核心源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `index.ts` | 入口 | 加载配置，等待 schema 迁移完成后连接 stdio MCP |
| `http-index.ts` | 入口 | 默认迁移 schema 后启动本地 REST/SSE；sidecar 子模式只启动 Kimi 使用的单工具 Git MCP |
| `server.ts` | 核心 | 绑定 MCP 调用者 Actor，注册不可伪造作者的议题、消息、proposed 决策和可传递请求取消的 Claude 工具 |
| `actor-identity.ts` | 身份正本 | 只定义 Human/Council/Claude/Codex/Legacy 永久 Actor 种子，以及动态 Actor、别名和冻结快照工具；品牌资源不进入领域层 |
| `legacy-dynamic-actors.ts` | 历史兼容 | 仅在旧设置、Session 或冻结 Run 仍引用时识别历史 Kimi/DeepSeek 固定 Actor 种子，禁止新 Agent 复用 |
| `schema-definitions.ts` | Schema 正本 | 保存 v1–v8 已发布 required objects、冻结 DDL 与 canonical schema 常量，不含迁移副作用 |
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
| `database.ts` | 核心 | 验证已迁移 schema，区分外部 alias 解析与事务内 active actorId 写入，校验行快照与索引 Actor 一致，并提供无损 Session 历史和单调 revision |
| `errors.ts` | 边界 | 定义协议层可安全识别的领域错误 |
| `project-path.ts` | 边界 | 统一 MCP 与 HTTP 的项目路径规范化和存在性校验 |
| `prompt-budget.ts` | 安全边界 | 保留可信指令并只裁较早的不可信公开历史 |
| `process-utils.ts` | 安全基础 | 提供有界子进程运行、stdout 停止/首尾截断策略、长驻进程树终止与 CLI 选项规范化 |
| `project-path-policy.ts` | 路径策略 | 为文件工具与 Git diff 提供同一敏感目录/文件判定，防止入口间规则漂移 |
| `runtime-stream.ts` | 流式基础 | 定义公开文本增量事件并对任意 stdout 分片做 JSONL 解码 |
| `claude-runtime.ts` | 核心 | 纯生成、可取消地管理 Claude Code stream-json，只转发公开 text delta，并将失败分类为脱敏诊断 |
| `codex-runtime.ts` | 核心 | 强制只读沙箱地管理 Codex；转发公开 JSONL 消息、约束总事件流并独立限制最终正文 |
| `acp-runtime-registry.ts` | Runtime 注册 | 声明 Kimi、Gemini、Grok、Codex、Claude Agent 到 ACP 命令、模型选择协议、启动参数和 Runtime 能力的受控映射；实际授权再与独立 Council policy 取交集 |
| `acp-delegated-runtime.ts` | DelegatedRuntime | 通过 ACP 管理每 RuntimeBinding 常驻进程/session、项目内只读文件、单工具 Git MCP、审批拒绝、取消与恢复 |
| `openai-compatible-model-client.ts` | ModelClient | 有界调用流式 OpenAI Chat Completions 兼容 Provider，解析公开文本与 Tool Call，并分类脱敏错误 |
| `read-only-tool-host.ts` | ToolHost | 以 realpath 限制项目根目录，提供读文本、列目录、搜索文本和受控已提交 Git diff，拒绝敏感配置、符号链接逃逸与所有写操作 |
| `read-only-agent-loop.ts` | AgentLoop | 在统一步骤、上下文、文件和扫描预算内循环执行模型请求与 Council 只读工具 |
| `read-only-git-diff.ts` | Git 安全边界 | 将 commit/ref 解析为 OID，先过滤敏感路径，再用禁用外部驱动的固定 argv 生成有界 patch 或统计摘要 |
| `read-only-git-mcp.ts` | Delegated 工具桥 | 只向获授权 ACP Runtime 暴露 `council_git_diff`；复用同一 sidecar，不暴露 Council 写工具或 Shell |
| `openai-compatible-runtime.ts` | 兼容层 | 复用 ModelClient 提供连接测试与旧绑定所需的纯文本生成接口 |
| `claude-client.ts` | 适配 | 组装公开上下文、恢复 session，并在成功后写入共享数据库 |
| `provider-catalog.ts` | 配置入口 | 严格加载打包 catalog，集中提供 Provider 模板与受控 BrandAsset 元数据 |
| `model-router-store.ts` | 数据 | 事务管理 Provider、Agent、单调 configRevision、Actor/alias 与 BrandAsset；支持已删除 Provider 原行复活，并阻止系统身份修改与活动 Run 下的危险变更 |
| `model-router-service.ts` | 应用 | 校验 Provider/Agent 命令、补偿 Keychain 写入/轮换、组合公开快照并执行连接测试；重建同模板 Provider 时复活旧行而非制造重复配置 |
| `keychain-secret-store.ts` | 安全边界 | 将远程 Provider API Key 隔离到 macOS Keychain，并区分凭据不存在与命令故障 |
| `config.ts` | 配置 | 集中校验通用运行参数；stdio MCP 额外要求不可由工具覆盖的调用者 Actor alias，HTTP 不受该必填项影响 |
| `constants.ts` | 常量 | 定义协议枚举和输入边界 |
| `types.ts` | 类型 | 定义共享领域模型与 RuntimeBinding HTTP 配置 |
| `logger.ts` | 基础设施 | 将结构化日志写入 stderr |
| `http/` | 协议 | 提供 WebUI 使用的 REST、安全基线与跨进程 SSE |
| `orchestration/` | 编排 | 接入本机/远程纯 Agent、显式传递安全失败原因、后台 lease 执行、周期恢复与浏览器安全策略 |

## Schema 迁移纪律

- 已发布并被任何数据库应用过的迁移文件不可回改；修正只能追加下一版本迁移。
- 从 v11 起，所有 `INSERT ... SELECT` 必须在两侧显式列出字段，禁止使用按位置匹配的 `SELECT *`。
