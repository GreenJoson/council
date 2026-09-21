# components - Operator Console 界面组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `DelegationExecutionProgress.tsx` | 委派进度 | 真实执行阶段、预算暂停和可观测指标，未知数据不补造 |
| `RuntimeAuditDetails.tsx` | 执行记录 | 按来源分页加载阶段/工具/提交证据，保留空态、错误和刷新反馈 |
| `WorkAttentionView.tsx` | 待处理 | 聚合当前项目真实待处理状态，点击回到原议题 |
| `DelegationRecoveryActions.tsx` | 恢复 | 展示失败分类指引，显式恢复已提交进度或接续未提交代码，保留原记录并反馈冲突 |
| `HeaderBar.tsx` | 导航 | 提供品牌 logo、原生项目切换、日志库设置、模型设置、⌘K 搜索、中/EN 持久语言切换、主题切换和同步状态 |
| `ModelRouterDialog.tsx` | 设置 | 以固定高度左侧路由管理 Provider 与其 Agent；未配置模板仅在添加目录中按需出现，Claude/Codex 系统 Provider/Agent 均锁定身份且不显示删除入口 |
| `ModelRouterEditor.tsx` | 设置 | 右侧一次只编辑一个 Provider 连接或 Agent 身份；可设置顾问/执行/审核职责与显式委派的权限上限，普通 `@` 讨论始终只读 |
| `BrandGlyph.tsx` | 品牌 | 离线渲染受控 glyph、供应商名称和语义色；未知品牌使用通用网络图形，不写成 Other |
| `DesktopSetup.tsx` | 启动门 | 首次运行时依次选择日志库和当前项目 |
| `TopicSidebar.tsx` | 导航 | 导出 WorkspaceView 视图路由类型；展示轻量议题列表、状态筛选 chips 和议题/架构档案/决策记录/需要我处理四个真实可切换的导航项；议题行的时间与实施完成度左右分列，未拆分实施项时不渲染徽标 |
| `DiscussionPanel.tsx` | 核心 | 组织议题头部、关闭入口、讨论/决策/任务/元数据 tab（任务徽标只数叶子任务的完成数/总数，与侧边栏和实施进度卡共用一套口径；所有者优先使用议题冻结快照）、一卡一节点的阶梯导航、独立时间线、真实 Agent 回复动态、人工决策入口、引用回复和编辑器；过长议题问题默认收起 |
| `AgentReplyActivity.tsx` | 状态 | 从当前议题真实 `running/waiting_agent` Run 中选择最新活动 Agent，在时间线末尾显示 Provider 品牌、具体名称、阶段与同议题实时草稿；较大输出块逐帧平滑展开，完成后由正式消息接替，不进入阶梯节点计数 |
| `MessageJumpRail.tsx` | 导航 | 按当前议题实际消息卡数量渲染一一对应的阶梯节点；点击平滑跳转到对应卡片，当前阅读卡跟随滚动高亮 |
| `MessageCard.tsx` | 核心 | 以消息行冻结 Actor 快照展示历史作者，避免身份重命名改写旧卡片；渲染公开 proposal/critique/rebuttal/synthesis，把 `council-fix` 尾块呈现为关联提交证据卡，并提供正文折叠、Markdown/Mermaid 与引用回复 |
| `MarkdownContent.tsx` | 基础 | 统一 Markdown 渲染入口（react-markdown + remark-gfm + rehype-raw/rehype-sanitize 白名单），提供标题降级、表格滚动、图片/Mermaid 缩略预览、大图浏览，以及正文/议题两种语义化折叠；议题展开后把唯一收起入口移到正文顶部并吸顶，折叠高度从主题 token 读取，内容切换后恢复默认收起；稳定组件映射避免 Mermaid 与高度测量互相触发重挂载 |
| `MermaidDiagram.tsx` | 基础 | 动态 import mermaid（首屏不加载）把源码渲染成固定上限缩略 SVG；按 data-theme 联动主题，securityLevel 显式声明为 strict；点击放大，失败降级为原始代码块 + 错误提示 |
| `Lightbox.tsx` | 基础 | 通过 body Portal 提供全视口大图浏览，支持图片与 mermaid SVG、50%–300% 缩放、内部滚动、快捷键和遮罩/Esc/关闭退出；不受消息卡 transform/裁剪影响 |
| `Composer.tsx` | 写入 | 发布带类型的公开回复（支持 ⌘Enter）、当前项目自动绑定且支持一个输入框批量粘贴多 commit 的结构化关联提交、引用回复和动态 `@actor-id` 召唤；Claude、Codex、DeepSeek、Kimi API 与 Kimi Code 均使用独立 Actor 身份；发布成功后创建并启动受控运行，离线或同议题已有活动运行时明确拦截 |
| `ImplementationProgress.tsx` | 执行 | 导出右栏 `ImplementationSummary` 完成度摘要与主区 `ImplementationProgress` 任务清单；接受决策不自动调用规划 Agent，用户须先显式选择 Agent 再触发分拆，也可手动添加；任务按 `parentId` 渲染成父子两层，父任务状态由子任务派生且不可手改，完成度只数叶子；审核发现标出阻断/非阻断与复审轮次，叶子可认领并回写修复 commit |
| `WorkItemDelegationPanel.tsx` | Agent 执行 | 任务卡内选择两个不同 Agent 分任执行者和监督者，按次选择不超过 Agent 上限的写入权限，冻结验收标准与完成策略，并展示执行/审核/退回/分支提交、待人工验收、审计和恢复状态 |
| `InspectorPanel.tsx` | 决策 | 组织紧凑实施进度、自动轮次、真实约束、证据、备选方案、可空拟议决策和 Human / Accepted 人工结束入口；长任务清单交给主列任务 tab，owner/备选作者优先使用各自行冻结快照 |
| `CyclePanel.tsx` | 圆桌 | 开局勾选参与名册，按 Actor 标出发起人并展示“首轮跳过”后的真实顺序；以分段控件选择方案/当前工作区/Commit 三种范围，并展示能力缺口、阶段轨道、阻断结果与累计度量；审核圆桌停在 `await_fix` 时给出未关闭数与「已修复，开始复审」入口 |
| `AutoRoundsPanel.tsx` | 编排 | 仅在存在 Run 或持久会话时展示紧凑运行状态、单一当前调用卡、折叠历史及会话关闭/重开；单次启动统一由 Composer `@Agent` 承担 |
| `CreateTopicDialog.tsx` | 创建 | 收集议题问题和约束，桌面端可选择目标项目（当前/最近/浏览），失败时保留输入以便重试 |
| `ManualDecisionDialog.tsx` | 决策 | 让用户填写最终结论与可选验证/部署说明，明确以 Human / Accepted 直接结束议题且不创建 Agent Run |
| `ArchitectureView.tsx` | 视图 | 项目架构档案：从讨论决策聚合生成的架构沉淀页（项目概览/演进时间线/不变量/图集四区块，拆分在 `architecture/` 子目录），经 `useTopicDetails` 一次性加载全部议题详情；后三个长区块可点标题栏收起，折叠状态跨会话保留，内容区块见 `architecture/_README.md` |
| `DecisionRecordsView.tsx` | 视图 | 左列表右详情的 ADR 归档；owner、决策提出者和备选作者优先使用历史行冻结快照，详情按需加载并支持失败重试与定位 |
| `presentation.tsx` | 基础 | 统一品牌 logo、冻结 Actor 快照到 Participant 的转换、动态头像回退、议题状态与决策状态标签/徽章 |
| `StatusBar.tsx` | 基础 | 底部状态条：右下角显示构建身份（版本 · commit · 构建时间），由 vite.config 在构建期注入；semver 不随重建变化，靠 commit 与时间区分手上跑的是哪个包 |
| `architecture/` | 视图 | ArchitectureView 的四个内容区块子组件，见 `architecture/_README.md` |
