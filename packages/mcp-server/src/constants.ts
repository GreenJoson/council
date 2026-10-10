/**
 * @input  依赖：无
 * @output 导出：协议枚举（含 v18 任务 kind/source、v19 资产 kind/链接目标/角色）、输入边界（含图像委派参考图上限、流水线文档上限）与服务标识
 * @pos    MCP 服务的集中式不变量定义
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const SERVER_NAME = "council-mcp-server";
export const SERVER_VERSION = "0.1.0";

export const TOPIC_STATUSES = ["open", "decided", "closed"] as const;
export const MESSAGE_KINDS = [
  "brief",
  "proposal",
  "critique",
  "rebuttal",
  "synthesis",
  "note",
] as const;
export const DECISION_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
] as const;
/** 审核发现（review_finding）由评审尾块自动录入，manual 是用户或 Agent 手工拆的交付项。 */
export const WORK_ITEM_ORIGINS = ["manual", "review_finding"] as const;

/** 只有 blocking 发现会拦住审核收敛；non_blocking 记录在案但不阻塞。 */
export const WORK_ITEM_SEVERITIES = ["blocking", "non_blocking"] as const;

export const WORK_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
] as const;

/** v18 任务产出类型与来源；与 work_items 的 CHECK 枚举一致，types.ts 与 Zod 共用。 */
export const WORK_ITEM_KINDS = ["code", "image", "prototype", "research", "pipeline"] as const;
export const WORK_ITEM_SOURCES = ["topic", "direct", "pipeline"] as const;
/** 任务简报 JSON 序列化后的上限，防止把大文件塞进 brief_json。 */
export const MAX_TASK_BRIEF_CHARS = 16_000;
/** 流水线父任务的 council-pipeline 文档（含草稿与确认 brief、复盘记录）序列化上限。 */
export const MAX_PIPELINE_DOCUMENT_CHARS = 64_000;

/** v19 资产库枚举；与 assets / asset_links 的 CHECK 一致，types.ts、Zod 与 Rust 镜像共用同一组取值。 */
export const ASSET_KINDS = ["image", "model3d", "document", "archive"] as const;
export const ASSET_LINK_TARGET_KINDS = ["work_item", "message", "decision"] as const;
export const ASSET_LINK_ROLES = ["reference", "output", "final", "brief"] as const;
/** 生成提示词入库前截断，避免把整段 brief 或日志塞进资产行。 */
export const MAX_ASSET_PROMPT_CHARS = 8_000;
/** 资产列表分页：与 web VITE_COUNCIL_ASSET_PAGE_SIZE 默认值一致。 */
export const DEFAULT_ASSET_PAGE_LIMIT = 60;
export const MAX_ASSET_PAGE_LIMIT = 200;
/** 入库嗅探能识别的 MIME；COUNCIL_ASSET_MIME_ALLOWLIST 只能取其子集。 */
export const ASSET_SNIFFABLE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "model/gltf-binary",
  "application/pdf",
] as const;

export const MAX_TITLE_CHARS = 200;
export const MAX_ID_CHARS = 250;
export const MAX_QUESTION_CHARS = 12_000;
export const MAX_MESSAGE_CHARS = 30_000;
export const MAX_INSTRUCTION_CHARS = 8_000;
export const MAX_CONSTRAINT_COUNT = 50;
export const MAX_CONSTRAINT_CHARS = 1_000;
export const MAX_ALTERNATIVE_COUNT = 30;
export const MAX_LIST_LIMIT = 100;
export const MAX_ORCHESTRATION_PLAN_ROUNDS = 50;
/** 单次人工确认允许处理的决策项数量；批量入口必须有界。 */
export const MAX_DECISION_BATCH = 100;
export const MAX_WORK_ITEM_BATCH = 50;
/** 单次图像委派可带的参考图上限（另受 brief 协议 maxInputs 约束，取较小值）。 */
export const MAX_IMAGE_INPUT_ASSETS = 8;
export const MAX_WORK_ITEM_DETAILS_CHARS = 8_000;
export const MAX_WORK_ITEM_STATUS_NOTE_CHARS = 4_000;
/** 单个圆桌的轮次预算上限：再多说明分歧不该由 Agent 自己吵出结果。 */
export const MAX_CYCLE_ROUND_BUDGET = 10;
export const MAX_ORCHESTRATION_STARTUP_SCAN = 10_000;
export const MAX_PATH_CHARS = 4_096;
