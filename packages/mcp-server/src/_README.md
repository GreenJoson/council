# src - MCP 服务核心源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `index.ts` | 入口 | 加载配置，等待 schema 迁移完成后连接 stdio MCP |
| `http-index.ts` | 入口 | 迁移 schema 后独立启动本地 REST 与 SSE 服务 |
| `server.ts` | 核心 | 绑定 MCP 调用者 Actor，注册不可伪造作者的议题、消息、proposed 决策和可传递请求取消的 Claude 工具 |
| `actor-identity.ts` | 身份正本 | 定义动态 Actor、别名、冻结快照与内置身份种子；品牌资源不进入领域层 |
| `schema-definitions.ts` | Schema 正本 | 保存 v1/v2 required objects、冻结 DDL 与 canonical schema 常量，不含迁移副作用 |
| `schema-migrator.ts` | 迁移边界 | 镜像版本、验证冻结 v1 digest、生成并验证在线备份、事务迁移和失败关闭 |
| `database.ts` | 核心 | 验证已迁移 schema，区分外部 alias 解析与事务内 active actorId 写入，校验行快照与索引 Actor 一致，并提供无损 Session 历史和单调 revision |
| `errors.ts` | 边界 | 定义协议层可安全识别的领域错误 |
| `project-path.ts` | 边界 | 统一 MCP 与 HTTP 的项目路径规范化和存在性校验 |
| `prompt-budget.ts` | 安全边界 | 保留可信指令并只裁较早的不可信公开历史 |
| `process-utils.ts` | 安全基础 | 提供有界子进程运行、stdout 停止/首尾截断策略、进程树终止与 CLI 选项规范化 |
| `runtime-stream.ts` | 流式基础 | 定义公开文本增量事件并对任意 stdout 分片做 JSONL 解码 |
| `claude-runtime.ts` | 核心 | 纯生成、可取消地管理 Claude Code stream-json，只转发公开 text delta，并将失败分类为脱敏诊断 |
| `codex-runtime.ts` | 核心 | 强制只读沙箱地管理 Codex；转发公开 JSONL 消息、约束总事件流并独立限制最终正文 |
| `openai-compatible-runtime.ts` | 核心 | 有界调用流式 OpenAI Chat Completions 兼容 Provider，只转发公开 `delta.content` 并分类脱敏错误 |
| `claude-client.ts` | 适配 | 组装公开上下文、恢复 session，并在成功后写入共享数据库 |
| `agent-settings-store.ts` | 数据 | 验证既有设置表，并保存不含密钥的 Agent 模型、地址与启用状态 |
| `agent-settings-service.ts` | 应用 | 校验设置、组合密钥状态并执行连接测试 |
| `keychain-secret-store.ts` | 安全边界 | 将远程 Provider API Key 隔离到 macOS Keychain |
| `config.ts` | 配置 | 集中校验通用运行参数；stdio MCP 额外要求不可由工具覆盖的调用者 Actor alias，HTTP 不受该必填项影响 |
| `constants.ts` | 常量 | 定义协议枚举和输入边界 |
| `types.ts` | 类型 | 定义共享领域模型 |
| `logger.ts` | 基础设施 | 将结构化日志写入 stderr |
| `http/` | 协议 | 提供 WebUI 使用的 REST、安全基线与跨进程 SSE |
| `orchestration/` | 编排 | 接入本机/远程纯 Agent、显式传递安全失败原因、后台 lease 执行、周期恢复与浏览器安全策略 |
