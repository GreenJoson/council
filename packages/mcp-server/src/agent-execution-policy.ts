/**
 * @input  依赖：Model Router 持久化字符串与显式任务委派请求
 * @output 导出：Agent 执行权限、职责、能力判定及权限交集
 * @pos    讨论只读与任务执行之间的唯一权限语义边界；Provider 参数不得绕过本层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const AGENT_PERMISSION_PROFILES = [
  "read_only",
  "workspace_write",
  "danger_full_access",
] as const;

export type AgentPermissionProfile = (typeof AGENT_PERMISSION_PROFILES)[number];

export const AGENT_EXECUTION_ROLES = [
  "advisor",
  "executor",
  "reviewer",
  "hybrid",
] as const;

export type AgentExecutionRole = (typeof AGENT_EXECUTION_ROLES)[number];

const PERMISSION_RANK: Readonly<Record<AgentPermissionProfile, number>> = {
  read_only: 0,
  workspace_write: 1,
  danger_full_access: 2,
};

export function canExecute(role: AgentExecutionRole): boolean {
  return role === "executor" || role === "hybrid";
}

export function canReview(role: AgentExecutionRole): boolean {
  return role === "reviewer" || role === "hybrid";
}

/** 实际授权永远取 Agent 上限与本次请求中更保守的一档。 */
export function intersectPermissionProfiles(
  ceiling: AgentPermissionProfile,
  requested: AgentPermissionProfile,
): AgentPermissionProfile {
  return PERMISSION_RANK[ceiling] <= PERMISSION_RANK[requested] ? ceiling : requested;
}

export function isExecutionPermission(
  profile: AgentPermissionProfile,
): profile is Exclude<AgentPermissionProfile, "read_only"> {
  return profile !== "read_only";
}
