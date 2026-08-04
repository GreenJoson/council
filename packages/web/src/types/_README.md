# types - Council Web 领域类型

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `council.ts` | 核心 | 定义动态 Actor/Participant、Topic/Message/Decision 行级冻结快照、Human / Accepted 人工决策输入、active topic、消息总数和可空决策 |
| `orchestration.ts` | Agent 调用 | 定义能力、运行、公开 RuntimeBinding、周期类型/需求/Runtime 快照、结构化阻断结果、单次完成复核和临时草稿 |
| `model-router.ts` | 模型路由 | 定义 Provider、Agent、BrandAsset、catalog、不含密钥的写入输入和连接测试结果 |
