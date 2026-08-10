/**
 * @input  依赖：无
 * @output 导出：协议枚举、输入边界与服务标识
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
export const WORK_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
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
export const MAX_WORK_ITEM_BATCH = 50;
export const MAX_WORK_ITEM_DETAILS_CHARS = 8_000;
export const MAX_WORK_ITEM_STATUS_NOTE_CHARS = 4_000;
/** 单个圆桌的轮次预算上限：再多说明分歧不该由 Agent 自己吵出结果。 */
export const MAX_CYCLE_ROUND_BUDGET = 10;
export const MAX_ORCHESTRATION_STARTUP_SCAN = 10_000;
export const MAX_PATH_CHARS = 4_096;
