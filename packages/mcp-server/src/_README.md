# src - MCP 服务核心源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `index.ts` | 入口 | 加载配置并连接 stdio MCP |
| `http-index.ts` | 入口 | 独立启动本地 REST 与 SSE 服务 |
| `server.ts` | 核心 | 注册议题、消息、决策和可传递请求取消的 Claude 工具 |
| `database.ts` | 核心 | 管理 SQLite schema、事务和查询 |
| `errors.ts` | 边界 | 定义协议层可安全识别的领域错误 |
| `project-path.ts` | 边界 | 统一 MCP 与 HTTP 的项目路径规范化和存在性校验 |
| `prompt-budget.ts` | 安全边界 | 保留可信指令并只裁较早的不可信公开历史 |
| `process-utils.ts` | 安全基础 | 提供有界子进程运行、stdout 停止/首尾截断策略、进程树终止与 CLI 选项规范化 |
| `claude-runtime.ts` | 核心 | 纯生成、可取消地管理 Claude Code 子进程，不接触数据库 |
| `codex-runtime.ts` | 核心 | 强制只读沙箱地管理 Codex；过程 JSONL 有界截断，最终正文独立限长并输出安全诊断码 |
| `openai-compatible-runtime.ts` | 核心 | 有界调用 OpenAI Chat Completions 兼容 Provider，并分类脱敏错误 |
| `claude-client.ts` | 适配 | 组装公开上下文、恢复 session，并在成功后写入共享数据库 |
| `agent-settings-store.ts` | 数据 | 在 SQLite 保存不含密钥的 Agent 模型、地址与启用状态 |
| `agent-settings-service.ts` | 应用 | 校验设置、组合密钥状态并执行连接测试 |
| `keychain-secret-store.ts` | 安全边界 | 将远程 Provider API Key 隔离到 macOS Keychain |
| `config.ts` | 配置 | 集中校验运行参数、只规划权限/只读沙箱、保留参数和定时器上限；Codex 默认容纳长上下文任务 |
| `constants.ts` | 常量 | 定义协议枚举和输入边界 |
| `types.ts` | 类型 | 定义共享领域模型 |
| `logger.ts` | 基础设施 | 将结构化日志写入 stderr |
| `http/` | 协议 | 提供 WebUI 使用的 REST、安全基线与跨进程 SSE |
| `orchestration/` | 编排 | 接入本机/远程纯 Agent、后台 lease 执行、周期恢复与浏览器安全策略 |
