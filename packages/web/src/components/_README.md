# components - Operator Console 界面组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `HeaderBar.tsx` | 导航 | 提供品牌 logo、原生项目切换、日志库设置、模型设置、⌘K 搜索、主题切换和同步状态 |
| `ModelRouterDialog.tsx` | 设置 | 以固定高度左侧路由管理 Provider 与其 Agent；未配置模板仅在添加目录中按需出现，Claude/Codex 系统 Provider/Agent 均锁定身份且不显示删除入口 |
| `ModelRouterEditor.tsx` | 设置 | 右侧一次只编辑一个 Provider 连接或 Agent 身份；已知模板与系统 Provider 锁定供应商身份，Claude/Codex Agent 锁定名称与 alias，远程 Agent 可独立编辑身份 |
| `BrandGlyph.tsx` | 品牌 | 离线渲染受控 glyph、供应商名称和语义色；未知品牌使用通用网络图形，不写成 Other |
| `DesktopSetup.tsx` | 启动门 | 首次运行时依次选择日志库和当前项目 |
| `TopicSidebar.tsx` | 导航 | 导出 WorkspaceView 视图路由类型；展示轻量议题列表、状态筛选 chips 和议题/架构档案/决策记录三个真实可切换的导航项 |
| `DiscussionPanel.tsx` | 核心 | 组织议题头部、讨论/元数据双 tab（所有者优先使用议题冻结快照）、一卡一节点的阶梯导航、独立时间线、真实 Agent 回复动态、历史总数、引用回复和编辑器；过长议题问题默认收起，并把自动轮次状态透传给 Composer |
| `AgentReplyActivity.tsx` | 状态 | 从当前议题真实 `running/waiting_agent` Run 中选择最新活动 Agent，在时间线末尾显示 Provider 品牌、具体名称、阶段与同议题实时草稿；较大输出块逐帧平滑展开，完成后由正式消息接替，不进入阶梯节点计数 |
| `MessageJumpRail.tsx` | 导航 | 按当前议题实际消息卡数量渲染一一对应的阶梯节点；点击平滑跳转到对应卡片，当前阅读卡跟随滚动高亮 |
| `MessageCard.tsx` | 核心 | 以消息行冻结 Actor 快照展示历史作者，避免身份重命名改写旧卡片；渲染公开 proposal/critique/rebuttal/synthesis，并提供正文折叠、Markdown/Mermaid 与引用回复 |
| `MarkdownContent.tsx` | 基础 | 统一 Markdown 渲染入口（react-markdown + remark-gfm + rehype-raw/rehype-sanitize 白名单），提供标题降级、表格滚动、图片/Mermaid 缩略预览、大图浏览，以及正文/议题两种语义化底部折叠；折叠高度从主题 token 读取，内容切换后恢复默认收起；稳定组件映射避免 Mermaid 与高度测量互相触发重挂载 |
| `MermaidDiagram.tsx` | 基础 | 动态 import mermaid（首屏不加载）把源码渲染成固定上限缩略 SVG；按 data-theme 联动主题，securityLevel 显式声明为 strict；点击放大，失败降级为原始代码块 + 错误提示 |
| `Lightbox.tsx` | 基础 | 通过 body Portal 提供全视口大图浏览，支持图片与 mermaid SVG、50%–300% 缩放、内部滚动、快捷键和遮罩/Esc/关闭退出；不受消息卡 transform/裁剪影响 |
| `Composer.tsx` | 写入 | 发布带类型的公开回复（支持 ⌘Enter）、引用回复和动态 `@actor-id` 召唤；Claude、Codex、DeepSeek、Kimi API 与 Kimi Code 均使用独立 Actor 身份；发布成功后创建并启动受控运行，离线或同议题已有活动运行时明确拦截 |
| `InspectorPanel.tsx` | 决策 | 组织自动轮次、真实约束、证据、备选方案和可空拟议决策；owner/备选作者优先使用各自行冻结快照 |
| `CyclePanel.tsx` | 圆桌 | 开局勾选参与名册（首位为提案人）与持久化周期类型，展示 Runtime 能力、启动前缺口、阶段轨道、阻断结果、缺失 verdict 与累计度量 |
| `AutoRoundsPanel.tsx` | 编排 | 展示 Agent 能力、单一当前调用卡、折叠历史、已决议题统一阻断及每 Agent 最新逻辑绑定状态/关闭/重开操作 |
| `CreateTopicDialog.tsx` | 创建 | 收集议题问题和约束，桌面端可选择目标项目（当前/最近/浏览），失败时保留输入以便重试 |
| `ArchitectureView.tsx` | 视图 | 项目架构档案：从讨论决策聚合生成的架构沉淀页（项目概览/演进时间线/不变量/图集四区块，拆分在 `architecture/` 子目录），经 `useTopicDetails` 一次性加载全部议题详情，内容区块见 `architecture/_README.md` |
| `DecisionRecordsView.tsx` | 视图 | 左列表右详情的 ADR 归档；owner、决策提出者和备选作者优先使用历史行冻结快照，详情按需加载并支持失败重试与定位 |
| `presentation.tsx` | 基础 | 统一品牌 logo、冻结 Actor 快照到 Participant 的转换、动态头像回退、议题状态与决策状态标签/徽章 |
| `StatusBar.tsx` | 基础 | 底部状态条：右下角显示构建身份（版本 · commit · 构建时间），由 vite.config 在构建期注入；semver 不随重建变化，靠 commit 与时间区分手上跑的是哪个包 |
| `architecture/` | 视图 | ArchitectureView 的四个内容区块子组件，见 `architecture/_README.md` |
