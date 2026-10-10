# tasks - 任务列表、详情与新建

> ⚠️ 一旦本文件夹有所变化，请更新本文件

依赖方向：`app/WorkspaceMain → TasksView → TaskList / TaskDetail / TaskCreateDialog → use-tasks / use-task-detail → data/tasks 仓储`。代码委派面板与执行进度复用 `components/` 中的现成组件；产物区与图像委派读 `data/assets` 仓储，缩略图复用 `features/assets/AssetThumbnail`。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `TasksView.tsx` | 入口 | 创建一次任务仓储（列表、详情、新建对话框共享）与资产仓储（详情产物区与图像委派）；有 `taskId` 时渲染详情（按 id 重挂载），否则渲染列表；新建成功后跳到 `#/tasks/<新 id>` |
| `TaskList.tsx` | 列表 | 按 进行中/阻塞/待办/已完成 分组，提供类型与来源筛选、刷新与新建入口；未完成任务行显示最新委派状态 |
| `TaskDetail.tsx` | 详情 | 标题、元信息、「在讨论中打开」链接、正文，依次装配简报区、产物区（image 任务或有图像委派时）、状态更新表单与委派区；加载失败给重试入口 |
| `BriefSection.tsx` | 简报 | council-brief 结构化展示（参考资产链接到 `#/assets/<id>`），非 council-brief 回退键值列表；「编辑简报」经 `PUT /tasks/:id` 的 `brief` 保存 |
| `BriefEditor.tsx` | 简报 | 受控编辑器，表单 / JSON 两种模式；只有合法时才能从 JSON 切回表单；导出简报类型标签与问题列表 |
| `brief-form.ts` | 简报 | 表单草稿 ⇄ council-brief 的纯函数转换（创建草稿、序列化、解析、提交前校验），表单不覆盖的字段原样保留 |
| `TaskAssetsSection.tsx` | 产物 | `target=work_item:<id>` 的 output/final 资产缩略图、Lightbox 看原图、逐张设为/取消最终稿 |
| `TaskDelegationSection.tsx` | 委派 | 委派类型选择（代码 / 图像，有进行中的委派时锁定）、对应面板与历史委派 |
| `ImageDelegationPanel.tsx` | 委派 | 图像委派：执行者只列 granted 含 `image_generate` 的可用 Agent，无审核者；可选最多 8 张 reference 资产；human 验收 |
| `TaskStatusForm.tsx` | 写入 | 状态、说明（阻塞/完成时必填）、可选修复提交；提交带 `expectedVersion`，冲突时由详情重载 |
| `TaskCreateDialog.tsx` | 创建 | 原生 dialog 收集标题、正文、类型、优先级；开放 `code` 与 `image`，其余类型禁用并标注后续阶段；image 任务可附带简报（本地校验通过才提交） |
| `DelegationTimeline.tsx` | 展示 | 最新一条之外的历史委派：状态、时间、执行者/监督者、轮次、分支提交、失败分类与审计记录 |
| `use-tasks.ts` | 状态 | 按筛选加载任务列表，并为未完成任务并行取最新委派（单条失败不影响列表） |
| `use-task-detail.ts` | 状态 | 加载任务详情与委派（按创建时间倒序），提供状态更新、保存简报、发起委派（code / image）、取消委派与忙碌/错误状态；动作失败不抛出 |
| `task-labels.ts` | 常量 | 任务类型、来源的中文标签与可创建类型（code / image） |

刷新约定：任务仓储没有订阅接口，列表与详情在内容快照（`revision`）或编排 revision（`executionRevision`）变化时重取；各 effect 用 active 标记丢弃过期响应。mock 模式下任务仓储状态保存在实例内存，`TasksView` 卸载后重置。
