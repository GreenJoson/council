/**
 * @input  依赖：无
 * @output 导出：编排状态、消息类型、终止原因与失败代码枚举
 * @pos    自动轮次状态机的集中式协议不变量
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const RUN_STATUSES = [
  "idle",
  "running",
  "waiting_agent",
  "waiting_user",
  "completed",
  "failed",
  "cancelled",
] as const;

export const MESSAGE_KINDS = [
  "brief",
  "proposal",
  "critique",
  "rebuttal",
  "synthesis",
  "note",
] as const;

export const PUBLIC_AUTHORS = ["human", "claude", "codex", "chair", "other"] as const;

export const STOP_REASONS = ["plan_completed", "max_rounds_reached"] as const;

export const FAILURE_CODES = [
  "agent_unavailable",
  "agent_failed",
  "agent_timeout",
  "agent_cleanup_timeout",
  "execution_interrupted",
  "store_failed",
] as const;

export const MAX_AGENT_ID_CHARS = 100;
export const MAX_APPROVAL_ID_CHARS = 200;
export const MAX_LEASE_OWNER_CHARS = 200;
export const MAX_MESSAGE_CHARS = 30_000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** 仅用于读取旧 V1 快照；新运行必须由调用方显式配置。 */
export const LEGACY_AGENT_CLEANUP_TIMEOUT_MS = 5_000;
