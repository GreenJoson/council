# types - Council Web 领域类型

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `council.ts` | 核心 | 定义动态 Actor/Participant、Topic/Message/Decision 行级冻结快照、active topic、消息总数和可空决策 |
| `orchestration.ts` | Agent 调用 | 定义动态 Actor 能力、带执行 policy 的运行、单次完成复核选项、按议题隔离的临时 Agent 草稿和同步快照 |
| `agent-settings.ts` | 模型设置 | 定义 Provider 类型、不含密钥的公开设置、更新输入和连接测试结果 |
