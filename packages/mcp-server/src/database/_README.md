# database - 领域仓储

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `context.ts` | 契约 | `DatabaseContext`（连接、BEGIN IMMEDIATE 事务、可信 actorId/alias 解析）与 `TopicLookup`（议题存在性窄接口），由 `../database.ts` 构造期实现并注入 |
| `rows.ts` | 纯映射 | topics/messages/decisions/work_items/assets/asset_links/actor_identities 等行接口，行 → 领域对象映射，实施项叶子完成度汇总与父状态派生规则；快照与索引身份不一致直接抛错 |
| `topic-repository.ts` | 议题仓储 | alias/actorId 建题、显式并发令牌的议题更正、仍有活动圆桌/会话/委派即拒绝的安全关闭、单题读取、详情聚合（就地汇总完成度）与带完成度的分页列表 |
| `message-repository.ts` | 消息仓储 | 单条读取、指定 Actor 首条回复查找（幂等回答）、详情用的消息分页、alias/actorId 发消息并校验父消息同属议题 |
| `decision-repository.ts` | 决策仓储 | 议题决策列表、alias/actorId 记录决策（人工 Accepted 取代全部 proposed）、决策包逐项原地接受并同步议题 decided/open |
| `work-item-repository.ts` | 实施项仓储 | 叶子口径完成度批量查询、议题全量行读取、批量建项（手工拆解须绑定 Accepted 决策、审核发现可无决策、子项继承父决策）、乐观版本更新、认领、祖先状态派生与过滤列表；同时承担任务存储：按 id 读取、子项判断、无议题直接任务创建（同项目根级标题去重）与按项目路径的任务列表（priority/updated_at 降序），更新与认领的议题归属校验可选 |
| `asset-repository.ts` | 资产仓储 | v19 `assets`/`asset_links` 唯一数据访问：按 (项目, sha256) 查重、新建/恢复、公开 DTO 与内部存储记录（含 `storage_rel_path`，只给 `../assets/` 用）、按项目/kind/链接目标分页（默认不含软删除）、未删除字节总量、链接增删（目标须存在且同项目）、软删除；不碰文件系统 |

依赖方向：`../database.ts` → 各仓储 → `rows.ts` / `context.ts`。`CouncilDatabase` 持有连接、事务与
Actor 解析，用闭包实现 `DatabaseContext`，并以同名同签名的转发方法暴露仓储能力，调用方不感知拆分。
仓储之间只有一条边：`TopicRepository` 的详情/列表聚合消息、决策、实施项仓储；其余仓储通过
`TopicLookup` 闭包确认议题存在，不反向持有 `TopicRepository`。SQL 文本、错误消息与事务边界与拆分前逐字一致。
