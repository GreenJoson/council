# discussion - 议题讨论区、上下文栏与议题对话框

> ⚠️ 一旦本文件夹有所变化，请更新本文件

跨功能域共用的基础件（`MarkdownContent`、`presentation`、`BrandGlyph`、`DecisionCard`、`ImplementationProgress` 等）仍在 `components/`，本目录按相对路径引用。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `DiscussionPanel.tsx` | 核心 | 组织议题头部（含桌面端收起/展开上下文栏与窄屏打开上下文抽屉按钮）、关闭入口、讨论/决策/任务/元数据 tab（任务徽标只数叶子任务的完成数/总数，与侧边栏和实施进度卡共用一套口径；所有者优先使用议题冻结快照）、一卡一节点的阶梯导航、独立时间线、真实 Agent 回复动态、人工决策入口、引用回复和编辑器；过长议题问题默认收起 |
| `AgentReplyActivity.tsx` | 状态 | 从当前议题真实 `running/waiting_agent` Run 中选择最新活动 Agent，在时间线末尾显示 Provider 品牌、具体名称、阶段与同议题实时草稿；较大输出块逐帧平滑展开，完成后由正式消息接替，不进入阶梯节点计数 |
| `MessageJumpRail.tsx` | 导航 | 按当前议题实际消息卡数量渲染一一对应的阶梯节点；点击平滑跳转到对应卡片，当前阅读卡跟随滚动高亮 |
| `MessageCard.tsx` | 核心 | 以消息行冻结 Actor 快照展示历史作者，避免身份重命名改写旧卡片；渲染公开 proposal/critique/rebuttal/synthesis，把 `council-fix` 尾块呈现为关联提交证据卡，并提供正文折叠、Markdown/Mermaid 与引用回复 |
| `Composer.tsx` | 写入 | 顶部「讨论 / 派任务 / 起流水线」模式分段（后两者把当前草稿交给 App 壳打开新建对话框）；发布带类型的公开回复（支持 ⌘Enter）、当前项目自动绑定且支持一个输入框批量粘贴多 commit 的结构化关联提交、引用回复和动态 `@actor-id` 召唤；「引用图片」（桌面端原生选择本机图片入库，浏览器端文件选择或粘贴上传）把资产以 `![说明](council-asset:<id>)` 插到光标处；Claude、Codex、DeepSeek、Kimi API 与 Kimi Code 均使用独立 Actor 身份；发布成功后创建并启动受控运行，离线或同议题已有活动运行时明确拦截 |
| `use-composer-images.ts` | 状态 | 编辑器引用图片 hook：桌面端经 `chooseImageFile` + `ingestLocalFile`，浏览器端经隐藏文件输入/粘贴 + `uploadImage`；只收图片，忙碌/错误状态与插入回调交给 Composer |
| `InspectorPanel.tsx` | 上下文 | 右侧「上下文」栏，自上而下：圆桌（透传人工决策入口）→ 可空拟议决策与 Human / Accepted 人工结束入口 → 紧凑实施进度 → 自动轮次 → 状态/所有者/参与者/更新摘要 → 只读的约束、证据、备选方案（默认收起只露标题与数量，整行标题即开关，展开集合与切换回调由上层 `useInspectorSections` 受控传入并跨会话记住）；长任务清单交给主列任务 tab，owner/备选作者优先使用各自行冻结快照 |
| `CyclePanel.tsx` | 圆桌 | 开局勾选参与名册，按 Actor 标出发起人并展示“首轮跳过”后的真实顺序；以分段控件选择方案/当前工作区/Commit 三种范围，轮次上限取自全局偏好（`useCycleRoundBudget`）只做告知不提供输入；展示能力缺口、阶段轨道、阻断结果与累计度量；轮次耗尽仍有阻断分歧时给出「我来裁决」（打开人工决策）与「再给 1 轮」（同名册同范围续一轮）；审核圆桌停在 `await_fix` 时给出未关闭数与「已修复，开始复审」入口 |
| `AutoRoundsPanel.tsx` | 编排 | 仅在存在 Run 或持久会话时展示紧凑运行状态、单一当前调用卡、折叠历史及会话关闭/重开；单次启动统一由 Composer `@Agent` 承担 |
| `CreateTopicDialog.tsx` | 创建 | 收集议题问题和约束，桌面端可选择目标项目（当前/最近/浏览），失败时保留输入以便重试 |
| `ManualDecisionDialog.tsx` | 决策 | 让用户填写最终结论与可选验证/部署说明，明确以 Human / Accepted 直接结束议题且不创建 Agent Run |
