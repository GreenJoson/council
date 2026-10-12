# pipelines - 流水线列表、详情与新建

> ⚠️ 一旦本文件夹有所变化，请更新本文件

依赖方向：`app/WorkspaceMain → PipelinesView → PipelineList / PipelineDetailView / PipelineCreateDialog → use-pipelines / use-pipeline-detail → data/pipelines 仓储`。brief 编辑复用 `features/tasks` 的 `BriefEditor` 与 `brief-form`，缩略图复用 `features/assets/AssetThumbnail`，大图复用 `components/Lightbox`；select 候选与参考图读 `data/assets` 仓储。

| 文件名 | 地位 | 功能 |
|---|---|---|
| `PipelinesView.tsx` | 入口 | 创建一次流水线仓储与资产仓储；有 `pipelineId` 时渲染详情（按 id 重挂载），否则渲染列表；新建成功后跳到 `#/pipelines/<新 id>` |
| `PipelineList.tsx` | 列表 | 按 等待我处理 / 进行中 / 失败 / 已完成 分组（取消的归入已完成），行显示目标、模板、更新时间与当前阶段徽标；桌面离线时显示 limitation 并禁用新建 |
| `PipelineDetailView.tsx` | 详情 | 头部（目标、阶段徽标、模板、父任务链接）、阶段轨道、人工操作区、约束（长列表折叠）、复盘记录（`PipelineReviews`）与最终稿；写操作 409 时提示「流水线已更新，请重试」 |
| `PipelineTrack.tsx` | 轨道 | 按模板阶段顺序横向展示每段状态、起止时间、错误 code/message 与子任务链接（`#/tasks/<id>`，显示子任务标题），窄屏纵向；修订轮出图失败而此前已有产出时注明「旧图保留、恢复只重跑这一轮」 |
| `PipelineReviews.tsx` | 复盘 | 复盘记录按轮折叠（默认只展开最新一轮），轮标题显示通过/返工与需修改项数；区块内搜索交付物 id、问题与改法，命中轮自动展开、未命中轮隐藏 |
| `StageControls.tsx` | 操作 | brief 等人 → BriefEditor 编辑 `draftBrief` 后确认；select 等人 → AssetCompare 勾选 1–3 张后选定；failed → 恢复；未结束 → 两步确认取消 |
| `AssetCompare.tsx` | 对比 | select 候选图 2/3 列并排（窄屏单列），逐个 `getAsset` 读元数据，点击 Lightbox 看原图，勾选回传 |
| `PipelineCreateDialog.tsx` | 新建 | 原生 `<dialog>`：模板单选、目标、每行一条的约束、最多 8 张参考图、各阶段 Agent（默认留空 = 服务端默认，出图只列具备 `image_generate` 的可用 Agent） |
| `use-pipelines.ts` | 状态 | 列表读取与 limitation；导出 `useLocalChangeTick`（订阅 mock 仓储 `watchLocalChanges`） |
| `use-pipeline-detail.ts` | 状态 | 详情读取与四个写操作：统一带父任务 `version`，返回详情就地替换，409 标记 conflict 并重读 |
| `pipeline-labels.ts` | 文案 | 模板/阶段/阶段状态/分组中文文案（即 i18n 键）、分组函数与时间格式化 |

刷新约定：两路 revision（内容快照、编排 revision）任一变化即重读，不新增 SSE；mock 定时推进不改变 revision，改由 `watchLocalChanges` 触发重读。新增中文文案时同步 `i18n/catalog.en.ts` 的「P3：流水线」段。
