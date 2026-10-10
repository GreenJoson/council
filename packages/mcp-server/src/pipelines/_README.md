# pipelines - 图像/原型阶段协议

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `brief-protocol.ts` | 协议正本 | `council-brief` 与 `council-asset-manifest` 的严格解析（未知字段拒绝、schemaVersion 1、路径必须相对 worktree 且规范）、给 `codex exec --output-schema` 的清单 JSON Schema、按 Codex imagegen 规则渲染生图提示词 |

P3 再加入流水线模板（`templates.ts`）与驱动（`pipeline-driver.ts`），本阶段不建空文件。

## 职责

只定义图像委派前后两端的结构化协议，全是纯函数：不起进程、不读写文件、不读配置、不碰数据库。

- `parseCouncilBrief(value)`：接受对象或纯 JSON 字符串（不剥代码围栏），返回 `CouncilBrief`；失败抛
  `CouncilProtocolError`（`code = "brief_invalid"`）。kind 限定 `app-mockup | game-sprite | game-tileset |
  concept-sheet | icon-set | custom`；deliverables 1–16 项、id 形如 `app-icon` 且不重复、size 形如 `1024x1024`、count 1–16。
- `parseCouncilAssetManifest(value, { brief? })`：返回 `CouncilAssetManifest`，失败 `code = "manifest_invalid"`。
  path 必须相对 worktree（不得绝对、`..`、反斜杠），outputs 内 path 不重复；`variantOf: null` 折叠为缺省，
  非空时必须指向本清单内另一个 path；传入 brief 时 deliverableId 必须来自 brief。
- `assetManifestJsonSchema()`：Structured Outputs 兼容（每层 `additionalProperties: false`、字段全 required、
  `variantOf` 为 `["string","null"]`）。解析端比 schema 更严格，schema 只约束形状。
- `renderImageBriefPrompt(brief, { outputDir, inputs })`：要求用内建生图工具（无需 API key）、先 view_image 看参考图、
  不覆盖已有文件、变体用 `-v2` 兄弟名、最终产物复制进 outputDir、只输出清单 JSON 且 path 相对 worktree；
  brief 文本标注为数据，不能覆盖工作规则。

## 入口与依赖方向

调用方（P2 由 C 的图像委派负责）：`renderImageBriefPrompt` 生成提示词 → 把 `assetManifestJsonSchema()` 写到临时文件 →
`CodexRuntime.generateImages`（`codex-runtime.ts`）→ 用 `parseCouncilAssetManifest(lastMessage, { brief })` 校验 `-o` 内容。
本目录只依赖 `node:path` 与 `zod/v4`，不反向依赖 `orchestration/`、`assets/`、`database/`。

## 验证方式

`npm run check`；真实链路用仓库外临时 git 仓库手工验证（不新增测试文件）。2026-10-10 在 codex-cli 0.162.0 上的实测：

- `codex features list` 输出 `image_generation stable true`，探针判定 available；`COUNCIL_CODEX_IMAGE_ENABLED=false` 时为 `disabled`。
- 一次 `generateImages`（1 张 512×512，附 1 张 64×64 纯色参考图 `-i`，`--output-schema` + `-o`）约 65 秒，退出码 0，拿到 `threadId`。
- `-i` 有效：模型在清单 notes 与 prompt 中准确说出参考图颜色（#008080）。
- `-o` 内容可被 `parseCouncilAssetManifest(…, { brief })` 严格解析；path 均为 `.council/out/...` 相对路径，宽高与文件实际像素一致。
- 模型遵守了「不覆盖、变体用 `-v2`」：原图背景色有偏差，它用本机工具校色另存 `app-icon-v2.png` 并填 `variantOf`；
  因此 `.council/out/` 可能多于交付数，入库需按清单 + 上限处理。
- `<codex-home>/generated_images/<threadId>/` 存在，内有 1 个文件（仅生图工具原始产物，不含本机后处理的变体），可作为兜底来源。
- 2026-10-10 委派级验收：以资产库内真实 icon 作 `inputAssetIds` 走完整图像委派，模型收尾说明准确描述了参考图内容（深蓝灰椭圆桌与四把椅子），75 秒产出同构图加粗版 RGBA PNG 并入库，`-i` 参考图链路视为已验证。同一轮还发现真实 Codex 会把原图先落在 `<codex-home>` 再缩放进 worktree，两份 sha256 不同，所以该目录只能做兜底、不能与前两路取并集。
