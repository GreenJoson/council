# architecture - 架构档案视图与区块子组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

跨功能域共用的基础件（`MarkdownContent`、`presentation`、`BrandGlyph`、`DecisionCard`、`ImplementationProgress` 等）仍在 `components/`，本目录按相对路径引用。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `ArchitectureView.tsx` | 视图 | 项目架构档案：从讨论决策聚合生成的架构沉淀页（项目概览/演进时间线/不变量/图集四区块，拆分为同目录的 `Architecture*.tsx` 子组件），经 `useTopicDetails` 一次性加载全部议题详情；后三个长区块可点标题栏收起，折叠状态跨会话保留 |
| `ArchitectureSection.tsx` | 外壳 | 区块 2/3/4/附件 共用的可折叠外壳：标题栏整条就是开关，右侧箭头随折叠旋转；折叠时正文不挂载（只用 CSS 藏起来，长清单照样要渲染几十条）|
| `ArchitectureOverview.tsx` | 区块 1 | 项目名/路径（原生模式才有路径）与议题数/已接受决策数/提案中数统计，含详情加载进度提示 |
| `ArchitectureTimeline.tsx` | 区块 2 | 架构演进时间线：已接受/被取代决策按接受时间升序显示稳定 ADR 编号，提案中条目追加在末尾；点击已决策条目跳转决策记录、点击提案中条目跳转讨论；被取代条目显示"已被 ADR-xxx 取代"徽章并可跳转 |
| `ArchitectureConstraints.tsx` | 区块 3 | 跨议题聚合并按文本去重的架构不变量，每条标注全部来源议题（有 ADR 的附编号 + 时间） |
| `ArchitectureDiagramGallery.tsx` | 区块 4 | 从已接受/被取代决策的 summary/rationale 与 synthesis 消息里提取的 mermaid 图集，复用 MermaidDiagram 渲染、标注来源（ADR 编号或消息作者 + 时间），点击复用共享 Lightbox 放大 |

五个区块均为纯展示组件（数据、聚合与懒加载逻辑集中在 `ArchitectureView.tsx` + `data/selectors.ts` + `hooks/useTopicDetails.ts`），不发起任何请求。空态文案由各区块自行处理，不留死区。

区块 2/3/4/附件 的折叠开关由 `ArchitectureView.tsx` 统一持有并经 `data/section-collapse.ts` 跨会话持久化——折叠是为了让长页面短下来，每次重开又展开等于没折过。区块 1 是四行统计，短到不值得给它一个开关。

`ArchitectureAttachments.tsx` 汇总本地文件链接为类型卡片，只在用户点击时通过共享文件预览入口读取文件，不生成归档副本。
