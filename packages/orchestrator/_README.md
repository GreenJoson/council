# orchestrator - Council 自动轮次编排核心

> ⚠️ 一旦本文件夹有所变化，请更新本文件

## 定位

本包负责确定性的讨论轮次状态机，并提供基于 Node.js 内置 SQLite 的 `SQLiteCouncilStore`。核心仍只依赖 `CouncilStore` 抽象，不直接依赖 MCP、Claude Code 或 Codex CLI；调用方通过 `AgentAdapter` 接入可被主动触发的 Agent。

这两个边界必须分开理解：

- `CouncilStore.commitRound()` 负责把公开回复持久化到共享议题，使其他客户端自动看到消息。真实 SQLite 实现会在同一事务中校验 lease、CAS 运行版本、绑定当前轮作者/类型、插入消息并更新议题。
- `AgentAdapter.invoke()` 负责主动唤醒一个 Agent 产生新回复；数据库里出现新消息本身不会唤醒任何桌面会话。

控制面与执行面严格分离：`begin()`、`applyApproval()`、`prepareRecovery()` 只做快速原子转换；`drive()` 必须携带有效的 per-run lease。HTTP 可在控制面转换后返回 `202`，再由独立 ExecutionManager 续租并调用 `drive()`。

## 状态机

```text
idle -> running -> waiting_agent -> running
                  |                |
                  v                v
                failed       waiting_user
                                  |
                                  v
                               running

任意非终态 -> cancelled
running -> completed
failed --显式恢复且未超预算--> running
```

终态为 `completed`、`failed`、`cancelled`。编排器只会发布协议消息，不提供写入决策的接口，因此不会自动产生 `accepted` 决策。

## 停止与恢复边界

- 正常停止只由轮次计划耗尽或 `maxRounds` 达到触发。
- 人工门可配置在指定轮次之前和完成之前；未确认时进入 `waiting_user`。批准必须同时携带 `expectedGateId`、`expectedVersion`、`approvalId` 和 `approvedBy`，由 Store 原子校验并幂等落库。
- 每轮 Agent 调用同时具有 `agentIdleTimeoutMs` 无活动超时、`agentTimeoutMs` 绝对时长上限、
  取消后 cleanup 时限与自动尝试上限。协议、工具和文本活动只刷新前者，不能绕过后者。
- 两种超时都不得超过 Node.js 安全计时器上限，且无活动超时不能大于绝对上限。
- timeout/cancel/lease abort 后必须先等待 Adapter cleanup；cleanup 超时使用稳定失败码
  `agent_cleanup_timeout` 且禁止重试。LeaseLost/显式取消保留原控制流，留给重启或取消收敛。
- 自动尝试耗尽后进入 `failed`；显式 `prepareRecovery()` / `recover()` 还受 `maxManualRecoveries` 限制。
- `failed` 不占用同 topic 活动槽位；旧 run 恢复为 `running` 时仍会经过单活动唯一约束。
- 主动执行者必须 claim per-run lease，并在调用参数给定的 TTL 内续租。token 与 epoch 会 fence 所有执行态更新和轮次提交；claim、renew、release 不推进 `council_meta.revision`。
- RuntimeBinding 的新 lease 使用当前执行器配置的 TTL，禁止从已被续租替换的旧 RunLease
  快照推算剩余时间；否则长调用后的自动重试会退化成 1ms lease。
- `running` 可由新执行者续跑；`waiting_agent` 表示外部结果未知，重启时必须先 `markInterruptedAgent()` 进入 `execution_interrupted`，不得自动重放付费调用。
- `listRestartCandidates()` 直接按状态索引分页所有议题的 `running/waiting_agent`，避免旧议题
  或大量终态记录导致恢复遗漏；调用方应周期扫描，以在旧 lease 到期后自动接管。
- 取消会中止本进程内的 Agent 等待；`cancelRun()` 与带版本检查的原子提交保证取消之后不会再写入该轮回复。
- Agent 生成失败与 Store 提交失败分开分类；`commitRound()` 失败进入 `store_failed`，不会自动再次调用 Agent。
- 人工确认门只能由 `human` Actor 批准；核心和 Store 都会校验 approvalId、gate 与 expectedVersion。

## 身份边界

`RoundPlan.adapterId` 决定调用哪个运行时适配器，`RoundPlan.actorId` 决定以哪个已注册且处于
`active` 状态的 Actor 写入 Council。运行时适配器名、模型名和持久化身份彼此独立；
DeepSeek、Kimi 等供应商拥有各自 Actor，不再共享 `other` 作者槽位。

`approvedByActorId` 是审计字段，不是身份认证本身。HTTP/MCP 边界必须从可信调用者派生
固定的 `human` Actor，不能直接信任浏览器提交的身份字符串。新运行快照使用 schema v2
并冻结 `actorId`；旧 v1 快照只在读取时通过历史映射兼容，其中 `other` 映射到不可用于
新写入的 `legacy-unknown`。`SQLiteCouncilStore` 按构造参数只读取最新 N 条公开消息，
避免超大议题在 Agent 提示裁剪之前放大内存。

## 接入点

现有 `ClaudeClient` 不能直接充当 `AgentAdapter`，因为它自带写消息行为。适配器必须使用无数据库副作用的纯 ClaudeRuntime，把“调用模型”和“原子写回”分开。`SQLiteCouncilStore` 会追加运行、批准和 lease 表，以批准唯一约束实现幂等，以 topic 部分唯一索引限制单个活动运行，并仅通过运行表触发器推进 `council_meta.revision`。lease 表没有 revision trigger，避免心跳制造 SSE 风暴。

`start()`、`approve()`、`recover()` 是短任务和测试可用的同步便捷入口，调用者必须显式提供 `ownerId`、`ttlMs`、`renewIntervalMs`，方法内部会续租。生产 HTTP 应优先使用拆分后的控制面方法和长期 ExecutionManager。旧 v1 快照缺少 cleanup 字段时，codec 只用 `LEGACY_AGENT_CLEANUP_TIMEOUT_MS` 协议迁移常量回填；它不是新运行的配置来源。

Codex 当前没有经过验证的可靠后台适配器。本包只保留通用接口，不伪造 Codex CLI 能力；在真实适配器出现前，Codex 轮次应停在人工门或由前台会话手动接力。

## 开发

```bash
npm install
npm run check
npm test
npm run build
npm audit --audit-level=high
```

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 配置 | 独立构建、检查与测试命令 |
| `package-lock.json` | 锁定 | 固定开发依赖解析结果 |
| `tsconfig.json` | 配置 | 严格 TypeScript 编译规则 |
| `src/` | 核心 | 状态机、端口、类型与错误模型 |
| `test/` | 验证 | Fake 端口和编排边界测试 |
