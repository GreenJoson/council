# tasks - 任务列表、详情与新建

> ⚠️ 一旦本文件夹有所变化，请更新本文件

依赖方向：`app/WorkspaceMain → TasksView → TaskList / TaskDetail / TaskCreateDialog → use-tasks / use-task-detail → data/tasks 仓储`。单条委派面板与执行进度复用 `components/` 中的现成组件。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `TasksView.tsx` | 入口 | 创建一次任务仓储，在列表、详情、新建对话框间共享；有 `taskId` 时渲染详情（按 id 重挂载），否则渲染列表；新建成功后跳到 `#/tasks/<新 id>` |
| `TaskList.tsx` | 列表 | 按 进行中/阻塞/待办/已完成 分组，提供类型与来源筛选、刷新与新建入口；未完成任务行显示最新委派状态 |
| `TaskDetail.tsx` | 详情 | 标题、状态/类型/来源/优先级/版本元信息、「在讨论中打开」链接、正文与 brief、状态更新表单、最新委派面板与历史委派；加载失败给重试入口 |
| `TaskStatusForm.tsx` | 写入 | 状态、说明（阻塞/完成时必填）、可选修复提交；提交带 `expectedVersion`，冲突时由详情重载 |
| `TaskCreateDialog.tsx` | 创建 | 原生 dialog 收集标题、正文、类型、优先级；P1 只开放 `code` 类型，其余类型禁用并标注 P2 |
| `DelegationTimeline.tsx` | 展示 | 最新一条之外的历史委派：状态、时间、执行者/监督者、轮次、分支提交、失败分类与审计记录 |
| `use-tasks.ts` | 状态 | 按筛选加载任务列表，并为未完成任务并行取最新委派（单条失败不影响列表） |
| `use-task-detail.ts` | 状态 | 加载任务详情与委派（按创建时间倒序），提供状态更新、发起委派、取消委派与忙碌/错误状态；动作失败不抛出 |
| `task-labels.ts` | 常量 | 任务类型、来源的中文标签与 P1 可创建类型 |

刷新约定：任务仓储没有订阅接口，列表与详情在内容快照（`revision`）或编排 revision（`executionRevision`）变化时重取；各 effect 用 active 标记丢弃过期响应。mock 模式下任务仓储状态保存在实例内存，`TasksView` 卸载后重置。
