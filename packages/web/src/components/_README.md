# components - Operator Console 界面组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `HeaderBar.tsx` | 导航 | 提供品牌 logo、原生项目切换、日志库设置、模型设置、⌘K 搜索、主题切换和同步状态 |
| `AgentSettingsDialog.tsx` | 设置 | 以固定高度的左侧路由列表管理已添加模型；未配置远程 Provider 仅在“添加 Provider”目录中按需出现 |
| `AgentSettingEditor.tsx` | 设置 | 右侧一次只编辑一个本机 Agent 或远程 Provider，处理 Keychain 凭据、启停、保存、测试与移除确认 |
| `DesktopSetup.tsx` | 启动门 | 首次运行时依次选择日志库和当前项目 |
| `TopicSidebar.tsx` | 导航 | 导出 WorkspaceView 视图路由类型；展示轻量议题列表、状态筛选 chips 和议题/架构档案/决策记录三个真实可切换的导航项 |
| `DiscussionPanel.tsx` | 核心 | 组织议题头部、讨论/元数据双 tab（元数据含议题 ID 复制、完整问题、所有者/参与者、消息统计）、一卡一节点的阶梯导航、带尾部阅读空间的独立时间线、真实 Agent 回复动态、历史总数、同步状态、引用回复发起和回复编辑器；过长议题问题经 MarkdownContent 默认收起，短问题不显示控件；把自动轮次快照与忙碌态透传给 Composer，支撑动态 `@agent` 召唤自动补全与冲突判断 |
| `AgentReplyActivity.tsx` | 状态 | 从当前议题真实 `running/waiting_agent` Run 中选择最新活动 Agent，在时间线末尾显示具体名称、阶段与同议题实时草稿；较大输出块逐帧平滑展开，完成后由正式消息接替，不进入阶梯节点计数 |
| `MessageJumpRail.tsx` | 导航 | 按当前议题实际消息卡数量渲染一一对应的阶梯节点；点击平滑跳转到对应卡片，当前阅读卡跟随滚动高亮 |
| `MessageCard.tsx` | 核心 | 展示公开 proposal、critique、rebuttal 和 synthesis（正文经 MarkdownContent 渲染并在底部提供唯一的展开/收起入口，含内嵌 mermaid 围栏自动渲染成图）；并提供"引用回复"发起 Markdown 引用与召唤芯片 |
| `MarkdownContent.tsx` | 基础 | 统一 Markdown 渲染入口（react-markdown + remark-gfm + rehype-raw/rehype-sanitize 白名单），提供标题降级、表格滚动、图片/Mermaid 缩略预览、大图浏览，以及正文/议题两种语义化底部折叠；折叠高度从主题 token 读取，内容切换后恢复默认收起；稳定组件映射避免 Mermaid 与高度测量互相触发重挂载 |
| `MermaidDiagram.tsx` | 基础 | 动态 import mermaid（首屏不加载）把源码渲染成固定上限缩略 SVG；按 data-theme 联动主题，securityLevel 显式声明为 strict；点击放大，失败降级为原始代码块 + 错误提示 |
| `Lightbox.tsx` | 基础 | 通过 body Portal 提供全视口大图浏览，支持图片与 mermaid SVG、50%–300% 缩放、内部滚动、快捷键和遮罩/Esc/关闭退出；不受消息卡 transform/裁剪影响 |
| `Composer.tsx` | 写入 | 发布带类型的公开回复（支持 ⌘Enter）、引用回复和动态 `@adapter-id` 召唤；本机保持 `@claude`/`@codex`，共享 other 作者槽位的远程 Provider 使用 `@deepseek`/`@kimi` 防止歧义；发布成功后创建并启动受控运行，离线或同议题已有活动运行时明确拦截 |
| `InspectorPanel.tsx` | 决策 | 组织自动轮次、真实约束、证据、备选方案和可空拟议决策（summary/rationale 经 MarkdownContent 渲染，proposed/accepted/superseded 三态徽章走 presentation.tsx 的 DecisionStatusBadge） |
| `AutoRoundsPanel.tsx` | 编排 | 展示 Agent 能力、互斥操作、恢复预算及 Run 生命周期控制 |
| `CreateTopicDialog.tsx` | 创建 | 收集议题问题和约束，桌面端可选择目标项目（当前/最近/浏览），失败时保留输入以便重试 |
| `ArchitectureView.tsx` | 视图 | 项目架构档案：从讨论决策聚合生成的架构沉淀页（项目概览/演进时间线/不变量/图集四区块，拆分在 `architecture/` 子目录），经 `useTopicDetails` 一次性加载全部议题详情，内容区块见 `architecture/_README.md` |
| `DecisionRecordsView.tsx` | 视图 | 左列表（仅 decided 议题）右详情的 ADR 归档（summary/rationale/原始问题经 MarkdownContent 渲染、不折叠，proposed/accepted/superseded 三态徽章走 DecisionStatusBadge）；详情经 `useTopicDetails` hook 按需懒加载并以 Map 缓存，含加载骨架、失败重试、过期响应防护，以及架构档案跳转过来的 focusRequest 定位 |
| `presentation.tsx` | 基础 | 统一品牌 logo、Agent 头像、议题状态标签（topicStatusLabels）与决策状态标签/徽章（decisionStatusLabels、DecisionStatusBadge，proposed/accepted/superseded 三态） |
| `architecture/` | 视图 | ArchitectureView 的四个内容区块子组件，见 `architecture/_README.md` |
