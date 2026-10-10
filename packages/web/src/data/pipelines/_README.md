# pipelines - Council Web 流水线数据域

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `pipeline-repository.ts` | 边界 | 定义列表/详情/新建/确认 brief/选 final/恢复/取消接口；写操作都带父任务 `expectedVersion`；真实实现不提供 subscribe，仅 mock 提供可选的 `watchLocalChanges` |
| `pipeline-api.ts` | 协议 | 严格解析 `council-pipeline` 文档（已知字段校验、未知字段忽略）、列表 `{items}`、详情 `{task, document, children, outputAssetIds}` 与创建响应 `{pipeline}`；父/子任务行复用 `tasks/task-api` |
| `http-pipeline-repository.ts` | 真实 | 调用 `/api/v1/pipelines` REST；列表与创建绑定项目路径，未选 Agent 时不发 `agents` 交给服务端默认 |
| `desktop-pipeline-repository.ts` | 桌面 | Tauri 没有流水线命令，读写全部委托本地 Agent 服务 HTTP；离线时列表返回空 + `limitation`，详情与写操作抛诚实指引 |
| `mock-pipelines.ts` | 示例 | 三条预置流水线（选 final 等人 / 图像阶段 `outputs_missing` 失败 / 已完成）与行构造器；产物复用 mock 资产库的图片 id |
| `mock-pipeline-repository.ts` | 原型 | 内存状态机：定时器推进 brief → image → review（首轮 revise、次轮 pass）→ select →（app-mockup）prototype；版本冲突、阶段不可操作、已取消时抛 409 |
| `create-pipeline-repository.ts` | 配置 | 按 `VITE_COUNCIL_DATA_MODE` 选择实现，复用 `VITE_COUNCIL_API_URL`/`VITE_COUNCIL_PROJECT_PATH`；mock 返回模块级单例 |

刷新约定：流水线父/子任务写入递增 content revision，委派写入递增 orchestration revision；调用方监听两路 revision 后重读，不新增 SSE 事件。mock 的定时推进不改变任何 revision，因此改由 `watchLocalChanges` 通知 hook 重读。
