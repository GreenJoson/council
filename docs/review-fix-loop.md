# 审核闭环与执行账本

> 本文是「审核 → 修复 → 复审 → 收敛」闭环与 work item 树的设计正本。
> 改动跨 SQLite schema v12、orchestrator 状态机、MCP 工具与 Web UI，实施前以本文为准。

## 1. 病因：用辩论状态机跑代码审查

现有圆桌只有一个收敛状态机（`packages/orchestrator/src/cycle/convergence.ts`）：

```
提案 → 评审(全员) → 有 blocking → 反驳 → 再评审 → 轮次用尽 → 放弃
                  ↘ 无 blocking → 收敛 → 生成 proposed 决策
```

它为**架构辩论**而设计，收敛条件是「说服对方」。代码审查的收敛条件是「修掉问题」。
把后者塞进前者，产生三个必然后果：

1. **`rebuttal` 阶段在审 bug 时空转。** 该阶段语义是提案人口头回应，代码不变，
   评审第二轮看到的仍是同一份 diff。`stage-instructions.ts` 的 `FIX_SPEC` 明确要求
   「本轮不负责修改代码…不要修改文件、创建提交」——圆桌全员只读，没有角色能修。
2. **终点是「放弃」而不是「修完」。** 预算耗尽仍有 blocking 时走 `abandon`，
   理由 `round_budget_exhausted`；认真审出的问题最后收到的结论是「放弃本轮圆桌」。
3. **闭环缺的那一环由用户手工承担。** 审完的意见散落在讨论消息里，用户自己切到外部
   Agent 去修、自己提交、再回来重新开局；新一轮圆桌不知道上一轮提过什么，
   也没有任何地方记录「上轮 5 个问题，修了 3 个，还剩 2 个」。

繁琐感不在任何单个步骤里，而在步骤之间。

## 2. 统一模型：审核意见就是任务

四个诉求共用一套数据结构和一个状态机，而不是各长一套：

| 诉求 | 在统一模型里的位置 |
|---|---|
| 侧边栏显示完成度 | 「本次审核 5 个问题，关了 3 个」 |
| 大任务 → 小任务树 | 审核批次（父）→ 每条发现（子） |
| 看不到外部 Agent 在做什么 | 它认领了第 4 条，状态 `in_progress` |
| 审 → 修 → 复审直到没问题 | 未关闭清单归零才收敛，而不是轮次用尽 |

**安全边界不变**：圆桌仍然全只读，Council 只维护账本。修复由外部 Agent 执行，
通过 MCP 工具认领任务、回写状态与 fix commit。

## 3. 数据模型（schema v12）

`work_items` 需重建表——SQLite 无法就地放宽 `NOT NULL` 与改唯一索引：

| 变更 | 原因 |
|---|---|
| `decision_id` 放宽为可空 | 审核发现产生时议题未必有 accepted 决策；锚点从「决策」放宽到「议题」 |
| 新增 `parent_id`（自引用，级联删除） | 任务树 |
| 新增生成列 `parent_key = COALESCE(parent_id, '')` | SQLite 中 NULL 不参与唯一比较，顶层任务需借它保住唯一约束 |
| 唯一索引改为 `(topic_id, parent_key, title COLLATE NOCASE)` | 原 `(decision_id, title)` 会拒绝不同父级下的同名子任务 |
| 新增 `sort_order` | 树内稳定排序 |
| 新增 `origin`（`manual` / `review_finding`） | 区分手工拆解与审核自动录入 |
| 新增 `severity`（`blocking` / `non_blocking`） | 决定是否阻塞收敛 |
| 新增 `source_message_id`、`source_cycle_id`、`review_round` | 每条发现可追溯到产生它的那次发言 |
| 新增 `fix_commit` | 修复证据 |
| 新增 `assignee_actor_id`、`claimed_at` | 「谁正在做哪一条」 |

**父任务状态派生**：父任务的 `status` 仍然入库，但写入路径拒绝手动更新任何拥有子任务的条目；
子任务变更时在同一事务内重算并写回父链（全完成→`completed`，有受阻→`blocked`，
有进行中→`in_progress`，否则 `pending`），同时维护 `completed_at` 以满足既有 CHECK 约束。
**完成度只数叶子节点**，父节点不计入分母。

## 4. 尾块协议扩展

现有 `council-verdict` 保留，表达整体立场。新增两个结构化尾块：

首审产出发现清单：

```council-findings
{"findings":[{"title":"...","severity":"blocking|non_blocking","file":"src/x.ts","line":42,"evidence":"...","suggestion":"..."}]}
```

复审逐条判定，只针对未关闭条目：

```council-review-result
{"results":[{"workItemId":"work_item_...","verdict":"fixed|still_broken","note":"..."}]}
```

服务端解析后自动落成 / 更新 work item，用户无需手工搬运。解析失败按 `blocking` 处理，
与既有 verdict 尾块的容错口径一致。

## 5. 审核收敛：同一个状态机，换一个收敛条件

**没有第二个状态机。** `ConvergenceState` 多了一个可选字段 `reviewLedger`，
只有 `fix_review` 圆桌带它。带账本时收敛条件从「没人再反对」换成「未关闭的阻断发现归零」：

```
proposal/critique  评审读 diff，产出 findings
  ├ 未关闭阻断 = 0 ─────────────→ converge → synthesis → proposed 决策
  └ 未关闭阻断 > 0 → await_fix
                       ↑                ↓ 外部 Agent 修复并提交（council_submit_fixes / 界面按钮）
                       └── still_broken ── 下一轮 critique（新 commit + 未关闭清单）
```

- 审核圆桌**不走 `rebuttal`**：口头回应改不了 diff，评审第二轮看到的还是同一份改动。
- `await_fix` 是新的动作而不是新的持久化阶段，落库仍是 `awaiting_user` 容器状态——
  避免为一个等待位重建 `discussion_cycles` 表。UI 用 `action.kind` 区分「等回答」和「等修复」。
- 轮次预算不再拦人：每一次复审都由外部显式提交触发，不存在自动空转，
  提交时预算跟着抬高。要停下来就放弃圆桌，而不是把一个还在推进的修复循环判成"预算耗尽"。
- **收敛判定推迟到对完账之后。** 一条发言里的审核发现要等它所在事务提交后才录进账本，
  所以 `recordCycleTurn` 对 `fix_review` 不就地推进到 synthesis；
  由驱动器先对账、再读账本、再落地 `converge`。就地推进等于用上一轮的问题数宣布这一轮通过。

## 6. MCP 工具契约

| 工具 | 变更 | 用途 |
|---|---|---|
| `council_add_work_items` | 新增 `parent_id` | 拆子任务 |
| `council_update_work_item` | 新增 `fix_commit` | 回写修复证据 |
| `council_list_work_items` | 新增 | 外部 Agent 拉取待办清单 |
| `council_claim_work_item` | 新增 | 认领并置 `in_progress`，写入 assignee |
| `council_submit_fixes` | 新增 | 公开自述本批修复的仓库与 commit |

MCP 进程只连 SQLite，不持有编排服务，因此 `council_submit_fixes` 只落一条带 `council-fix`
尾块的公开消息；开下一轮复审由 `POST /api/v1/topics/:topicId/cycle/fixes` 触发
（界面上的「已修复，开始复审」按钮）。复审读的 commit 取自公开消息里最后一次自述，
而不是开局那一份——否则等于让评审再看一遍已经被改掉的 diff。

账本同步由驱动器在每次推进前完成，靠三条规则保证重复执行零写入：
录入以「轮次 + 发言人」批次父级为幂等标记，复审判定只在状态确实要变时才写，
判定权限制在本圆桌自己产出的叶子条目上。

## 7. UI 变更

- 议题侧边栏：时间与完成度左右分列（无任务或未决策时不显示，避免一排 `0/0` 噪音）。
- 主区「任务」tab：平铺列表改为树，显示 severity、认领人与 fix commit；
  右栏只留完成度摘要。三处计数（侧边栏、tab 徽标、进度条）共用同一个只数叶子的口径——
  分母各算各的，用户会先怀疑数据错了。
- 所有新增界面文案同时进中英词典；`i18n-coverage.test.ts` 扫 `t("中文")` 字面量，
  漏翻译直接失败——双语靠机器守，不靠记性。
- 圆桌面板：`await_fix` 时显示「等待修复 · 还有 N 条阻断问题未关闭」与「已修复，开始复审」按钮。
  未关闭条目本身摆在实施进度卡片里——同一件事只在一个地方维护清单。

## 8. 落地状态

桌面端需重装一次（Rust 核心镜像 schema 版本，见 `schema-migration-safety.md`）。

1. ✅ schema v12 迁移 + Rust `SUPPORTED_SCHEMA_VERSION` 与列/索引断言同步
2. ✅ work item 树 CRUD、父状态派生、议题级完成度聚合（Node + Rust 双侧）
3. ✅ HTTP 契约与 MCP 工具（`council_list_work_items` / `council_claim_work_item` /
   `council_submit_fixes`，以及 claim 与 fixes 两条路由）
4. ✅ 审核账本收敛与尾块解析（`council-findings` / `council-review-result`）
5. ✅ Web UI：侧边栏完成度、实施进度树、圆桌等待修复位

Rust 核心只断言 schema 形状并读 `work_items`，不解码圆桌阶段，因此第 4 步没有 Rust 侧改动。
