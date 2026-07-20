# components - Operator Console 界面组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `HeaderBar.tsx` | 导航 | 提供品牌 logo、原生项目切换（路径展示、点外/Esc 关闭）、日志库设置、⌘K 搜索、主题切换和同步状态 |
| `DesktopSetup.tsx` | 启动门 | 首次运行时依次选择日志库和当前项目 |
| `TopicSidebar.tsx` | 导航 | 导出 WorkspaceView 视图路由类型；展示轻量议题列表、状态筛选 chips 和议题/架构档案/决策记录三个真实可切换的导航项 |
| `DiscussionPanel.tsx` | 核心 | 组织议题头部、讨论/元数据双 tab（元数据含议题 ID 复制、完整问题、所有者/参与者、消息统计）、历史总数、同步状态、引用回复发起和回复编辑器；议题问题经 MarkdownContent 渲染（不折叠） |
| `MessageCard.tsx` | 核心 | 展示公开 proposal、critique、rebuttal 和 synthesis（正文经 MarkdownContent 渲染并可折叠，含内嵌 mermaid 围栏自动渲染成图），并提供"引用回复"发起 Markdown 引用 |
| `MarkdownContent.tsx` | 基础 | 统一 Markdown 渲染入口（react-markdown + remark-gfm + rehype-raw/rehype-sanitize 白名单），提供标题降级、表格横向滚动、代码块/图片样式、```mermaid 围栏内联渲染成图（走 MermaidDiagram，不经 rehype-raw）、图片/图表 Lightbox 与长内容折叠 |
| `MermaidDiagram.tsx` | 基础 | 动态 import mermaid（首屏不加载）把源码渲染成 SVG；按 data-theme 用 MutationObserver 联动 default/dark 主题；securityLevel 显式声明为 strict；渲染失败降级为原始代码块 + 错误提示；MarkdownContent 与架构档案图集共用 |
| `Lightbox.tsx` | 基础 | 全屏放大浏览（遮罩/Esc/关闭按钮三种退出方式），支持图片与 mermaid SVG 两种内容；MarkdownContent 与架构档案图集共用同一份实现 |
| `Composer.tsx` | 写入 | 发布带类型的公开回复（支持 ⌘Enter）、承接引用回复种子并聚焦编辑器、显示同步状态并在失败时保留草稿 |
| `InspectorPanel.tsx` | 决策 | 组织自动轮次、真实约束、证据、备选方案和可空拟议决策（summary/rationale 经 MarkdownContent 渲染，proposed/accepted/superseded 三态徽章走 presentation.tsx 的 DecisionStatusBadge） |
| `AutoRoundsPanel.tsx` | 编排 | 展示 Agent 能力、互斥操作、恢复预算及 Run 生命周期控制 |
| `CreateTopicDialog.tsx` | 创建 | 收集议题问题和约束，桌面端可选择目标项目（当前/最近/浏览），失败时保留输入以便重试 |
| `ArchitectureView.tsx` | 视图 | 项目架构档案：从讨论决策聚合生成的架构沉淀页（项目概览/演进时间线/不变量/图集四区块，拆分在 `architecture/` 子目录），经 `useTopicDetails` 一次性加载全部议题详情，内容区块见 `architecture/_README.md` |
| `DecisionRecordsView.tsx` | 视图 | 左列表（仅 decided 议题）右详情的 ADR 归档（summary/rationale/原始问题经 MarkdownContent 渲染、不折叠，proposed/accepted/superseded 三态徽章走 DecisionStatusBadge）；详情经 `useTopicDetails` hook 按需懒加载并以 Map 缓存，含加载骨架、失败重试、过期响应防护，以及架构档案跳转过来的 focusRequest 定位 |
| `presentation.tsx` | 基础 | 统一品牌 logo、Agent 头像、议题状态标签（topicStatusLabels）与决策状态标签/徽章（decisionStatusLabels、DecisionStatusBadge，proposed/accepted/superseded 三态） |
| `architecture/` | 视图 | ArchitectureView 的四个内容区块子组件，见 `architecture/_README.md` |
