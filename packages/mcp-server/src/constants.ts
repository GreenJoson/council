/**
 * @input  依赖：无
 * @output 导出：协议枚举、输入边界与服务标识
 * @pos    MCP 服务的集中式不变量定义
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const SERVER_NAME = "architecture-council-mcp-server";
export const SERVER_VERSION = "0.1.0";

export const TOPIC_STATUSES = ["open", "decided", "closed"] as const;
export const AUTHORS = ["human", "claude", "codex", "chair", "other"] as const;
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

export const MAX_TITLE_CHARS = 200;
export const MAX_QUESTION_CHARS = 12_000;
export const MAX_MESSAGE_CHARS = 30_000;
export const MAX_INSTRUCTION_CHARS = 8_000;
export const MAX_CONSTRAINT_COUNT = 50;
export const MAX_CONSTRAINT_CHARS = 1_000;
export const MAX_ALTERNATIVE_COUNT = 30;
export const MAX_LIST_LIMIT = 100;
export const MAX_PATH_CHARS = 4_096;
