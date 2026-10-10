# app - Council Web 应用壳与路由

> ⚠️ 一旦本文件夹有所变化，请更新本文件

依赖方向：`main.tsx → app/App.tsx → app/use-* 控制器 → data/ 仓储`；`App.tsx` 只装配，`WorkspaceMain.tsx` 只做路由 → 视图接线；`components/` 与 `features/` 只依赖 `app/routes.ts` 的类型和纯函数（如 `buildHash`），不反向依赖控制器。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `App.tsx` | 入口 | 应用壳：创建内容/编排仓储，串起各控制器，处理桌面首次设置/致命错误/加载中前置态，渲染头部、侧栏、主区、对话框、错误条、toast 与状态栏 |
| `routes.ts` | 路由 | `WorkspaceView` 类型、`WORKSPACE_VIEWS` 常量与 `parseRoute`/`buildHash` 纯函数；`#/discussion[/<topicId>]`、`#/tasks[/<taskId>]`、`#/assets[/<assetId>]`、`#/decisions`、`#/architecture`、`#/attention`，未知或空 hash 回落 discussion |
| `use-workspace-route.ts` | 路由 | 订阅 `hashchange`、规范化初始 hash，并提供 `navigate(route, { replace })` |
| `use-topic-route-sync.ts` | 路由 | 选中议题与 `#/discussion/<topicId>` 双向同步；hash 指向不存在的议题时回落默认选题并改写 hash |
| `WorkspaceMain.tsx` | 视图分发 | 按路由渲染待处理、架构档案、决策记录、任务视图（`features/tasks/TasksView`，按项目 id 重挂载）、资产库（`features/assets/AssetsView`，按项目 id 重挂载）、议题讨论（含右栏检查器）或空工作区 |
| `app-states.tsx` | 展示 | 可恢复错误条、致命加载失败页与加载中页 |
| `use-workspace-content.ts` | 控制器 | 内容仓储加载与 SSE 订阅、选题、接受决策、关闭议题、人工决策、新建议题 |
| `use-orchestration-state.ts` | 控制器 | 编排快照与能力/运行错误、实施项委派状态、@ 召唤 run、圆桌、自动轮次与持久会话写操作 |
| `use-topic-actions.ts` | 控制器 | 跨内容与编排的议题内写操作：发帖（含 @ 召唤语法糖）与实施项拆分/新增/更新/认领/批量委派；单条委派已迁到任务页，由 `features/tasks` 直接调任务仓储 |
| `use-desktop-settings.ts` | 控制器 | 桌面日志库与项目设置加载、选择与最近项目切换 |
| `use-theme-preference.ts` | 控制器 | 主题偏好循环切换与跟随系统监听 |
| `use-toast.ts` | 控制器 | 共享 toast 文案与自动清除 |
