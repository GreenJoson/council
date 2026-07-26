# cycle - 圆桌收敛协议

> ⚠️ 一旦本文件夹有所变化，请更新本文件

议题从「提案」走到「一条可执行的 proposed 决策」的固定四段协议。
只做 proposal → critique → rebuttal → synthesis，不做通用 DAG：通用编排能表达一切流程，
也就无法保证任何一次讨论会收敛。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `convergence.ts` | 协议正本 | 纯状态机：判定下一个该谁发言、何时进入反驳、何时收敛、何时因预算用尽放弃；无 IO、无时间、无随机，可重放 |
| `verdict.ts` | 安全边界 | 解析公开回复里的 `council-verdict` / `council-question` 尾块；尾块缺失或非法一律推定 `blocking`，绝不把格式错误读成同意 |
| `stage-instructions.ts` | 协议契约 | 四段指令与尾块格式说明的唯一正本；改这里等于改协议，必须同步 `verdict.ts` 的解析 |
| `cycle-codec.ts` | 安全边界 | 严格解码 cycle / 阻塞提问行，校验名册、轮次、挂起与回归阶段的一致性，并投影成状态机输入 |
| `cycle-commit.ts` | 原子边界 | 在轮次提交事务内把刚落库的公开消息记成一次发言并开出阻塞提问；消息与发言必须同生共死 |
| `cycle-repository.ts` | 数据访问 | 开局唯一性、按 `state_version` CAS 推进、提问挂起与回答（按公开消息 id 幂等）、收敛与放弃终态 |
| `runtime-capabilities.ts` | 能力正本 | 定义最小 RuntimeCapability、按周期类型/任务推导需求、策略与 Runtime 声明取交集，并在模型调用前报告缺口；`fix_review` 只审查已有 commit/diff，不授予写入、测试或提交能力 |
