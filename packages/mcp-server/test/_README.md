# test - MCP 服务验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `database.test.ts` | 单元测试 | 验证共享存储、迁移并发、revision 分域与 lease 零噪声 |
| `claude-runtime.test.ts` | 单元测试 | 验证纯生成、session 恢复、取消、超时、输出上限与脱敏错误 |
| `codex-runtime.test.ts` | 单元测试 | 验证只读沙箱、JSONL 事件截断、最终正文限长、取消、超时与脱敏错误分类 |
| `claude-config.test.ts` | 单元测试 | 验证 Claude 权限模式、保留参数和定时器配置边界 |
| `codex-config.test.ts` | 单元测试 | 验证 Codex 只读沙箱、默认值、保留参数和定时器配置边界 |
| `claude-client.test.ts` | 集成测试 | 验证数据库兼容层的后台会话恢复及取消零写入 |
| `server.test.ts` | 协议测试 | 通过内存传输验证 MCP 工具注册、调用和取消零写入 |
| `http-harness.ts` | 测试夹具 | 提供隔离 HTTP 服务与统一 envelope 读取器 |
| `http-config.test.ts` | 单元测试 | 验证 HTTP 必填配置、loopback host 与 exact origin |
| `http-api.test.ts` | 集成测试 | 验证 REST 生命周期、错误、CORS、安全头和限流 |
| `http-events.test.ts` | 集成测试 | 验证跨连接变更、独立 retry 与 Last-Event-ID 重连语义 |
| `claude-agent-adapter.test.ts` | 安全测试 | 验证可信指令保留、只裁公开历史和 V1 无 session |
| `codex-agent-adapter.test.ts` | 安全测试 | 验证 Codex 可信指令、只裁公开历史、V1 无 session 与失败恢复分类 |
| `agent-settings.test.ts` | 安全测试 | 验证模型设置持久化、API Key 零落盘、Provider URL 校验与连接测试 |
| `openai-compatible-runtime.test.ts` | 协议测试 | 验证远程 Chat Completions 请求、错误脱敏分类与有界响应 |
| `prompt-budget.test.ts` | 安全测试 | 验证零历史预算不会触发 `slice(-0)` 绕过 |
| `http-orchestration.test.ts` | 主验收 | 用真实 App 验证冻结路由、上下文限制转发、断线、取消、审批、恢复与 sweeper |
| `fake-claude.mjs` | 测试替身 | 为浏览器 E2E 提供真实子进程边界下的版本、认证与生成协议 |
