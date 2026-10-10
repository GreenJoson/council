# Council v2 重构方案：从圆桌讨论到「讨论 → 任务 → 资产 → 原型」的交付工作台

> 状态：方案（待执行）。执行者：Opus。本文是执行正本，分阶段章节可直接拆成任务。
> 参考：Cindy（Electron 多 harness 工作台，Orca Lead/Worker 团队）、magpie（Go 本地网关，按 Agent 写入配置、为任意 Agent 提供图像工具）。
> 事实来源：仓库现状（schema v17；`13f899b` 加了模型诊断与项目文件只读预览，`3be9220` 修了交接误判/长背景截断/复审缺任务原文，并已用真实小项目跑通「Claude 改代码 → 两段接续 → 验证 → 提交 → Codex 独立审核」；工作区干净，但安装版桌面 app 早于这两笔提交）、本机 Codex CLI 0.160.1 生图探针、两个参考项目的公开文档。

## 0. 一句话结论

**不推翻，升维。** 保留 Council 三层骨架（Tauri/Rust 只读核心 + Node `mcp-server` 唯一写入与迁移者 + `orchestrator` 状态机）和它最值钱的东西（SQLite 单一真源、`commitRound` 原子发布、lease/epoch fencing、委派账本/恢复/审计、脱敏与显式权限上限），把产品心智从「议题优先」改成「工作对象优先」：

```
                 ┌──────────────┐
   讨论（圆桌）  │   Topic      │  仍然是深思熟虑的入口，但不再是唯一入口
                 └──────┬───────┘
                        │ accept decision（可选）
                        ▼
   任务（执行）  ┌──────────────┐   新建任务 / 决策派生 / 流水线派生 三个入口
                 │   Task       │   任务可以不挂议题，直接委派给 Agent 改代码
                 └──────┬───────┘
                        │ delegation.kind = code | image | prototype
                        ▼
   资产（产物）  ┌──────────────┐   Codex 内建 image_gen 出图；位图/模型/文档统一入库
                 │   Asset      │   资产挂回任务、消息、决策，可做参考图再喂给下一阶段
                 └──────┬───────┘
                        │ pipeline：brief(Claude) → image(Codex) → prototype(Claude/Codex) → review
                        ▼
   决策（沉淀）  ┌──────────────┐   ADR 归档不变，只是来源从「议题」扩成「议题或任务」
                 │   Decision   │
                 └──────────────┘
```

四个一等对象：**Topic / Task / Asset / Decision**。UI 按这四个对象分模式导航，而不是把一切塞进议题右栏。多 Agent 协作在现有 supervisor→executor→reviewer 三角之上，引入 Cindy 式 **Lead/Worker 有界团队**，但只在流水线和大任务里用，普通任务还是单执行者。

## 1. 现状诊断

### 1.1 保留不动的部分（这些是对的）

| 能力 | 位置 | 为什么保留 |
|---|---|---|
| SQLite 单一真源，Node 唯一迁移者，Rust 镜像版本号 | `packages/mcp-server/src/schema-migrator.ts`、`crates/council-core/src/store.rs` | 已验证的发布迁移不可变、备份验证、桌面 ready 门，是全系统一致性的基础 |
| `commitRound` 原子发布 + Run lease + RuntimeBinding lease | `orchestrator`、`orchestration/service.ts` | 浏览器断线、进程退出不会出现半条正式消息 |
| 显式委派：隔离 worktree、权限上限、冻结验收标准、检查点恢复、审计脱敏 | `orchestration/work-item-delegation-*.ts`、`delegation-*.ts`、`runtime-audit-store.ts` | 这就是「接任务直接改代码」需要的执行闭环，只是缺入口和产品化 |
| Agent / Provider / Runtime 三层 + 能力词表 + fail-fast | `model-router-*.ts`、`orchestrator/src/cycle/runtime-capabilities.ts` | 新增 `image_generate` 能力只需要扩词表，不用改模型 |
| 隐私与路径策略：公开 DTO 不泄露本机路径、敏感内容扫描、受控 Git | `project-path-policy.ts`、`delegation-workspace-snapshot.ts`、`read-only-git-*.ts` | 资产通道必须复用同一套策略 |

### 1.2 真实问题

1. **只有讨论入口。** 执行链路是 topic → accept decision → 显式选规划 Agent → work item → 任务卡里委派。想「直接给一个任务让 Agent 改」没有路径；`work_items.topic_id` 是 `NOT NULL`，数据模型上就不允许无议题任务。
2. **执行能力埋在任务卡深处。** `WorkItemDelegationPanel` 挂在 `DiscussionPanel` 的 tasks tab 里，`WorkAttentionView` 是唯一跨议题视图。没有任务板、没有执行时间线总览、没有「我现在有几个 Agent 在跑」的全局感。
3. **没有媒体/资产通道。** 能力词表有 `media_read` / `vision`，但 adapter 不传附件；没有资产表；Web 只有 `MarkdownContent` 内嵌图和 `Lightbox`。`13f899b` 的「附件预览」是议题项目内文本/Markdown/表格的只读预览（`project-file-preview.ts`），不是生成产物的入库与流转，但它的越界/敏感路径/符号链接拒绝与 worker 线程解码可以直接作为资产预览的底座。Codex 生出的图没有地方落、没有地方看、没有办法作为下一阶段输入。
4. **Codex 被配置锁成只读。** `COUNCIL_CODEX_SANDBOX_MODE` 只允许 `read-only`，`codex-runtime.ts` 对非 `danger_full_access` 都强制 `--sandbox`，并且总是加 `--ignore-user-config`。这对讨论是正确的，但生图需要 `workspace-write` 落盘，并且用户 `~/.codex/config.toml` 里的功能开关一律不生效，必须由 Council 显式 `--enable image_generation`。
5. **UI 密度过高、职责过重。** `App.tsx` 1,196 行同时承担路由、状态、数据加载；三栏 Operator Console 是为「读讨论」设计的，执行与资产场景放不进去。`docs/designs/ui-directions.md` 里的方案 B（并排对照）至今没有落地，而对照正是「草图 vs 生成图 vs 原型」最需要的。
6. **聚合层过重。** `orchestration/service.ts` 1,399 行、`database.ts` 1,466 行、`schema-migrator.ts` 1,377 行。再往里加任务/资产/流水线领域会越过 1,500 行红线。拆分必须先于新功能。
7. **协作形态单一。** 只有 supervisor→executor→reviewer 固定三角，没有并行 Worker；流水线里「Claude 出题、Codex 画图、再做原型」需要一个 Lead 持续编排多个阶段。

### 1.3 本机 Codex 生图探针结论（已实测）

| 事实 | 结论对方案的影响 |
|---|---|
| `codex exec --sandbox workspace-write --skip-git-repo-check --ignore-user-config --enable image_generation --json` 成功生成 512×512 PNG，工具名 `image_gen.imagegen` | 在 Council 现有 `--ignore-user-config` 前提下，显式 `--enable image_generation` 即可，不依赖用户 config |
| 产物默认落在 `$CODEX_HOME/generated_images/<thread_id>/<item_id>.png`，模型再用 shell（`sips`/`cp`）复制到工作区 | 必须要求模型把最终产物复制进工作区约定目录；同时用 JSONL `thread.started.thread_id` 定位默认目录做兜底扫描 |
| `--json` 事件流里**看不到**图像工具调用，只有 `command_execution` 和 `agent_message` item | 不能靠事件流审计生图次数；靠 `--output-schema` 清单 + 文件产物入库 |
| 系统 Skill `imagegen` 明确：内建工具模式不需要 `OPENAI_API_KEY`；编辑本地图片要先 `view_image`；批量就多次调用；不覆盖已有资产，用 `-v2` 兄弟文件名 | Council 的 brief 提示词要按这些规则写，不自建 image API 调用 |
| `codex exec -i <FILE>...` 可附图作为输入（flag 存在，未端到端探针） | 参考图/草图喂给 Codex 的通道是现成的，P2 阶段需补一次端到端验证 |
| magpie 源码证实：Codex 只给「OpenAI actor」Provider 挂 image 工具（不 `requires_openai_auth` 且带 `x-openai-actor-authorization` 头） | 走本机 ChatGPT 登录没问题；若用户把 Codex 指向自建中转，生图会静默消失，必须做能力探针而不是假设可用 |

## 2. 对标借鉴

### 2.1 从 Cindy 借什么

| Cindy 做法 | Council 对应落点 | 取舍 |
|---|---|---|
| Orca：Lead session + Worker sessions，`orca_teams` 每个 Lead 只允许一个活动团队，`orca_workers` 有 status/label/role/focused | 新表 `task_teams` / `task_workers`，Worker 是子委派而不是新会话类型；复用委派账本与 worktree | 不照搬 20 个 MCP 工具，先给 6 个：start_team、add_worker、send_to_worker、interrupt_worker、idle_worker、end_team |
| Worker 权限偏好 `bypassPermissions`/`auto`，显式升级要宿主确认 | 已有 `DelegationExecutionPermission` 与 Agent 上限，直接沿用；Worker 不得超过 Lead 的有效权限 | 不新增权限模型 |
| 独立只读 Reviewer、Finding 协议（证据 + 优先级）、源变更后结果过期、Reviewer 绝不自动修 | 已有 `council-findings` 与 review-fix 闭环；补「结果过期」：任务新 commit 后旧 review 标记 stale | 小改 |
| 「连接而非再造智能」：上游能力不降级 | 生图直接用 Codex 内建 `image_gen`，Claude 用 Claude Code 自带读图；Council 不包一层图像 API | 原则 |
| 右侧「协同」栏，Worker 不进主侧栏 | 任务详情页右栏显示团队与 Worker，不污染任务板 | 原则 |
| 多 harness × 模型切换 | 已有 Model Router，不动 | 不借 |

### 2.2 从 magpie 借什么

| magpie 做法 | Council 对应落点 | 取舍 |
|---|---|---|
| 按 Agent 写入各自配置（stash 原文件、`applied.json`、drift 检测、断开时还原） | P4 可选：Council 给 Claude/Codex 写 MCP 注册与 Skill 时，先 stash、记录 applied、启动时检测 drift | 目前 `docs/mcp-setup.md` 是手工步骤，自动化后要有同样的还原能力 |
| Library 统一分发 instructions / MCP / skills 到各 Agent 格式 | 把 `skills/council/SKILL.md` 和任务/流水线的 brief 模板作为 Library，派发时按 Runtime 注入 | P3 做 brief 模板，P4 做 Library |
| 为任意 Agent 通过 MCP 提供图像工具 | **不借**。magpie 是网关可以代理 image API；Council 没有自己的 API Key 通道（Keychain 只服务远程 Provider），而且探针证明走 Codex 内建就够 | 明确不做 |
| 子系统文档模板：职责/来源、运行路径、约束、验证 | 每个新领域目录的 `_README.md` 按这四节写 | 原则 |
| 本地 JSON API `/api/state` `/api/set`、无框架 GUI | 不借，Council 的 REST/SSE 更成熟 | 不借 |

## 3. 目标架构

### 3.1 领域划分（mcp-server）

```
packages/mcp-server/src/
├── orchestration/          # 保留：Run/Cycle/委派执行闭环（只做执行，不做产品聚合）
├── tasks/                  # 新：任务领域
│   ├── task-store.ts       #   work_items 升级后的读写（topic 可空、kind、source、priority）
│   ├── task-intake.ts      #   三个入口：直接任务 / 决策派生 / 流水线派生
│   ├── task-team-store.ts  #   P4：task_teams / task_workers
│   └── _README.md
├── assets/                 # 新：资产领域
│   ├── asset-store.ts      #   assets / asset_links 读写，sha256 去重
│   ├── asset-storage.ts    #   <data-dir>/assets/<sha256 前两位>/<sha256>.<ext> 落盘、大小配额、MIME 白名单
│   ├── asset-ingest.ts     #   从委派工作区约定目录 + 清单入库，拒绝符号链接/超限/非白名单
│   ├── asset-preview.ts    #   缩略图与只读流式读取；沿用 project-file-preview.ts 的 realpath/越界/敏感路径拒绝与 worker 线程解码
│   └── _README.md
├── pipelines/              # 新：流水线领域
│   ├── pipeline-templates.ts   # app-mockup / game-asset-pack / concept-sheet 模板
│   ├── pipeline-driver.ts      # 阶段推进：brief → image → prototype → review，阶段间传资产
│   ├── brief-protocol.ts       # council-brief / council-asset-manifest 结构化协议
│   └── _README.md
├── orchestration/service.ts     # 拆：只剩依赖装配与策略冻结（目标 < 600 行）
└── orchestration/product-service.ts  # 拆出：Composer/@Agent 产品接线
```

> P1 落地注记：任务存储职责由既有 `database/work-item-repository.ts` 承担（v18 的 `work_items` 即任务表，经 `CouncilDatabase` 门面暴露），不另建 `tasks/task-store.ts`；`tasks/` 只放 `task-intake.ts`（P1 只有直接任务 / 议题派生两个入口，流水线入口留给 P3）与 `task-service.ts`。委派前的任务解析与校验集中在 `orchestration/delegation-task-resolver.ts`。

`database.ts` 同步按领域拆为 `database/{topics,messages,decisions,work-items}.ts` 的薄仓储，`database.ts` 只保留连接与事务封装。`schema-migrator.ts` 不动已发布迁移，新迁移继续一文件一版。

### 3.2 执行模型

- **Task**（`work_items` 升级）：`topic_id` 可空；新增 `kind`（`code` | `image` | `prototype` | `research` | `pipeline`）、`source`（`topic` | `direct` | `pipeline`）、`priority`、`project_root_hash`（当前项目锚点，公开 DTO 不含真实路径）、`brief_json`。父子树沿用 v12 的 `parent_id`。
  > 实现偏离（v18 已落地）：未引入 `project_root_hash`，改用可空 `project_path`（议题实施项迁移/创建时从议题拷贝，非议题任务必填），并以 VIRTUAL 列 `scope_key = COALESCE(topic_id, project_path, '')` 承担树唯一索引；公开 DTO 的路径脱敏仍在边界层处理。
- **Delegation**（`work_item_delegations` 升级）：新增 `kind`（与任务一致）、`output_manifest_json`、`input_asset_ids_json`。`kind = image` 时 Runtime 必须具备 `image_generate` 能力，沙箱固定 `workspace-write`，执行目录固定为任务 worktree，不进入 review 三角（图像任务由人验收或由 Lead 验收，Reviewer 不审图）。图像委派仍走 `runExecutionSegments`，但 `maxSegments = 1`、关闭自动接续、不做草稿快照（`3be9220` 的两段接续与交接校验只服务代码任务；位图产物由 `asset-ingest` 收集，不进 `delegation-workspace-snapshot`）。
- **Pipeline** = `kind = pipeline` 的父任务 + 有序子任务。`pipeline-driver` 只做「上一阶段完成且产物入库 → 创建下一阶段子任务并挂上输入资产」，推进本身仍是显式委派，复用 `work-item-delegation-manager`。失败停在当前阶段，不自动重试图像生成（预算原因）。
- **Team**（P4）：Lead 委派可以创建 ≤ `COUNCIL_WORKER_MAX_PARALLEL` 个 Worker 子委派，每个 Worker 独立 worktree（从 Lead 分支切出），Lead 用受控 Git 合并。Worker 有效权限 ≤ Lead 有效权限。一个任务同时只允许一个活动团队（partial unique index，照 Cindy）。

### 3.3 能力与 Runtime

- `RUNTIME_CAPABILITY_KEYS` 追加 `image_generate`、`image_input`。
- Codex Runtime：
  - 新增 `image_generate` 探针：`codex features list` 含 `image_generation stable true` 且 Provider 为本机登录（无自定义 `model_providers`）时标记可用；否则 `available=false`，提示「生图需要本机 ChatGPT 登录的 Codex」。探针结果随 binding fingerprint 缓存，沿用现有可用性缓存规则。
  - `kind = image` 的调用参数：`exec --sandbox workspace-write --cd <worktree> --skip-git-repo-check --ignore-user-config --enable image_generation --json --output-schema <manifest-schema> -o <last-message> [-i <ref-asset>...]`。`--config` 继续用于锁模型与关闭网络外的其他能力。
  - 事件流解析不变；新增「产物收集」步骤：优先读 `--output-schema` 产出的清单，其次扫描 worktree 下 `.council/out/`，最后按 `thread.started.thread_id` 兜底扫描 `$CODEX_HOME/generated_images/<thread_id>/`。三处取并集，sha256 去重后入库。
- Claude Runtime：`image_input` 通过把资产复制到 worktree `.council/in/` 并在 prompt 中给出相对路径实现（Claude Code 的 Read 工具可读 PNG/JPG）。P3 需做一次端到端验证再写入 `_README.md`。
- ACP/兼容 API Runtime：两种新能力默认不声明，不参与图像任务。

### 3.4 结构化协议（新增两个尾块）

```
council-brief            由 Claude（或人）产出，是图像/原型阶段的唯一输入规格
  schemaVersion: 1
  kind: "app-mockup" | "game-sprite" | "game-tileset" | "concept-sheet" | "icon-set" | "custom"
  goal: string                       # 一句话目标
  deliverables: [{ id, description, size?: "1024x1024"|"1536x1024"|…, transparent?: bool, count?: n }]
  style: { palette?, references?: [assetId], constraints?: [string] }
  acceptance: [string]               # 人或 Lead 验收时逐条勾
  nextStage?: { kind: "prototype", notes: string }

council-asset-manifest   由图像阶段产出（映射到 --output-schema）
  schemaVersion: 1
  outputs: [{ deliverableId, path, mime, width, height, prompt, variantOf? }]
  notes: string
```

解析规则与现有 `council-work-plan` 一致：严格 JSON、未知字段拒绝、损坏清单不能成为完成摘要（沿用 `delegation-execution-result.ts` 的「交接只产出一个经过校验的对象」）。

### 3.5 数据模型变更（v18 → v20，破坏性重建可接受）

按 `docs/schema-migration-safety.md` 的纪律：一版一文件、显式列清单、备份后重建。按项目约定没有向后兼容义务，可以重建表，但必须保留备份作为唯一回滚手段。**Rust `SUPPORTED_SCHEMA_VERSION` 必须同步到 20，并重装桌面 app，否则桌面打不开库。**

```sql
-- v18：任务一等化
ALTER work_items:
  topic_id            TEXT NULL REFERENCES topics(id)      -- 由 NOT NULL 改为可空
  kind                TEXT NOT NULL DEFAULT 'code'
                      CHECK (kind IN ('code','image','prototype','research','pipeline'))
  source              TEXT NOT NULL DEFAULT 'topic'
                      CHECK (source IN ('topic','direct','pipeline'))
  priority            INTEGER NOT NULL DEFAULT 0
  project_root_hash   TEXT NOT NULL                        -- 当前项目锚点，和 topics 的项目锚点同一算法
  brief_json          TEXT NULL
  CHECK ((source = 'topic') = (topic_id IS NOT NULL))
ALTER work_item_delegations:
  kind                TEXT NOT NULL DEFAULT 'code' CHECK (...)
  input_asset_ids_json TEXT NOT NULL DEFAULT '[]'
  output_manifest_json TEXT NULL
CREATE INDEX idx_work_items_project_status ON work_items(project_root_hash, status, updated_at);
-- 实现偏离（已落地）：project_root_hash 改为可空 project_path（议题项从 topics 拷贝），
-- 索引为 (project_path, status, updated_at)；树唯一索引改用 VIRTUAL scope_key = COALESCE(topic_id, project_path, '')。

-- v19：资产
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_root_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','model3d','document','archive')),
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_rel_path TEXT NOT NULL,          -- 相对 COUNCIL_ASSET_DIR，公开 DTO 只给 id
  width INTEGER NULL, height INTEGER NULL,
  origin_delegation_id TEXT NULL REFERENCES work_item_delegations(id),
  origin_actor_id TEXT NULL REFERENCES actor_identities(id),
  prompt TEXT NULL,                        -- 生成提示词，脱敏后保存
  created_at TEXT NOT NULL,
  deleted_at TEXT NULL,
  UNIQUE (project_root_hash, sha256)
);
CREATE TABLE asset_links (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('work_item','message','decision')),
  target_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reference','output','final','brief')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, target_kind, target_id, role)
);

-- v20：团队（P4 才落，可与 v19 合并发布）
CREATE TABLE task_teams (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  lead_delegation_id TEXT NOT NULL REFERENCES work_item_delegations(id),
  status TEXT NOT NULL CHECK (status IN ('active','ended')),
  created_at TEXT NOT NULL, ended_at TEXT NULL
);
CREATE UNIQUE INDEX task_teams_one_active ON task_teams(work_item_id) WHERE status = 'active';
CREATE TABLE task_workers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES task_teams(id),
  delegation_id TEXT NOT NULL UNIQUE REFERENCES work_item_delegations(id),
  label TEXT NOT NULL, role TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle','running','done','error','archived')),
  focused INTEGER NOT NULL DEFAULT 0 CHECK (focused IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

Rust `council-core` 只读侧同步 `types.rs` / `store.rs`：任务列表允许 `topic_id` 为空，资产只读 `id/kind/mime/width/height/created_at`，不读 `storage_rel_path`。

### 3.6 接口面

| 面 | 新增 | 备注 |
|---|---|---|
| REST（`http/app.ts`） | `POST /tasks`、`GET /tasks?project&status&kind`、`GET /tasks/:id`、`POST /tasks/:id/delegations`（带 `kind`、`inputAssetIds`）、`GET /assets?project&kind`、`GET /assets/:id`（元数据）、`GET /assets/:id/content`（loopback 流式、`Content-Type` 白名单、禁缓存）、`GET /assets/:id/thumbnail`、`POST /pipelines`（模板 + brief）、`POST /tasks/:id/team` 系列（P4） | `http/app.ts` 已 984 行，按领域拆成 `http/routes/{tasks,assets,pipelines}.ts` |
| MCP（`server.ts`） | `council_create_task`、`council_list_tasks`、`council_delegate_task`、`council_list_assets`、`council_attach_asset`、`council_submit_brief`（写 `council-brief` 到任务）、`council_start_pipeline` | 给 Claude 在 Council 外（例如用户直接在 Claude Code 里）下任务用；`server.ts` 951 行，工具注册拆到 `mcp/tools/*.ts` |
| Tauri（`lib.rs`） | `list_tasks`、`get_task`、`create_task`、`list_assets`、`get_asset_thumbnail_path` | 桌面只读核心继续只读；写入走 Node HTTP |
| SSE | `task.updated`、`asset.created`、`pipeline.stage_changed` | 沿用 revision 校准机制。P1 不新增事件：任务写入走既有 SQLite revision，复用 `council.changed` 触发刷新；`task.updated` 推迟到确有按任务增量刷新需求时再加 |

P1 已落地的任务接口（Node 侧）：REST `POST /api/v1/tasks`、`GET /api/v1/tasks?project&status&kind&source`、`GET /api/v1/tasks/:taskId`（含所属议题摘要与委派列表）、`PUT /api/v1/tasks/:taskId`（乐观版本）、`GET|POST /api/v1/tasks/:taskId/delegations`（P1 只接受 `kind=code`、`inputAssetIds=[]`）；MCP `council_create_task`、`council_list_tasks`、`council_get_task`、`council_delegate_task`。stdio MCP 进程没有委派执行器，`council_delegate_task` 转发到本机 loopback HTTP 服务（地址取 `COUNCIL_HTTP_HOST/PORT`，超时 `COUNCIL_MCP_HTTP_TIMEOUT_MS`），服务未运行时明确报错。议题派生入口沿用 `POST /api/v1/topics/:topicId/work-items` 与 `council_add_work_items`。

## 4. 流水线设计（用户要的核心场景）

### 4.1 App 方案：先出图，再按图做原型

```
阶段 0 任务创建（人）：模板 app-mockup，填目标与约束；可附草图/截图作为 reference 资产
阶段 1 brief（Claude，read_only）：读项目 + reference，产出 council-brief；人可编辑后确认
阶段 2 image（Codex，workspace-write + image_generate）：
        按 brief.deliverables 逐张调用内建 image_gen，-i 带 reference 资产，
        产物复制到 worktree/.council/out/，输出 council-asset-manifest
        → asset-ingest 入库，挂到任务（role=output）
阶段 3 人工验收/选稿：资产库并排对照（方案 B 布局），勾选 final，可对单张发起「修改」子任务
阶段 4 prototype（Claude 或 Codex，repository_write）：输入 = brief + final 资产（复制到 .council/in/），
        按既有 code 委派跑 executor → reviewer → 人验收，提交到隔离分支
阶段 5 review 结果与资产一起沉淀为决策（可选）
```

### 4.2 游戏资产：Claude 指导 Codex 出图、批量变体

- 模板 `game-asset-pack`：brief.deliverables 是一组 sprite/tileset/icon，`count` 控制变体数，`transparent: true` 时提示词要求透明背景并保留 alpha（imagegen Skill 规则）。
- 「Claude 指导」= 阶段 1 的 brief + 阶段 2 结束后的 Lead 复盘：Lead（Claude）读入库资产（`image_input`）逐条对照 `acceptance`，不合格项生成「修改」子任务（kind=image，`input_asset_ids` 指向原图，brief 写明改什么），再派 Codex。这一来回有上限 `COUNCIL_PIPELINE_MAX_REVISIONS`。
- **3D 的边界要说清楚**：本机 Codex `image_gen` 只出位图，没有 3D 生成能力。v2 做到「概念图/三视图/贴图」这一层（模板 `concept-sheet`），`assets.kind = model3d` 和 `asset-ingest` 的 MIME 白名单预留 glb/obj，真正的 3D 生成器接入留到有可用工具时再作为新的 Runtime 能力 `model3d_generate` 加入，不在 v2 承诺。

### 4.3 直接接任务改代码（不经过圆桌）

- 任务板「新建任务」或 MCP `council_create_task`：标题、正文、验收标准、项目（当前/最近）、可选 reference 资产。
- 创建即可委派：选执行者（必选）、监督者（可选，缺省由执行者自审只跑 reviewer 阶段）、权限（≤ Agent 上限）、完成策略（`review` | `human`）。整条链路复用现有 `work-item-delegation-manager`，只是 `topic_id` 为空、`source = direct`。
- 没有议题就没有「accepted 决策上下文」，`delegation-task-context.ts` 需要允许 `acceptedConclusions` 为空并把任务正文作为关键材料。

## 5. UI 方案

### 5.1 信息架构

```
┌ 左侧模式栏 ┐ ┌──────────────── 主区 ────────────────┐ ┌ 右栏（按模式） ┐
│ 讨论        │ │ 讨论：保留 Operator Console，降密度   │ │ 概要/决策包     │
│ 任务 ●3     │ │ 任务：看板（待办/执行中/待审/待验收/完成）│ │ 执行时间线/团队 │
│ 资产        │ │       任务详情 = 正文 + 委派时间线 + 产物 │ │ 资产/证据       │
│ 决策        │ │ 资产：网格 + 并排对照（方案 B）+ 大图   │ │ 来源任务/brief  │
│ 架构        │ │ 决策：现 DecisionRecordsView           │ │                 │
│ 需要我处理  │ │ 流水线：阶段轨道 + 每阶段产物           │ │ 阶段控制        │
└────────────┘ └──────────────────────────────────────┘ └────────────────┘
```

- `WorkspaceView` 从 `topics|attention|architecture|decisions` 扩为 `discussion|tasks|assets|decisions|architecture|attention`，URL 可定位（`#/tasks/<id>`），支持从讨论消息、决策、资产相互跳转。
- 任务板默认按当前项目过滤，卡片只显示：标题、kind 图标、执行者头像、阶段、最近一次更新；展开才看时间线。「我现在有几个 Agent 在跑」在模式栏徽标和 `StatusBar` 常驻。
- 资产库：网格缩略图（服务端缩略图，不传原图）；选中 2～4 张进入并排对照；每张带来源任务、brief 条目、提示词、变体链；操作：设为 final、发起修改子任务、作为 reference 新建任务。
- 讨论视图降密度：右栏默认只留「概要 / 决策包 / 实施进度摘要」，「约束 / 证据 / 备选」折叠；委派面板从 tasks tab 移到任务详情页，讨论里只留跳转入口。

### 5.2 前端结构

```
packages/web/src/
├── app/
│   ├── App.tsx              # 只做壳：模式栏 + 路由 + Provider（目标 < 200 行）
│   ├── routes.ts            # WorkspaceView ↔ hash 路由
│   └── providers/           # 数据模式、i18n、主题、SSE
├── features/
│   ├── discussion/          # 现 DiscussionPanel/CyclePanel/Composer/Inspector 迁入
│   ├── tasks/               # TaskBoard、TaskDetail、TaskCreateDialog、DelegationTimeline、TeamSidebar(P4)
│   ├── assets/              # AssetGrid、AssetCompare、AssetDetail、AssetPicker
│   ├── pipelines/           # PipelineTrack、BriefEditor、StageControls
│   ├── decisions/           # 现 DecisionRecordsView
│   └── architecture/        # 现 ArchitectureView
├── components/              # 只留跨 feature 基础件：MarkdownContent、Lightbox、presentation、HeaderBar、StatusBar、files/（AssetDetail 复用 ProjectFileDialog 的只读对话框壳，加图片分支）
├── data/                    # repository 接口 + mock/http 实现；http-orchestration-repository 按领域拆
└── hooks/
```

`http-orchestration-repository.ts`（1,038 行）按领域拆为 `data/http/{topics,orchestration,tasks,assets,pipelines}.ts`，mock 同步补任务/资产夹具，让 `council-web-mock` 预览能走通新页面。

> P1 落地注记（Web 侧）：`app/` 落为 `App.tsx`（180 行壳）+ `routes.ts`（hash 解析/生成）+ 按职责拆分的 hooks（路由、工作区内容、编排状态、议题动作、桌面设置、主题、toast），没有另建 `providers/` 目录，I18n/主题沿用既有 Provider。`features/` 目前只有 `tasks/`（TaskList 按状态分组列表而非看板、TaskDetail、TaskStatusForm、TaskCreateDialog、DelegationTimeline）；讨论、决策、架构仍在 `components/`，迁入 `features/` 留到 P5 UI 收口。数据层新增 `data/tasks/`（TaskRepository + http/desktop/mock 三实现），`http-orchestration-repository.ts` 未按领域拆分（1,038 行，P1 未触碰），留到 P2 新增资产仓储时一并处理。样式新增 `styles/tasks.css`。

### 5.3 样式

沿用现有 14 个 CSS 文件的语义 token（`styles/`），新增 `tasks.css`、`assets.css`、`pipelines.css`，不引入组件库。缩略图尺寸、对照列宽、看板列宽全部走 token。

## 6. 配置与红线

### 6.1 新增配置（`config.ts` 集中加载，同步两个 `.env.example`）

```
# Codex 生图：仅当 Runtime 探针确认 image_generate 可用时生效
COUNCIL_CODEX_IMAGE_ENABLED=true
COUNCIL_CODEX_IMAGE_SANDBOX_MODE=workspace-write     # 只允许 workspace-write
COUNCIL_CODEX_IMAGE_TIMEOUT_MS=900000
COUNCIL_CODEX_IMAGE_MAX_OUTPUTS=16                   # 单次委派最多入库张数
# 资产库
COUNCIL_ASSET_DIR=                                   # 留空时 <COUNCIL_DATA_DIR>/assets
COUNCIL_ASSET_MAX_BYTES=26214400                     # 单文件 25MB
COUNCIL_ASSET_MAX_TOTAL_BYTES=5368709120             # 配额 5GB，超限拒绝入库并提示清理
COUNCIL_ASSET_MIME_ALLOWLIST=image/png,image/jpeg,image/webp,image/svg+xml,model/gltf-binary,application/pdf
COUNCIL_ASSET_THUMBNAIL_MAX_EDGE=512
# 流水线与团队
COUNCIL_PIPELINE_MAX_STAGES=6
COUNCIL_PIPELINE_MAX_REVISIONS=3
COUNCIL_WORKER_MAX_PARALLEL=3                        # P4
VITE_COUNCIL_TASK_PAGE_SIZE=100                      # web
VITE_COUNCIL_ASSET_PAGE_SIZE=60                      # web
```

`COUNCIL_CODEX_SANDBOX_MODE` 继续只允许 `read-only`，讨论路径不变；生图沙箱是独立配置项，避免一个开关放宽所有 Codex 调用。

### 6.2 隐私与安全

- 资产公开 DTO 只含 `id/kind/mime/width/height/createdAt/origin`，不含存储路径；内容只经 loopback `GET /assets/:id/content` 流式返回，带 `Content-Disposition: inline` 与 MIME 白名单，SVG 一律按 `image/svg+xml` 返回但在 Web 端经 `rehype-sanitize` 同级策略渲染或仅作下载。
- `asset-ingest` 复用 `delegation-workspace-snapshot.ts` 的拒绝规则（符号链接、疑似凭据、配置文件），再叠加 MIME 嗅探（按文件头，不信扩展名）与尺寸上限。
- 提示词与 brief 落库前走现有脱敏扫描；日志只记 `assetId`、字节数、脱敏诊断码，不记 `$CODEX_HOME` 路径和项目绝对路径。
- 图像任务 worktree 中 `.council/out/`、`.council/in/` 由 Council 写入 `.git/info/exclude`，不进入提交；需要把资产提交进仓库时，由 prototype 阶段的 code 委派按任务正文显式复制到仓库路径，走正常的敏感内容扫描与 Council 统一提交。
- 生图能力探针失败不降级为「自动走 CLI 回退」（那条路需要 `OPENAI_API_KEY`），只报不可用。

## 7. 分阶段落地（给 Opus 的任务拆分）

每个阶段结束必须通过：`npm run check`、`npm test`（仅与改动相关部分）、`npm run test:e2e`；涉及 schema 的阶段额外执行备份迁移验证与桌面重装验证。每个新目录按 magpie 的四节格式写 `_README.md`，并更新所属上级 `_README.md` 索引。

### P0 收口在途工作（半天）

- 以 HEAD `3be9220` 为基线跑一次完整 `npm run check` + `npm run test:e2e`，记录基线结果；刚合入的委派上下文改动（`delegation-task-context.ts` 等）先不叠加 v2 改动。
- 冻结 v17 备份。安装版桌面 app（0.9.8，9 月 21 日构建）早于 `13f899b` 与 `3be9220`，先从 `main` 重新构建并替换，再在桌面上跑一遍基线；HTTP/Web 侧的 24 项相关检查与浏览器 E2E 在 `3be9220` 已通过，可直接作为基线记录。
- 验收：`git status` 干净；`npm run check` 通过。

### P1 任务一等化 + 聚合层拆分（schema v18，3～4 天）

1. `service.ts` 拆出 `product-service.ts`；`database.ts` 拆领域仓储；`http/app.ts` 拆路由；`server.ts` 拆 MCP 工具注册。只搬不改行为。
2. v18 迁移：`work_items`/`work_item_delegations` 新列、`topic_id` 可空、索引；Rust 镜像 18；`delegation-task-context.ts` 允许无议题。
3. `tasks/` 领域：store、intake（direct/topic 两个入口）、REST/MCP/Tauri 接口、SSE。
4. Web：`app/` 壳 + hash 路由；`features/tasks/` 看板与详情；委派面板从讨论迁入任务详情，讨论里留入口；mock 夹具。
5. 验收：
   - 不建议题，直接新建任务 → 选 Codex/Claude 执行 → 隔离分支产生提交 → reviewer 出结论 → 人验收完成，全程不触碰 `topics`。
   - 既有「议题 → 决策 → 规划 → 委派」链路 E2E 不回归。
   - `App.tsx` < 200 行，`service.ts` < 600 行，无文件超过 1,200 行。
   - 桌面 app 重装后能打开 v18 库。

   > P1 验收结果（2026-10-10）：直接任务闭环与议题链路均由 `scripts/e2e.mjs` 覆盖（`webui-http-smoke.py` 新增“直接任务闭环”用例：浏览器新建任务 → REST 委派 → 两段交付提交 → reviewer 通过 → 任务页填证据完成，`topics` 总数不变）。`App.tsx` 180 行；原 `service.ts` 拆为 `service.ts` 601 行 + `product-service.ts` 768 行，比 600 的目标多 1 行，未为凑数再搬代码。“无文件超过 1,200 行”未达成，但超限的都是 P1 之前就存在且本阶段未重构的文件：`crates/council-core/src/store.rs` 2,406（v18 镜像 +135 行）、`packages/orchestrator/src/orchestrator.ts` 1,414（未动）、`packages/mcp-server/src/schema-migrator.ts` 1,384（+10 行）、`packages/web/src/styles/components.css` 3,580（样式，未动）；测试文件不计。这些拆分不属于 P1“只搬不改行为”的范围，列入 P5 UI 收口前的单独整理项。

### P2 资产通道 + Codex 生图委派（schema v19，4～5 天）

1. `assets/` 领域：存储、入库、缩略图、REST/MCP/Tauri、SSE。
2. 能力词表加 `image_generate`/`image_input`；Codex Runtime 加探针与 `kind = image` 参数集；`-i` 端到端验证并记入 `_README.md`。
3. `brief-protocol.ts`：两个尾块的解析与 `--output-schema` JSON Schema 生成。
4. 委派管理器支持 `kind = image`：不进入 reviewer 三角、产物收集三路并集、入库后挂任务；失败分类新增「生图不可用 / 产物缺失 / 清单损坏」。
5. Web：`features/assets/` 网格、详情、Lightbox 复用；任务详情产物区；新建任务可附 reference。
6. 验收：
   - 新建 `kind = image` 任务，brief 要求 3 张 PNG（其中 1 张透明背景）→ 资产库出现 3 张，缩略图可看，元数据含尺寸与提示词，`$CODEX_HOME` 路径不出现在任何 DTO/日志。
   - 把 Codex 指向无 image 工具的 Provider 时，探针标记不可用，创建图像委派被拒绝并给出可执行提示。
   - 资产配额超限入库被拒且有清晰提示；符号链接/伪扩展名文件被拒。

   > P2 落地契约（2026-10-10，派发前冻结；实现偏离必须回写本节）
   >
   > **分工与文件**
   > - A 后端资产：`schema-v19-migration.ts`（账本名 `asset-library`）并在 `schema-definitions.ts`/`schema-migrator.ts` 登记；`database/asset-repository.ts`（SQL，经 `CouncilDatabase` 门面暴露，与 `work-item-repository.ts` 同模式）；`assets/{asset-storage,asset-ingest,asset-preview,asset-service}.ts` + `_README.md`；`http/routes/asset-routes.ts`；`mcp/tools/asset-tools.ts`；`config.ts` 资产键；Rust `types.rs`/`store.rs` 镜像 19 与 Tauri 只读命令 `list_assets`/`get_asset`。
   > - B 运行时与协议：`RUNTIME_CAPABILITY_KEYS` 追加 `image_generate`/`image_input`；`codex-runtime.ts` 生图探针与 `generateImages`；`pipelines/brief-protocol.ts` + `_README.md`（templates/driver 留给 P3）；`config.ts` Codex 生图键；`-i` 端到端验证结论记入 README。
   > - C 图像委派：`orchestration/delegation-image-execution.ts`；`work-item-delegation-manager.ts` 只按 kind 分流；REST/MCP 放开 `kind=image` 与 `inputAssetIds`；`PUT /tasks/:id` 与 `council_submit_brief` 写 brief；失败分类；e2e 假 Codex 生图路径。
   > - D Web：`data/assets/`、`features/assets/`、`styles/assets.css`、路由 `#/assets[/<assetId>]`；任务详情 brief 与产物区；新建任务 kind 与 reference；委派表单 kind=image。
   >
   > **schema v19 `asset-library`**（只新增两张表与索引，不动旧表；外键删除动作由 A 按既有表约定定；Rust `SUPPORTED_SCHEMA_VERSION = 19`，只读 `id/kind/mime/byte_size/width/height/prompt/created_at/deleted_at/origin_*` 与 links，不读 `storage_rel_path`）
   >
   > ```sql
   > CREATE TABLE assets (
   >   id TEXT PRIMARY KEY,
   >   project_path TEXT NOT NULL,                -- 与 work_items.project_path 同一锚点（规范化绝对路径）
   >   kind TEXT NOT NULL CHECK (kind IN ('image','model3d','document','archive')),
   >   mime TEXT NOT NULL,
   >   byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
   >   sha256 TEXT NOT NULL,
   >   storage_rel_path TEXT NOT NULL,            -- 相对资产根目录；公开 DTO 不含
   >   width INTEGER, height INTEGER,
   >   origin_delegation_id TEXT REFERENCES work_item_delegations(id),
   >   origin_actor_id TEXT REFERENCES actor_identities(id),
   >   prompt TEXT,                               -- 脱敏后的生成提示词
   >   created_at TEXT NOT NULL,
   >   deleted_at TEXT,
   >   UNIQUE (project_path, sha256)
   > );
   > CREATE INDEX idx_assets_project_kind ON assets(project_path, kind, created_at);
   > CREATE TABLE asset_links (
   >   asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
   >   target_kind TEXT NOT NULL CHECK (target_kind IN ('work_item','message','decision')),
   >   target_id TEXT NOT NULL,
   >   role TEXT NOT NULL CHECK (role IN ('reference','output','final','brief')),
   >   created_at TEXT NOT NULL,
   >   PRIMARY KEY (asset_id, target_kind, target_id, role)
   > );
   > CREATE INDEX idx_asset_links_target ON asset_links(target_kind, target_id);
   > ```
   >
   > **资产落盘（A）**：根目录 `COUNCIL_ASSET_DIR`（留空为 `<COUNCIL_DATA_DIR>/assets`），文件放 `<sha256 前 2 位>/<sha256>.<ext>`，ext 由 MIME 决定；先写临时文件再 rename；配额按未删除行的 `byte_size` 求和。MIME 按文件头嗅探（PNG/JPEG/WebP/GIF 魔数、SVG 文本探测、glb `glTF`、PDF `%PDF`），不信扩展名；白名单 `COUNCIL_ASSET_MIME_ALLOWLIST`；拒绝符号链接（`lstat`）、超 `COUNCIL_ASSET_MAX_BYTES`、超总配额；宽高从 PNG/JPEG/WebP 头解析，纯 JS 不加原生依赖（sidecar 是 Node SEA 单文件）。缩略图由外部命令 `COUNCIL_ASSET_THUMBNAIL_COMMAND`（默认 `sips`，超时 `COUNCIL_ASSET_THUMBNAIL_TIMEOUT_MS`）生成 PNG，最长边 `COUNCIL_ASSET_THUMBNAIL_MAX_EDGE`，缓存在 `<asset-root>/thumbnails/<sha256>.png`；SVG 直接返回原文；非图像 404。
   >
   > **公开 DTO `Asset`**：`{ id, kind, mime, byteSize, sha256, width?, height?, prompt?, origin: { delegationId?, actorId? }, createdAt, deletedAt?, links: [{ targetKind, targetId, role, createdAt }] }`，不含任何路径。
   >
   > **REST（`/api/v1`，A；放开委派与 brief 的两条由 C）**
   > - `GET /assets?project=<abs>&kind=&target=<work_item|message|decision>:<id>&limit=&offset=` → `{ items, total, count, offset, hasMore }`，默认不含已删除
   > - `GET /assets/:assetId` → Asset
   > - `GET /assets/:assetId/content` → 原始字节；`Content-Type` 取库中 mime（必在白名单），`Content-Disposition: inline; filename="<id>.<ext>"`，`Cache-Control: no-store`，`X-Content-Type-Options: nosniff`，SVG 额外 `Content-Security-Policy: sandbox; script-src 'none'`
   > - `GET /assets/:assetId/thumbnail` → `image/png`，不可用时 404
   > - `POST /assets/import` `{ projectPath, relativePath }` → 从项目目录导入（走 `project-path-policy` 的 realpath/越界/敏感路径拒绝），201 新建或 200 返回同 sha256 既有资产
   > - `POST /assets/:assetId/links` `{ targetKind, targetId, role }` → 201；`DELETE /assets/:assetId/links/:targetKind/:targetId/:role` → 204
   > - `DELETE /assets/:assetId` → 软删除 204，之后 content/thumbnail 404
   > - `POST /tasks/:taskId/delegations` 放开 `kind: "image"` 与 `inputAssetIds`（须同项目、kind=image、未删除，最多 8 个）；`PUT /tasks/:taskId` 新增可选 `brief`（按 `council-brief` 校验）
   > - 资产写入推进内容 revision，沿用 `council.changed`，不新增 SSE 事件类型；请求体上限不变，P2 不做上传接口
   >
   > **MCP**：`council_list_assets`、`council_get_asset`、`council_import_asset`、`council_attach_asset`（A）；`council_delegate_task` 接受 `kind`/`inputAssetIds`，`council_submit_brief`（C）。stdio 进程直连数据库（与任务工具同模式），委派仍转发 loopback HTTP。
   >
   > **能力与 Codex 生图（B）**：`RUNTIME_CAPABILITY_KEYS` 追加 `image_generate`、`image_input`，所有枚举消费者同步。探针：`codex features list` 每行 `<name> <stage> <enabled>`，`image_generation stable true` 且 Council 传给 Codex 的参数未覆盖 `model_provider` 时声明 `image_generate` 与 `image_input`；结果随现有可用性缓存。`CodexRuntime.generateImages({ worktreeDir, prompt, outputSchemaPath, lastMessagePath, inputImagePaths, model?, timeoutMs, onEvent })` → `{ threadId, lastMessage }`，参数固定 `exec --sandbox workspace-write --cd <worktree> --skip-git-repo-check --ignore-user-config --enable image_generation --json --output-schema <path> -o <path> [-i <path>]...`；`COUNCIL_CODEX_IMAGE_SANDBOX_MODE` 只接受 `workspace-write`；`COUNCIL_CODEX_IMAGE_ENABLED=false` 时探针直接不可用。
   >
   > **brief-protocol（B）**：`parseCouncilBrief(value: unknown)`（严格 JSON、未知字段拒绝）、`parseCouncilAssetManifest(value)`、`assetManifestJsonSchema()`（给 `--output-schema`，`additionalProperties: false`）、`renderImageBriefPrompt(brief, { outputDir: ".council/out", inputs: [{ assetId, relativePath }] })`：按 imagegen 规则写提示（不覆盖已有文件、变体用 `-v2` 兄弟名、最终产物复制进 outputDir、按 schema 输出清单）。
   >
   > **图像委派（C）**：单段（`maxSegments = 1`、无自动接续、无草稿快照）、不进 reviewer 三角、`completionPolicy` 固定 `human`；启动前校验执行者 granted 含 `image_generate`，否则拒绝并提示「生图需要本机 ChatGPT 登录的 Codex」；worktree 内建 `.council/in/`（输入资产拷贝）与 `.council/out/`，写入 `.git/info/exclude`；产物收集三路并集（清单 path → `.council/out/` 扫描 → `$CODEX_HOME/generated_images/<threadId>/`），sha256 去重后经 `asset-ingest` 入库（origin_delegation_id/actor/prompt），`asset_links` 挂 `work_item` role=`output`，`output_manifest_json` 存校验后的清单；失败分类新增 `image_unavailable` / `outputs_missing` / `manifest_invalid`；审计记产物数与字节数，日志不出现 `$CODEX_HOME` 或绝对路径；最多入库 `COUNCIL_CODEX_IMAGE_MAX_OUTPUTS`。
   >
   > **Web（D）**：路由 `#/assets[/<assetId>]`；`data/assets/` 三种模式仓储（http 直连 REST；desktop 列表/详情走 Tauri 只读命令、内容与写入走 sidecar HTTP，沿用任务页桥接方式；mock 内存夹具）；`features/assets/`：网格（kind 筛选、分页）、详情（元数据、links、Lightbox 看原图、设为 final、删除）、导入对话框；任务详情：brief 展示/编辑（BriefEditor 生成 council-brief）、产物区（output/final 缩略图网格 + Lightbox）、委派表单 kind 选择（image 时只列 granted 含 `image_generate` 的执行者、无审核者、可选 reference 资产）；新建任务 kind（code/image）与 brief；`styles/assets.css`；i18n；`<img src>` 指向 `/api/v1/assets/:id/thumbnail|content`。
   >
   > **新增配置（同步 `.env.example`）**：`COUNCIL_CODEX_IMAGE_ENABLED=true`、`COUNCIL_CODEX_IMAGE_SANDBOX_MODE=workspace-write`、`COUNCIL_CODEX_IMAGE_TIMEOUT_MS=900000`、`COUNCIL_CODEX_IMAGE_MAX_OUTPUTS=16`、`COUNCIL_ASSET_DIR=`、`COUNCIL_ASSET_MAX_BYTES=26214400`、`COUNCIL_ASSET_MAX_TOTAL_BYTES=5368709120`、`COUNCIL_ASSET_MIME_ALLOWLIST=image/png,image/jpeg,image/webp,image/svg+xml,model/gltf-binary,application/pdf`、`COUNCIL_ASSET_THUMBNAIL_MAX_EDGE=512`、`COUNCIL_ASSET_THUMBNAIL_COMMAND=sips`、`COUNCIL_ASSET_THUMBNAIL_TIMEOUT_MS=10000`；web `VITE_COUNCIL_ASSET_PAGE_SIZE=60`。
   >
   > **实现偏离（A 已落地）**：① v19 额外新增 5 个内容 revision 触发器（`trg_assets_revision_insert/update/delete`、`trg_asset_links_revision_insert/delete`），让资产写入走现有 `council.changed`；② `origin_delegation_id` 定为 `ON DELETE SET NULL`（委派随议题/实施项级联删除时资产保留），`origin_actor_id` 不带动作；③ `UNIQUE(project_path, sha256)` 覆盖已删除行，软删除后同内容再导入会恢复原行（清 `deleted_at`，重新过配额）并返回 200；软删除只打标记、不删磁盘文件（暂无 GC），所以磁盘占用可能高于按行求和的配额；④ 导入拒绝按原因映射状态码：越界/敏感路径/符号链接 403、文件不存在 404、超单文件上限 413、非普通文件/类型不在白名单 415、超总配额 507；GIF 能嗅探出来，但默认白名单没有它，所以默认返回 415；⑤ 加链接是幂等的（重复添加仍返回 201 和当前 Asset），目标必须存在（否则 404），并且与资产属于同一项目（否则 409；议题未绑定项目时不做比对）；⑥ REST 导入记 `origin.actorId = "human"`，MCP 导入记调用者 Actor；⑦ `CouncilConfig.assets` 与 `CouncilHttpConfig.assets` 都是可选字段，手工构造配置时按数据目录回落到代码默认值；sidecar 默认值 JSON 未加资产键（全部有代码默认值）；⑧ 列表分页默认 60、上限 200；Tauri `list_assets(project_path, kind?, target?, limit?, offset?)` 与 REST `GET /assets` 同参同形：`target` 为 `<targetKind>:<targetId>`，`limit` 缺省 60、范围 1–200，返回 `{ items, total, count, offset, hasMore }`，不含已软删除资产（没有 `nextOffset`、`includeDeleted`）；`get_asset(id)` 不存在或已删除时返回 `null`；⑨ 不超过最长边的 PNG 缩略图直接返回原图；外部命令的产物会校验确为 PNG 且尺寸不超限，校验通过才缓存，失败按 404 处理。

### P3 流水线 + 并排对照（4～5 天）

1. `pipelines/`：模板（app-mockup、game-asset-pack、concept-sheet）、driver（阶段推进、产物传递、修订上限）。
2. Claude Runtime `image_input`：资产复制到 `.council/in/` + prompt 相对路径；端到端验证 Claude 能描述图片内容。
3. Lead 复盘：image 阶段后由 brief 作者 Agent 对照 `acceptance` 生成修改子任务（有上限）。
4. Web：`features/pipelines/` 阶段轨道、BriefEditor（人可改 brief 再确认）、`AssetCompare` 并排对照（落地方案 B 的双栏对照思路）、选 final。
5. 验收：
   - app-mockup 模板从「一句话需求」跑到「原型分支提交」，中间人只做两次点击：确认 brief、选 final。
   - game-asset-pack 模板一次出 ≥ 6 张透明 sprite，Lead 复盘能把不合格项派回 Codex 重画一次。
   - 任一阶段失败停住且可从该阶段恢复，不重跑已入库资产。

### P4 Worker 团队 + 配置分发（schema v20，可选，4～6 天）

1. `task_teams`/`task_workers` 与 6 个 MCP 工具；Lead 分支 → Worker worktree → 受控合并；Worker 权限 ≤ Lead。
2. Web 任务详情右栏「团队」：Worker 列表、聚焦、打断、归档。
3. magpie 式配置分发：Council 向 Claude/Codex 写 MCP 注册与 Skill 时 stash/applied/drift，替代 `docs/mcp-setup.md` 的手工步骤。
4. 验收：一个 Lead 并行派 3 个 Worker 改不同目录，合并后 reviewer 审一次；中途打断 1 个 Worker 不影响其余；配置分发断开后能还原原文件。

### P5 UI 收口与文档（2～3 天）

- 讨论视图降密度；模式栏徽标；`StatusBar` 活动 Agent 计数；i18n 补齐；`docs/usage.md`、`docs/execution-delivery.md`、`README.zh.md` 更新；`docs/designs/` 补任务板/资产库/流水线三张截图。
- 验收：桌面从首次运行到跑通 P3 的 app-mockup 全流程，仅靠 `docs/usage.md` 指引完成。

## 8. 风险、未知与明确不做

| 项 | 性质 | 处理 |
|---|---|---|
| Codex 生图只对 OpenAI actor Provider 可用；自建中转会静默没有工具 | 事实（magpie 源码 + 探针） | 能力探针 + 明确不可用提示；不做 CLI/API 回退 |
| `exec --json` 看不到图像工具调用 | 事实（探针） | 以清单 + 文件产物为准；审计记录「产物数」而非「调用数」 |
| `-i` 参考图与 Claude 读图未端到端验证 | 未知 | P2/P3 各留一条验证任务，验证前不写进用户文档 |
| 3D 生成 | 本机无能力 | v2 只做概念图/贴图层，预留 `model3d` 资产类型与能力键，不承诺 |
| 破坏性迁移 | 已知风险 | 备份是唯一回滚；桌面必须重装；三次迁移合并发布前各自可独立验证 |
| 最近一批委派改动刚合入，尚无 v2 之外的回归基线 | 已知 | P0 先跑基线，P1 拆分只搬不改行为 |
| 文件行数红线 | 已知 | P1 先拆后加；任何阶段新增文件 > 800 行即拆 |
| 资产占用磁盘 | 已知 | 配额 + 软删除 + 资产库「清理未引用」入口（P5） |
| 不做：Council 自己调图像 API、通用网关、多端同步、Electron 迁移 | 决策 | 与「连接而非再造智能」和单机定位一致 |

## 9. 给执行者的工作方式约定

- 一个阶段一个分支，阶段内按上面编号拆 PR；每个 PR 的描述写清改动边界与验证命令。
- 所有新目录和被拆分的目录都写/更新 `_README.md`；行为或边界变化同步 `docs/`。
- 新增环境变量同步 `packages/mcp-server/.env.example` 与 `packages/web/.env.example`，同一文件不重复 key。
- 不新增单元测试；验证靠 `npm run check`、相关既有测试、`npm run test:e2e`，以及真实启动桌面/HTTP 服务走通流程。临时探针脚本放仓库外。
- 任何输出、日志、文档不得出现真实绝对路径、`$CODEX_HOME` 下的真实目录、凭据或个人身份；用 `<data-dir>`、`<project-root>` 占位。
