# test - MCP 服务验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `schema-migrator.test.ts` | 主安全验收 | 用完整生产 v1 fixture 验证内容、设置、Session 碰撞、Run/approval/lease 值级无损迁移、冻结 schema 漂移/未知对象拒绝、连续版本镜像、备份、回滚与 WAL 阻塞 |
| `database.test.ts` | 单元测试 | 验证动态 Actor alias、冻结快照与索引一致、Session 历史/current 语义、未知身份拒绝、revision 分域与 lease 零噪声 |
| `agent-progress-hub.test.ts` | 单元测试 | 验证临时 Agent 草稿的顺序、有界追加、快照和完成清理 |
| `claude-runtime.test.ts` | 单元测试 | 验证纯生成、公开 stream-json 增量、session 恢复、取消、超时、输出上限与脱敏错误 |
| `codex-runtime.test.ts` | 单元测试 | 验证只读沙箱、公开 JSONL 消息增量、事件截断、最终正文限长、取消与脱敏错误分类 |
| `claude-config.test.ts` | 单元测试 | 验证 Claude 权限模式、stdio MCP 调用者身份必填、HTTP 配置隔离、保留参数和定时器边界 |
| `codex-config.test.ts` | 单元测试 | 验证 Codex 只读沙箱、默认值、保留参数和定时器配置边界 |
| `claude-client.test.ts` | 集成测试 | 验证数据库兼容层的后台会话恢复及取消零写入 |
| `server.test.ts` | 协议测试 | 通过内存传输验证 MCP 作者参数已移除、调用者 actorId 冻结、运行中 alias 重绑/同名 alias 不可劫持、停用后失败关闭、只能 proposed 决策、工具调用和取消零写入 |
| `http-harness.ts` | 测试夹具 | 提供隔离 HTTP 服务与统一 envelope 读取器 |
| `http-config.test.ts` | 单元测试 | 验证 HTTP 必填配置、迁移重试缺失 fail-fast、loopback host 与 exact origin |
| `http-api.test.ts` | 集成测试 | 验证 REST 生命周期、ready 数据库身份、错误、CORS、安全头和限流 |
| `http-events.test.ts` | 集成测试 | 验证跨连接变更、Agent 草稿增量/重连快照、独立 retry 与 Last-Event-ID 语义 |
| `claude-agent-adapter.test.ts` | 安全测试 | 验证可信指令保留、只裁公开历史、V1 无 session 与显式安全失败原因 |
| `codex-agent-adapter.test.ts` | 安全测试 | 验证 Codex 可信指令、只裁公开历史、V1 无 session、失败恢复与安全原因分类 |
| `agent-settings.test.ts` | 安全测试 | 在显式预迁移 fixture 上验证模型设置持久化、API Key 零落盘、Provider URL 校验与连接测试 |
| `openai-compatible-runtime.test.ts` | 协议测试 | 验证远程流式 Chat Completions、公开增量、JSON 回退、错误脱敏与有界响应 |
| `openai-compatible-agent-adapter.test.ts` | 安全测试 | 验证远程运行时脱敏原因可公开且未知异常继续隔离 |
| `prompt-budget.test.ts` | 安全测试 | 验证零历史预算不会触发 `slice(-0)` 绕过 |
| `http-orchestration.test.ts` | 主验收 | 用真实 App 验证冻结路由、单次完成复核覆盖、上下文限制转发、断线、取消、审批、恢复与 sweeper |
| `fake-claude.mjs` | 测试替身 | 为浏览器 E2E 提供真实子进程边界下的版本、认证与生成协议 |
