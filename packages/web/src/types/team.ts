/**
 * @input  依赖：orchestration.ts 的委派类型
 * @output 导出：TaskTeam / TaskWorker（P4 Lead/Worker 团队与其 Worker 子委派）、团队/Worker 状态联合类型与常量、
 *         从任务详情以团队模式发起 Lead 委派的入参 StartTaskTeamInput 与结果 StartTaskTeamResult
 * @pos    /api/v1/tasks/:taskId/team 在 Web 端的稳定领域模型；字段名与后端 REST 契约一一对应，不做改名
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { WorkItemDelegation } from "./orchestration";

export type TaskTeamStatus = "active" | "ended";
export type TaskWorkerStatus = "idle" | "running" | "done" | "error" | "archived";

export const TASK_TEAM_STATUSES: readonly TaskTeamStatus[] = ["active", "ended"];
export const TASK_WORKER_STATUSES: readonly TaskWorkerStatus[] = ["idle", "running", "done", "error", "archived"];

/** Worker 子委派的摘要：至少带状态、进度、失败分类与提交；后端给出完整委派时其余字段一并保留。 */
export type TaskWorkerDelegation =
  Pick<WorkItemDelegation, "status" | "execution" | "failureCode" | "headCommit">
  & Partial<WorkItemDelegation>;

export interface TaskWorker {
  id: string;
  teamId: string;
  delegationId: string;
  label: string;
  role?: string;
  status: TaskWorkerStatus;
  /** 团队内至多一个 Worker 被聚焦；聚焦只影响展示，不改变执行。 */
  focused: boolean;
  branchName?: string;
  /** Lead 受控合并后写入的提交。 */
  mergedCommit?: string;
  /** Worker 负责的目录范围（相对项目根）。 */
  scopePaths: string[];
  createdAt: string;
  updatedAt: string;
  delegation?: TaskWorkerDelegation;
}

export interface TaskTeam {
  id: string;
  workItemId: string;
  /** Lead 委派：即该任务委派区里的一条代码委派。 */
  leadDelegationId: string;
  status: TaskTeamStatus;
  maxParallel: number;
  createdAt: string;
  endedAt?: string;
  workers: TaskWorker[];
}

/** POST /api/v1/tasks/:taskId/team 的请求体。 */
export interface StartTaskTeamInput {
  expectedVersion: number;
  executorAgentId: string;
  supervisorAgentId?: string;
  requestedPermission: "workspace_write" | "danger_full_access";
  acceptanceCriteria?: string;
  completionPolicy?: "review" | "human";
  createInitialBaseline?: boolean;
  /** 并行 Worker 上限，界面限定 1–6。 */
  maxParallel?: number;
}

export interface StartTaskTeamResult {
  team: TaskTeam;
  leadDelegation: WorkItemDelegation;
}
