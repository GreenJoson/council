# architecture - 架构档案视图子组件

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `ArchitectureOverview.tsx` | 区块 1 | 项目名/路径（原生模式才有路径）与议题数/已接受决策数/提案中数统计，含详情加载进度提示 |
| `ArchitectureTimeline.tsx` | 区块 2 | 架构演进时间线：已接受/被取代决策按接受时间升序显示稳定 ADR 编号，提案中条目追加在末尾；点击已决策条目跳转决策记录、点击提案中条目跳转讨论；被取代条目显示"已被 ADR-xxx 取代"徽章并可跳转 |
| `ArchitectureConstraints.tsx` | 区块 3 | 跨议题聚合并按文本去重的架构不变量，每条标注全部来源议题（有 ADR 的附编号 + 时间） |
| `ArchitectureDiagramGallery.tsx` | 区块 4 | 从已接受/被取代决策的 summary/rationale 与 synthesis 消息里提取的 mermaid 图集，复用 MermaidDiagram 渲染、标注来源（ADR 编号或消息作者 + 时间），点击复用共享 Lightbox 放大 |

四个区块均为纯展示组件（数据、聚合与懒加载逻辑集中在 `ArchitectureView.tsx` + `data/selectors.ts` + `hooks/useTopicDetails.ts`），不发起任何请求。空态文案由各区块自行处理，不留死区。
