# types - Council Web 领域类型

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `council.ts` | 核心 | 定义动态 Actor/Participant、Topic/Message/Decision 行级冻结快照、Human / Accepted 人工决策输入、active topic、消息总数和可空决策；实施项含 v18 任务字段 kind/source/priority/projectPath/brief 与可选 topicId，并导出 `WORK_ITEM_KINDS`/`WORK_ITEM_SOURCES` |
| `orchestration.ts` | Agent 调用 | 定义能力、运行、公开 RuntimeBinding、周期类型/需求/Runtime 快照、结构化阻断结果、单次完成复核、委派验收策略/标准/恢复来源和临时草稿；委派 topicId 可选并含 kind/inputAssetIds/outputManifest，新增按任务发起的 `StartTaskDelegationInput` |
| `tasks.ts` | 任务 | 定义任务列表筛选、任务详情（任务 + 议题摘要 + 委派 + 离线 limitation）、直接任务创建与状态更新输入 |
| `team.ts` | 团队 | 定义 P4 任务团队与 Worker（状态常量、聚焦、分支/合并提交、范围目录、委派摘要），团队模式发起入参与结果；字段与 REST 契约一一对应 |
| `pipelines.ts` | 流水线 | 定义 P3 模板/阶段/阶段状态常量、`council-pipeline` 文档（schemaVersion 1）、列表项与列表结果（含离线 limitation）、详情与新建输入 |
| `model-router.ts` | 模型路由 | 定义 Provider、Agent、BrandAsset、catalog、不含密钥的写入输入和连接测试结果 |

WorkItemDelegation 的 execution 为可选白名单进度，旧运行可以没有指标；会话 ID 和原始指令不属于公开类型。
