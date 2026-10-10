# decisions - 决策记录视图

> ⚠️ 一旦本文件夹有所变化，请更新本文件

跨功能域共用的基础件（`MarkdownContent`、`presentation`、`BrandGlyph`、`DecisionCard`、`ImplementationProgress` 等）仍在 `components/`，本目录按相对路径引用。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `DecisionRecordsView.tsx` | 视图 | 左列表右详情的 ADR 归档；owner、决策提出者和备选作者优先使用历史行冻结快照，详情按需加载并支持失败重试与定位 |
