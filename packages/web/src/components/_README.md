# components - Operator Console 界面组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `HeaderBar.tsx` | 导航 | 提供原生项目切换、日志库设置、搜索、同步状态和全局操作 |
| `DesktopSetup.tsx` | 启动门 | 首次运行时依次选择日志库和当前项目 |
| `TopicSidebar.tsx` | 导航 | 展示轻量议题列表并触发受控详情加载 |
| `DiscussionPanel.tsx` | 核心 | 组织议题头部、最近消息、历史总数、同步状态和回复编辑器 |
| `MessageCard.tsx` | 核心 | 展示公开 proposal、critique、rebuttal 和 synthesis |
| `Composer.tsx` | 写入 | 发布带类型的公开回复、显示同步状态并在失败时保留草稿 |
| `InspectorPanel.tsx` | 决策 | 组织自动轮次、真实约束、证据、备选方案和可空拟议决策 |
| `AutoRoundsPanel.tsx` | 编排 | 展示 Agent 能力、互斥操作、恢复预算及 Run 生命周期控制 |
| `CreateTopicDialog.tsx` | 创建 | 收集议题问题和约束，失败时保留输入以便重试 |
| `presentation.tsx` | 基础 | 统一 Agent 头像和状态标签展示 |
