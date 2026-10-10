# features - 按业务领域组织的功能视图

> ⚠️ 一旦本文件夹有所变化，请更新本文件

每个子目录是一个完整的业务功能：视图组件、状态 hook 与本功能专用的标签常量放在一起；数据访问走 `data/` 仓储，路由只用 `app/routes.ts` 的类型与 `buildHash`，不依赖 `app/` 控制器。可复用的通用组件仍留在 `components/`。

| 目录 | 地位 | 功能 |
|---|---|---|
| `architecture/` | 架构档案 | 架构档案视图 `ArchitectureView` 与概览/演进时间线/不变量/图集/附件区块子组件，见 `architecture/_README.md` |
| `assets/` | 资产 | `#/assets` 资产库网格（kind 筛选、分页）、`#/assets/<id>` 资产详情（预览、挂接、final、删除）与导入对话框，见 `assets/_README.md` |
| `decisions/` | 决策记录 | 左列表右详情的 ADR 决策档案 `DecisionRecordsView`，见 `decisions/_README.md` |
| `discussion/` | 讨论 | 议题讨论区 `DiscussionPanel`（消息卡、阶梯导航、回复动态、编辑器）、右侧上下文栏 `InspectorPanel`（圆桌、自动轮次）与新建议题/人工决策对话框，见 `discussion/_README.md` |
| `pipelines/` | 流水线 | `#/pipelines` 流水线列表（等待我处理/进行中/失败/已完成分组）、`#/pipelines/<id>` 详情（阶段轨道、确认 brief、并排对比选 final、恢复、取消）与新建流水线对话框，见 `pipelines/_README.md` |
| `tasks/` | 任务 | `#/tasks` 任务列表（按状态分组、类型/来源筛选）、`#/tasks/<id>` 任务详情（简报、产物、状态更新、代码/图像委派、历史委派）与新建任务对话框，见 `tasks/_README.md` |
