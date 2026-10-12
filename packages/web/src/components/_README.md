# components - Operator Console 界面组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `DelegationExecutionProgress.tsx` | 委派进度 | 真实执行阶段、预算暂停和可观测指标，未知数据不补造 |
| `RuntimeAuditDetails.tsx` | 执行记录 | 按来源分页加载阶段/工具/提交证据，保留空态、错误和刷新反馈 |
| `WorkAttentionView.tsx` | 待处理 | 聚合当前项目真实待处理状态，点击回到原议题 |
| `DelegationRecoveryActions.tsx` | 恢复 | 展示失败分类指引，显式恢复已提交进度或接续未提交代码，保留原记录并反馈冲突 |
| `NavRail.tsx` | 导航 | V2 壳最左侧图标栏：品牌 logo、会话（议题/任务/流水线共用）/需要我处理/资产/架构档案/决策记录五个视图入口，底部偏好与模型设置；会话入口叠「运行中 Agent 数」徽标、需要我处理入口叠「待处理议题数」徽标（来自编排快照 `activity`，为 0 不显示，>99 显示 99+）；切换只回调由 App 壳写 hash，≤920px 变成底部横条并露出打开会话抽屉的按钮 |
| `PreferencesDialog.tsx` | 偏好 | 原生 `<dialog>` 偏好面板：主题（日光/暗黑/跟随系统）、界面语言（中/EN 持久）与圆桌轮次上限（写入 `data/cycle-preferences`），从图标栏底部打开 |
| `ModelRouterDialog.tsx` | 设置 | 以固定高度左侧路由管理 Provider 与其 Agent；未配置模板仅在添加目录中按需出现，Claude/Codex 系统 Provider/Agent 均锁定身份且不显示删除入口；左侧末尾「客户端接入」分区切换到 `ClientConfigPanel` |
| `ClientConfigPanel.tsx` | 设置 | 「客户端接入」：Claude Code / Codex 两张卡，显示未写入/已写入/已漂移/文件丢失徽标、`~` 折叠后的配置文件与 Skill 目录、上次写入时间；提供写入、漂移时「重新写入（覆盖漂移）」与还原，规则全在服务端 |
| `ModelRouterEditor.tsx` | 设置 | 右侧一次只编辑一个 Provider 连接或 Agent 身份；可设置顾问/执行/审核职责与显式委派的权限上限，普通 `@` 讨论始终只读 |
| `BrandGlyph.tsx` | 品牌 | 离线渲染受控 glyph、供应商名称和语义色；未知品牌使用通用网络图形，不写成 Other |
| `DesktopSetup.tsx` | 启动门 | 首次运行时依次选择日志库和当前项目 |
| `ConversationList.tsx` | 导航 | 会话列表栏：顶部项目切换菜单（原生项目/日志库入口）与新建议题，⌘K 搜索框，全部/议题/任务/流水线筛选 chips；议题行时间与实施完成度左右分列（未拆分实施项时不渲染徽标），任务与流水线作为同一条流里的行（全部模式各预览 5 条 + 「更多」链接，任务/流水线模式全量），点行写 hash；≤920px 作为抽屉打开 |
| `MarkdownContent.tsx` | 基础 | 统一 Markdown 渲染入口（react-markdown + remark-gfm + rehype-raw/rehype-sanitize 白名单），提供标题降级、表格滚动、图片/Mermaid 缩略预览、大图浏览（图片 src 经 `data/markdown-images` 解析：`council-asset:` 走资产接口、项目内相对路径走议题只读图片接口；缩略图失败回退原图，仍失败或未连接项目时显示占位），以及正文/议题两种语义化折叠；议题展开后把唯一收起入口移到正文顶部并吸顶，折叠高度从主题 token 读取，内容切换后恢复默认收起；稳定组件映射避免 Mermaid 与高度测量互相触发重挂载 |
| `MermaidDiagram.tsx` | 基础 | 动态 import mermaid（首屏不加载）把源码渲染成固定上限缩略 SVG；按 data-theme 联动主题，securityLevel 显式声明为 strict；点击放大，失败降级为原始代码块 + 错误提示 |
| `Lightbox.tsx` | 基础 | 通过 body Portal 提供全视口大图浏览，支持图片与 mermaid SVG、50%–300% 缩放、内部滚动、快捷键和遮罩/Esc/关闭退出；不受消息卡 transform/裁剪影响 |
| `ImplementationProgress.tsx` | 执行 | 导出右栏 `ImplementationSummary` 完成度摘要与主区 `ImplementationProgress` 任务清单；接受决策不自动调用规划 Agent，用户须先显式选择 Agent 再触发分拆，也可手动添加；任务按 `parentId` 渲染成父子两层，父任务状态由子任务派生且不可手改，完成度只数叶子；审核发现标出阻断/非阻断与复审轮次，叶子可认领并回写修复 commit；叶子只显示最新委派状态摘要与进度，并给出「在任务页管理委派」链接（`#/tasks/<id>`），单条委派面板与历史委派已迁到任务详情，批量委派保留 |
| `WorkItemDelegationPanel.tsx` | Agent 执行 | 由任务详情页（`features/tasks/TaskDetail`）复用：选择两个不同 Agent 分任执行者和监督者，按次选择不超过 Agent 上限的写入权限，冻结验收标准与完成策略，并展示执行/审核/退回/分支提交、待人工验收、审计和恢复状态 |
| `presentation.tsx` | 基础 | 统一品牌 logo、冻结 Actor 快照到 Participant 的转换、动态头像回退、议题状态与决策状态标签/徽章 |
| `FoldableContent.tsx` | 基础 | 区块内搜索与折叠的共用件：`SectionSearch`（标题栏搜索框，Esc 清空，显示命中数）、`Highlight`（命中高亮）、`FoldList`（长列表只露前几项，「展开其余 N 项」）、`FoldText`（长文本按行数/字数折叠，搜索命中时自动展开）；任务简报、任务正文与流水线复盘记录在用 |
| `StatusBar.tsx` | 基础 | 底部状态条：左侧同步状态（离线时可点击重试）与活动 Agent 计数（`running/waiting_agent` Run + 执行/审核中委派，离线快照无此字段时不渲染），右侧构建身份（版本 · commit · 构建时间，由 vite.config 在构建期注入；semver 不随重建变化，靠 commit 与时间区分手上跑的是哪个包） |

讨论、决策记录与架构档案三块视图已迁入 `features/discussion/`、`features/decisions/`、`features/architecture/`，见 `features/_README.md`；本目录只保留被多个功能域共用的基础件。

委派卡区分实际执行权限和 Agent 上限；接续入口允许在上限内显式选择新运行权限。

`ImplementationProgress.tsx` 的委派摘要（`.work-item-delegation-summary`，样式在 `styles/tasks.css`）与任务正文对齐，避开层级竖线；历史委派时间线见 `features/tasks/DelegationTimeline.tsx`。

`DelegationDeliveryEvidence.tsx` 展示所有状态下已保存的提交、审核问题和材料阻断。执行阶段区分首次实施与按审核意见修正，恢复入口区分提交复审与修正草稿接续。

| `files/` | 文件预览 | ProjectFilesProvider 统一内部打开、竞态与项目切换；ProjectFileDialog 显示只读工作表/Markdown/源码，ProjectFileIcon 提供类型图标 |

`WorkItemDelegationPanel.tsx` 新增可选 `formExtras`（插在提交按钮前，任务详情用它放「团队模式」开关与并行上限）；`DelegationExecutionProgress.tsx` 只需委派的 `execution` 字段，团队右栏的 Worker 委派摘要直接复用。
