# Actor Identity v2 迁移

Council schema v2 把固定作者枚举替换为可扩展的 Actor Identity。身份层只回答“谁发布了这条
公开记录”，不保存 Provider 图标、品牌色、模型配置，也不直接负责 RuntimeBinding、外部
session 或 Agent 子进程生命周期；这些能力已经由后续运行时层实现。

## 领域模型

- `actor_identities` 保存稳定 `actorId`、slug、展示名、简称、角色、类型和状态。
- `actor_aliases` 以大小写不敏感唯一键把 CLI、适配器或历史名称解析到 Actor。
- Topic、Message、Decision 保存 Actor ID、写入时冻结的版本化快照和可选历史原值；读取时
  必须验证快照 `actorId` 与行索引 Actor 一致。
- schema v2 的兼容表 `agent_sessions` 使用独立行 ID 保存迁移前的历史会话，并以
  `is_current` 的部分唯一索引保证同一 Topic/Actor 只有一个当前历史会话；别名归并不得
  覆盖或删除旧记录。它不是 M3 的运行时 session 所有权表。
- 新写入只能使用 `active` Actor 的 alias；未知、停用或 `needs_review` alias 失败关闭。
- 冻结快照 schema v1 包含 `actorId`、`slug`、`displayName`、`shortName` 和 `role`。以后修改
  Actor 展示信息不会重写历史记录。

内置身份彼此独立：

| Actor ID | 角色 |
|---|---|
| `human` | 人类决策者 |
| `council` | Council 主持与系统记录 |
| `claude` | Claude Agent |
| `codex` | Codex Agent |
| `deepseek` | DeepSeek Agent |
| `kimi` | Kimi Agent |
| `legacy-unknown` | 无法安全归属的历史记录，仅待审计读取 |

## v1 到 v2 的确定性映射

迁移在同一排他事务内重建内容表和编排表：

- `human` 保持 `human`。
- `claude` 保持 `claude`。
- `codex` 保持 `codex`。
- `chair` 映射到 `council`，同时把原始值保存在 legacy 字段。
- `other` 映射到 `legacy-unknown`，状态为 `needs_review`，不能用于任何新写入。

这条规则不会根据消息文本、模型名或 Provider 配置猜测历史 `other` 的真实供应商。需要归属
历史数据时必须走后续显式审计工具，不能在启动迁移中静默改写。

编排运行快照继续读取 schema v1：`publicAuthor=other` 时，只有旧 adapter ID 精确为
`deepseek` 或 `kimi` 才映射到各自 Actor，其余 adapter 一律进入 `legacy-unknown`。新运行
只写 schema v2，并在每轮计划中保存 `actorId`。旧 Run 首次状态写与索引列在同一 CAS 中
原子升级为 v2，不能出现“JSON 已升级、版本列未升级”的撕裂状态。

MCP 写入身份不再由工具参数提供。每个 stdio MCP 进程必须用
`COUNCIL_CALLER_ACTOR_ALIAS` 绑定自己的 Actor，工具 schema 不暴露作者字段；MCP 只能记录
`proposed` 决策，`accepted` 仍由用户通过桌面或 HTTP 入口确认。进程启动时只解析一次
alias 并冻结可信 `actorId`；每次写入在同一事务内按该 ID 重新验证 Actor 仍为 active。
运行中重绑 alias、让另一 Actor 占用与该 ID 同名的 alias，都不能改变已启动进程的作者；
原 Actor 被停用后则立即失败关闭。

## 安全与回滚

Node Agent Service 仍是唯一生产迁移所有者。升级顺序保持不变：

1. checkpoint WAL。
2. 生成并只读验证在线备份。
3. 获取排他事务。
4. 写入 Actor 种子和 alias，复制旧记录并冻结快照。
5. 验证行数、外键、冻结 v1 全部 schema 对象与 digest、保留 Actor/alias、canonical v2、revision 与版本镜像。
6. 成功提交后才报告 `ready=true`。

任一步失败都会回滚事务并失败关闭；不会让 Rust、MCP 或桌面端在半迁移结构上继续运行。
已验证的迁移前备份不会自动删除。恢复旧版本时必须先停止所有 Council 进程，再显式恢复对应
备份，不能让旧二进制直接打开 schema v2。

所有自动化测试使用临时 SQLite。开发验证不会迁移或修改日常日志库。

## 当前运行时边界

身份迁移本身只交付身份与历史数据兼容；后续 M3 已经增加 RuntimeBinding 生命周期：

- `runtime_bindings` 以“议题 + Agent”保存逻辑绑定。同一议题/Agent 只允许一个未关闭绑定，
  Claude 与 Codex 分别通过 CLI 的 resume 协议恢复该绑定持有的外部 session。
- 首次调用发送完整公开上下文；成功提交后保存稳定消费游标，后续只发送公开增量。每个
  human 请求还会以“议题 + Agent + 请求消息”写入独立逻辑账本，物理绑定被关闭或删除后
  仍拒绝重复调用。
- 活动 Claude/Codex 外部 session 只能归属一个 RuntimeBinding。跨议题返回相同 session
  会使第二次原子提交失败，新绑定被中断并清除 session，不能让两个议题恢复同一上下文。
- 绑定使用独立 lease/epoch fencing 保证串行执行。手动关闭、配置变更、接受议题决策或达到
  配置项 `COUNCIL_RUNTIME_BINDING_IDLE_TIMEOUT_MS` 指定的 idle TTL 后会关闭；旧绑定和公开
  讨论保留为审计记录。
- 兼容 OpenAI 协议的远程 Provider 当前保持无状态，不保存可恢复 session。
- 当前仍是“每轮一个可取消的 OS 子进程 + 逻辑 session resume”，不是一个长期常驻的
  Claude/Codex 终端进程。常驻 OS 进程可作为未来的性能优化，但必须先解决进程所有权、
  崩溃接管、取消、资源上限和跨版本恢复，不能把它误写成当前能力。
- Provider 设置决定调用哪个运行时；Actor Identity 仍只决定公开记录归属。
