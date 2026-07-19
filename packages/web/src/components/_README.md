# components - Operator Console 界面组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `HeaderBar.tsx` | 导航 | 提供品牌 logo、原生项目切换（路径展示、点外/Esc 关闭）、日志库设置、⌘K 搜索、主题切换和同步状态 |
| `DesktopSetup.tsx` | 启动门 | 首次运行时依次选择日志库和当前项目 |
| `TopicSidebar.tsx` | 导航 | 导出 WorkspaceView 视图路由类型；展示轻量议题列表、状态筛选 chips 和议题/架构视图/决策记录三个真实可切换的导航项 |
| `DiscussionPanel.tsx` | 核心 | 组织议题头部、讨论/元数据双 tab（元数据含议题 ID 复制、完整问题、所有者/参与者、消息统计）、历史总数、同步状态、引用回复发起和回复编辑器 |
| `MessageCard.tsx` | 核心 | 展示公开 proposal、critique、rebuttal 和 synthesis，并提供"引用回复"发起 Markdown 引用 |
| `Composer.tsx` | 写入 | 发布带类型的公开回复（支持 ⌘Enter）、承接引用回复种子并聚焦编辑器、显示同步状态并在失败时保留草稿 |
| `InspectorPanel.tsx` | 决策 | 组织自动轮次、真实约束、证据、备选方案和可空拟议决策 |
| `AutoRoundsPanel.tsx` | 编排 | 展示 Agent 能力、互斥操作、恢复预算及 Run 生命周期控制 |
| `CreateTopicDialog.tsx` | 创建 | 收集议题问题和约束，桌面端可选择目标项目（当前/最近/浏览），失败时保留输入以便重试 |
| `ArchitectureView.tsx` | 视图 | 按 TopicStatus 五列看板展示 workspace.topics 摘要，点击卡片打开议题，仅用已加载数据不发起请求 |
| `DecisionRecordsView.tsx` | 视图 | 左列表（仅 decided 议题）右详情的 ADR 归档；详情经 `loadTopicDetail` 按需懒加载并以 Map 缓存，含加载骨架、失败重试与过期响应防护 |
| `presentation.tsx` | 基础 | 统一品牌 logo、Agent 头像和中文状态标签展示（topicStatusLabels 供架构视图复用） |
