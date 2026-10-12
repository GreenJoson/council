# pipelines - 图像/原型阶段协议与 P3 流水线

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `brief-protocol.ts` | 协议正本 | `council-brief` 与 `council-asset-manifest` 的严格解析（未知字段拒绝、schemaVersion 1、路径必须相对 worktree 且规范）、给 `codex exec --output-schema` 的清单 JSON Schema、按 Codex imagegen 规则渲染生图提示词（每张默认只生成一次、明显不合规才重做且最多一次，压住整轮时长） |
| `templates.ts` | 模板正本 | 三个流水线模板（`app-mockup` / `game-asset-pack` / `concept-sheet`）的阶段序列与 brief 要求（kind、nextStage、最少交付物、透明度） |
| `pipeline-document.ts` | 协议正本 | `council-pipeline` 文档（父任务 `brief_json`）严格解析与阶段读写 helper、brief 与模板一致性校验（含交付物合计张数 ≤ 单次生图上限 `COUNCIL_CODEX_IMAGE_MAX_OUTPUTS`）、`council-brief`/`council-review` 尾块提取（取最后一个围栏）、修订 brief 生成（只留不合格交付物，goal 开头声明本轮范围）、`PIPELINE_DOCUMENT_LIMITS`（HTTP/MCP 入口共用） |
| `pipeline-prompts.ts` | 提示词 | brief / review 一次性调用指令（首行机器标记 `COUNCIL_PIPELINE_BRIEF` / `COUNCIL_PIPELINE_REVIEW`；brief 指令告知单次生图上限与每张约 1 分钟的时间预算）与原型子任务说明（告知沙箱限制：起不了服务/浏览器时不停下等放行，未验证项写进收尾说明交人工）；用户输入作为数据段，只出现相对路径；复盘产物行带生图清单标注的 deliverableId 提示 |
| `pipeline-state.ts` | 状态读写 | 每条流水线一把串行锁；文档写入一律锁内重读父任务后用刚读到的版本写（子任务派生会让父版本 +1）；`completeImageChildren` 以 human 身份收尾仍 in_progress 的出图子任务（驱动器收尾被接手的旧轮、服务选定终稿时共用） |
| `pipeline-driver.ts` | 状态机 | 唯一推进者：brief/review 一次性调用（锁外调用、锁内重读，已取消或 startedAt 变了就丢弃结果）、图像/修订/原型委派派发与终态推进、失败阶段重试、取消、启动对账与停机；复盘只看本次图像委派入库的产物（委派 `outputManifest.assetIds`，按清单顺序列给复盘者），resume 重跑不把失败尝试入库的图混进本轮，选定阶段仍可从子任务全部 output 资产里挑；新一轮出图派发后收尾被接手的旧出图子任务（委派通过后它们停在 in_progress 等人工验收，不收尾父任务会一直显示进行中），启动对账先补做这一步 |
| `pipeline-service.ts` | 用例 | create/list/get/confirmBrief/selectFinal/resume/cancel：校验版本、阶段可操作性、brief 模板约束、终稿归属与数量、默认 Agent 选择后交给驱动器 |

## 职责

`brief-protocol.ts`、`templates.ts`、`pipeline-document.ts`、`pipeline-prompts.ts` 是纯函数：不起进程、不读写文件、
不碰数据库。`pipeline-state.ts` / `pipeline-driver.ts` / `pipeline-service.ts` 承担 P3 流水线：

- 一条流水线 = `kind=pipeline, source=direct` 的父任务，文档存其 `brief_json`；图像、修订与原型子任务 `source=pipeline`。
  父任务状态仍只由子任务派生，「等人」只记在文档里；不新增 SSE 事件，前端靠 `council.changed` 刷新。
- 阶段：brief（Claude 一次性只读调用，参考图拷到 `<project-root>/.council/in/`）→ 等人确认 → image（Codex 图像委派）
  → review（Claude 复盘本轮产物；`revise` 且未达 `COUNCIL_PIPELINE_MAX_REVISIONS` 时建修订子任务再回 review；修订简报 = 原 brief 只留不合格交付物 + 本轮改法，不累加上一轮）
  → 等人选终稿（给父任务挂 `final` 链接，图像子任务以 human 身份完成）→ prototype（仅 app-mockup：kind=prototype 子任务按
  `kind=code` 委派，`inputAssetIds` = 终稿，`completionPolicy=human`，权限档取 `COUNCIL_PIPELINE_PROTOTYPE_PERMISSION`，默认 workspace_write，
  放宽为 danger_full_access 时 Codex 不带沙箱运行以便自行起服务与浏览器验证；实际权限仍与执行 Agent 的权限档取交集）。
- 失败阶段 `resume` 只重跑当前阶段（brief/review 重新调用，image 对同一子任务重新委派，prototype 停在交接类或审核类失败（修订轮次用尽、审核未确认补查）时接续原委派、否则重新委派，已入库资产不动；接续发起失败保留原委派 id，可再次接续；修订派发在建子任务时失败记为 image 失败，重试按文档状态重建修订简报）；
  `cancel` 取消运行中的委派，当前阶段 `skipped` 且 `error.code=cancelled`，文档 `status=cancelled`。
- 启动对账：停在 running 的 brief/review 或找不到委派的阶段标 `interrupted`；委派已到终态则按终态推进。
- 默认 Agent：brief/review 取可用 claude-cli（优先 alias `claude`）；image 取带 `image_generate` 的可用 codex-cli 执行者
  （优先 alias `codex`）；prototype 执行者同 image、监督者取 reviewer/hybrid 角色的 Claude，否则同 brief。挑不出时 409 并给可执行提示。

## 入口与依赖方向

- REST：`http/routes/pipeline-routes.ts`（`/api/v1/pipelines*`）；编排服务未启用时 503。
- MCP：`mcp/tools/pipeline-tools.ts`（`council_start_pipeline` / `council_get_pipeline`），经 loopback HTTP 转发。
- 装配：`orchestration/service.ts` 创建 `PipelineService` 并接入 initialize/shutdown/close。

`http/routes`、`orchestration/service.ts` → `pipelines/` → `database.ts`、`errors.ts`、`constants.ts`。驱动器对编排层只经
注入的端口（`PipelineAgentPort`：一次性调用；`PipelineDelegationPort`：委派发起/接续/取消/查询/终态订阅/资产拷入），不 import
委派管理器或产品服务。图像委派侧（P2）：`renderImageBriefPrompt` → `assetManifestJsonSchema()` →
`CodexRuntime.generateImages` → `parseCouncilAssetManifest(lastMessage, { brief })`。

## 协议约束

- `parseCouncilBrief(value)`：kind 限定 `app-mockup | game-sprite | game-tileset | concept-sheet | icon-set | custom`；
  deliverables 1–16 项、id 形如 `app-icon` 且不重复、size 形如 `1024x1024`、count 1–16。失败 `code = "brief_invalid"`。
- `parseCouncilAssetManifest(value, { brief? })`：path 必须相对 worktree（不得绝对、`..`、反斜杠）且不重复；
  `variantOf` 为 null、指向清单外（修订轮引用上一轮原图）或指向自身时都折叠为缺省（下游无人消费）；传入 brief 时
  deliverableId 必须来自 brief。失败 `code = "manifest_invalid"`。
- `council-review`：`{ schemaVersion: 1, verdict: "pass" | "revise", items: [{ assetId, deliverableId, ok, issue?, change? }] }`；
  revise 至少一项 `ok=false` 且带 `change`，否则 `review_invalid`。

## 验证方式

`npm run check`、`npm test --prefix packages/mcp-server`、`npm run test:e2e`（`webui-http-smoke.py` 的「P3 流水线闭环」：
app-mockup 走完 brief 确认 → revise 一轮 → pass → 选终稿 → 原型代码委派交接暂停（execution_checkpoint）→ resume 接续并保留第一段改动；concept-sheet 构造一次 `outputs_missing`
后 resume 成功、资产不重复，再取消；替身见 `test/fake-claude.mjs`）。

2026-10-10 在 codex-cli 0.162.0 上的生图实测（P2）：

- `codex features list` 输出 `image_generation stable true`，探针判定 available；`COUNCIL_CODEX_IMAGE_ENABLED=false` 时为 `disabled`。
- 一次 `generateImages`（1 张 512×512，附 1 张 64×64 纯色参考图 `-i`）约 65 秒，退出码 0，拿到 `threadId`；`-i` 有效。
- `-o` 内容可被 `parseCouncilAssetManifest(…, { brief })` 严格解析；模型遵守「不覆盖、变体用 `-v2`」，
  因此 `.council/out/` 可能多于交付数，入库按清单 + 上限处理。
- 真实 Codex 会把原图先落在 `<codex-home>/generated_images/<threadId>/` 再缩放进 worktree，两份 sha256 不同，
  该目录只能做兜底、不能与前两路取并集。
