# src - Council Web 客户端源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `main.tsx` | 入口 | 按稳定层级加载字体、主题、界面语言和拆分样式，并挂载 React 应用 |
| `vite-env.d.ts` | 类型 | 声明 Vite 客户端和环境变量类型 |
| `app/` | 核心 | App 壳与 hash 路由（`#/discussion|tasks|decisions|architecture|attention`），以及内容/编排/桌面设置/议题写操作控制器，见 `app/_README.md` |
| `features/` | 功能 | 按业务领域组织的独立视图，目前只有 `tasks/` 任务列表/详情/新建，见 `features/_README.md` |
| `components/` | 展示 | 保存三栏工作台和交互组件（含 `architecture/` 架构档案子组件） |
| `data/` | 数据 | 隔离内容/编排及其 mock、HTTP/SSE 与 Tauri IPC 实现 |
| `hooks/` | 逻辑 | 保存跨组件复用的数据加载 hook |
| `i18n/` | 国际化 | 保存中英界面词典、系统语言探测、手动偏好持久化与 React 翻译上下文 |
| `styles/` | 视觉 | 保存语义主题变量、任务视图、流体讨论列、媒体缩略/大图浏览、布局和响应式样式 |
| `types/` | 类型 | 保存 WebUI 内容、编排与 Agent 设置领域模型 |
