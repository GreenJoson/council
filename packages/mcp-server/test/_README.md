# test - MCP 服务验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `schema-migrator.test.ts` | 主安全验收 | 用完整历史 fixture 验证连续迁移到当前 v10：身份/运行数据无损、通用 ACP 协议迁移、Runtime 能力快照、漂移拒绝、备份、回滚与 WAL 阻塞 |
| `schema-v7-migration.test.ts` | 安全验收 | 在当前迁移库上继续冻结 v7 收敛容器不变量，并验证 accepted 决策使用 canonical 停止原因终结 cycle |
| `schema-v8-migration.test.ts` | 数据迁移 | 用最小现场 v7 cycle 直接验证需求/能力 backfill、旧停止原因规范化和 accepted trigger 修复 |
| `cycle-repository.test.ts` | 安全验收 | 在真实迁移库上验证收敛仓储：开局唯一与已决议题拒绝开局、同意路径直达 synthesis、阻塞回环与预算用尽放弃、提问挂起/回答的重放幂等、过期版本 CAS 拒绝 |
| `database.test.ts` | 单元测试 | 验证动态 Actor alias、冻结快照与索引一致、Session 历史/current 语义、未知身份拒绝、revision 分域与 lease 零噪声 |
| `agent-progress-hub.test.ts` | 单元测试 | 验证统一 RuntimeEvent 到临时草稿的兼容投影、顺序、有界追加、快照和完成清理 |
| `claude-runtime.test.ts` | 单元测试 | 验证纯生成、公开 stream-json 增量、session 恢复、取消、超时、输出上限与脱敏错误 |
| `codex-runtime.test.ts` | 单元测试 | 验证只读沙箱、公开 JSONL 消息增量、事件截断、最终正文限长、取消与脱敏错误分类 |
| `acp-delegated-runtime.test.ts` | ACP 进程测试 | 用五 Agent 生产注册表与真实 stdio 假 Agent 验证供应商无关启动、launch/session 模型选择、同 binding 进程/session 复用、服务重开 resume、只读工具、敏感文件阻断和执行权限拒绝 |
| `claude-config.test.ts` | 单元测试 | 验证 Claude 权限模式、stdio MCP 调用者身份必填、HTTP 配置隔离、保留参数和定时器边界 |
| `codex-config.test.ts` | 单元测试 | 验证 Codex 只读沙箱、五类 ACP 命令、默认值、保留参数和定时器配置边界 |
| `claude-client.test.ts` | 集成测试 | 验证数据库兼容层的后台会话恢复及取消零写入 |
| `server.test.ts` | 协议测试 | 通过内存传输验证 MCP 作者参数已移除、调用者 actorId 冻结、运行中 alias 重绑/同名 alias 不可劫持、停用后失败关闭、只能 proposed 决策、工具调用和取消零写入 |
| `http-harness.ts` | 测试夹具 | 提供可注入动态编排工厂的隔离 HTTP 服务与统一 envelope 读取器 |
| `http-config.test.ts` | 单元测试 | 验证 HTTP 必填配置、迁移重试缺失 fail-fast、loopback host 与 exact origin |
| `http-api.test.ts` | 集成测试 | 验证 REST 生命周期、ready 数据库身份、错误、CORS、安全头和限流 |
| `http-events.test.ts` | 集成测试 | 验证跨连接变更、Agent 草稿增量/重连快照、独立 retry 与 Last-Event-ID 语义 |
| `claude-agent-adapter.test.ts` | 安全测试 | 验证可信指令保留、首轮历史裁剪、session 恢复、公开增量与显式安全失败原因 |
| `codex-agent-adapter.test.ts` | 安全测试 | 验证可信指令、首轮历史裁剪、session 恢复、公开增量、失败恢复与安全原因分类 |
| `acp-delegated-agent-adapter.test.ts` | Runtime 契约测试 | 验证通用 ACP session 续接、只读工具事件归 Runtime 所有、隐藏思考隔离与 binding 关闭桥 |
| `model-router.test.ts` | 安全测试 | 验证同 Provider 多 Agent/独立 UUID Actor 与 alias、Kimi/Gemini/Grok/Codex/Claude ACP 目录、Kimi/DeepSeek 自定义 alias 与删除后自然 alias 重建跨迁移重开稳定、品牌不退化为 Other、Claude/Codex 身份不可变、Provider 软删除后原行复活与新凭据生效、API Key 零落盘、Keychain/alias 原子回滚及活动 Run 变更失败关闭 |
| `keychain-secret-store.test.ts` | 安全测试 | 验证 Keychain 凭据不存在返回空值，命令故障必须 fail closed |
| `openai-compatible-runtime.test.ts` | ModelClient 协议测试 | 验证远程流式 Chat Completions、Tool Call 增量合并、JSON 回退、HTTP 安全原因映射、错误脱敏与有界响应 |
| `read-only-tool-host.test.ts` | ToolHost 安全测试 | 验证读文件、列目录、文本搜索、敏感配置拒绝与符号链接逃逸阻断 |
| `read-only-agent-loop.test.ts` | AgentLoop 行为测试 | 验证模型—工具多步循环、工具事件、公开文本替换与步骤预算耗尽 |
| `read-only-git-diff.test.ts` | Git 安全测试 | 验证 commit/ref 固定解析、敏感文件及 rename 过滤、外部 diff 驱动禁用、预算降级和单工具 MCP 暴露 |
| `openai-compatible-agent-adapter.test.ts` | ToolLoop 适配测试 | 验证 `repository_read` 与 Council 所有权工具事件、远程脱敏原因可公开且未知异常继续隔离 |
| `prompt-budget.test.ts` | 安全测试 | 验证零历史预算不会触发 `slice(-0)` 绕过 |
| `http-orchestration.test.ts` | 主验收 | 用真实 App 验证冻结路由、系统 Agent 名称/alias/删除拒绝、单次完成复核覆盖、上下文限制转发、跨议题 session 碰撞失败关闭、断线、取消、审批、恢复与 sweeper；长调用跨越 RuntimeBinding TTL 且瞬时续租失败时仍可原子提交 |
| `fake-claude.mjs` | 测试替身 | 为浏览器 E2E 提供真实子进程边界下的版本、认证与生成协议 |
| `fake-keychain.mjs` | 测试替身 | 在隔离临时文件中实现 Keychain 最小命令协议，不触碰用户系统凭据 |
| `fake-openai-provider.mjs` | 测试替身 | 提供 loopback 流式文本、分片文件/Git Tool Call 与故障响应，用于远程 Provider/双 Agent/只读 ToolLoop E2E |
| `http-cycle.test.ts` | 端到端验收 | 走真实 REST 与执行面验证已有提案直达评审、缺 commit 零调用拒绝、能力 fail-fast、commit/diff 互审、提问恢复与决策一致性 |
| `cycle-driver.test.ts` | 行为验收 | 在真实迁移库上验证既有提案复用、自动交接、阻塞反驳回环、提问恢复，以及预算用尽原子保存阻断分歧 |
| `schema-freeze.test.ts` | 安全验收 | 冻结已发布迁移的 schema 指纹：改动任一已落库版本的 DDL 文本立刻失败，新增版本必须补指纹，并锁定 v5 为纯数据迁移 |
