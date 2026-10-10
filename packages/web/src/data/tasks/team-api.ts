/**
 * @input  依赖：types/team 的团队/Worker 类型与状态常量、orchestration-api 的完整委派解析
 * @output 导出：parseTaskTeam、parseTaskWorker、parseStartTaskTeamResult —— /api/v1/tasks/:taskId/team 系列响应的解析
 * @pos    团队协议唯一校验入口：宽松 record 校验（未知字段忽略），缺字段或枚举越界时抛出可读错误；
 *         Worker 的 delegation 摘要优先按完整委派解析，不完整时只保留状态、进度、失败分类与提交
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { parseWorkItemDelegation } from "../orchestration-api";
import type { WorkItemDelegation } from "../../types/orchestration";
import {
  TASK_TEAM_STATUSES,
  TASK_WORKER_STATUSES,
  type StartTaskTeamResult,
  type TaskTeam,
  type TaskWorker,
  type TaskWorkerDelegation,
} from "../../types/team";

const DELEGATION_STATUSES: readonly WorkItemDelegation["status"][] = [
  "queued", "executing", "reviewing", "changes_requested", "approved", "failed", "cancelled",
];
const EXECUTION_PHASES = ["brief", "execution", "commit", "review"] as const;

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} 必须是非空字符串`);
  }
  return value;
}

/** 可选字符串：缺省、null 与空串都视为没有；类型不对才报错。 */
function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${path}.${key} 必须是字符串`);
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T {
  const value = readString(record, key, path);
  if (!allowed.includes(value as T)) {
    throw new Error(`${path}.${key} 包含不支持的值：${value}`);
  }
  return value as T;
}

function readOptionalNumber(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path}.${key} 必须是数字`);
  return value;
}

/** 摘要里的执行进度：只保留 DelegationExecutionProgress 用得到的白名单字段。 */
function parseExecution(value: unknown, path: string): NonNullable<WorkItemDelegation["execution"]> {
  const record = readRecord(value, path);
  const optionalNumber = (key: string) => readOptionalNumber(record, key, path);
  const optionalString = (key: string) => readOptionalString(record, key, path);
  const entries = {
    turnsUsed: optionalNumber("turnsUsed"),
    turnLimit: optionalNumber("turnLimit"),
    toolCalls: optionalNumber("toolCalls"),
    segmentsUsed: optionalNumber("segmentsUsed"),
    segmentLimit: optionalNumber("segmentLimit"),
    lastTool: optionalString("lastTool"),
    stopReason: optionalString("stopReason"),
    executionDeadline: optionalString("executionDeadline"),
  };
  return {
    phase: readEnum(record, "phase", EXECUTION_PHASES, path),
    phaseStartedAt: readString(record, "phaseStartedAt", path),
    lastActivityAt: readString(record, "lastActivityAt", path),
    ...Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry !== undefined)),
    checkpointAvailable: record.checkpointAvailable === true,
  };
}

function parseWorkerDelegation(value: unknown, path: string): TaskWorkerDelegation {
  try {
    // 后端给出完整委派时保留全部字段（审计、分支等）。
    return parseWorkItemDelegation(value);
  } catch {
    const record = readRecord(value, path);
    const failureCode = readOptionalString(record, "failureCode", path);
    const headCommit = readOptionalString(record, "headCommit", path);
    const error = readOptionalString(record, "error", path);
    return {
      status: readEnum(record, "status", DELEGATION_STATUSES, path),
      ...(record.execution !== undefined && record.execution !== null
        ? { execution: parseExecution(record.execution, `${path}.execution`) }
        : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(headCommit ? { headCommit } : {}),
      ...(error ? { error } : {}),
    };
  }
}

export function parseTaskWorker(value: unknown, path = "worker"): TaskWorker {
  const record = readRecord(value, path);
  const scopeRaw = record.scopePaths ?? [];
  if (!Array.isArray(scopeRaw) || scopeRaw.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path}.scopePaths 必须是字符串数组`);
  }
  const role = readOptionalString(record, "role", path);
  const branchName = readOptionalString(record, "branchName", path);
  const mergedCommit = readOptionalString(record, "mergedCommit", path);
  return {
    id: readString(record, "id", path),
    teamId: readString(record, "teamId", path),
    delegationId: readString(record, "delegationId", path),
    label: readString(record, "label", path),
    ...(role ? { role } : {}),
    status: readEnum(record, "status", TASK_WORKER_STATUSES, path),
    focused: record.focused === true,
    ...(branchName ? { branchName } : {}),
    ...(mergedCommit ? { mergedCommit } : {}),
    scopePaths: (scopeRaw as string[]).filter((entry) => entry.length > 0),
    createdAt: readString(record, "createdAt", path),
    updatedAt: readString(record, "updatedAt", path),
    ...(record.delegation !== undefined && record.delegation !== null
      ? { delegation: parseWorkerDelegation(record.delegation, `${path}.delegation`) }
      : {}),
  };
}

export function parseTaskTeam(value: unknown): TaskTeam {
  const path = "team";
  const record = readRecord(value, path);
  const maxParallel = readOptionalNumber(record, "maxParallel", path);
  if (maxParallel === undefined || !Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error("team.maxParallel 必须是正整数");
  }
  const workersRaw = record.workers ?? [];
  if (!Array.isArray(workersRaw)) {
    throw new Error("team.workers 必须是数组");
  }
  const endedAt = readOptionalString(record, "endedAt", path);
  const team: TaskTeam = {
    id: readString(record, "id", path),
    workItemId: readString(record, "workItemId", path),
    leadDelegationId: readString(record, "leadDelegationId", path),
    status: readEnum(record, "status", TASK_TEAM_STATUSES, path),
    maxParallel,
    createdAt: readString(record, "createdAt", path),
    ...(endedAt ? { endedAt } : {}),
    workers: workersRaw.map((entry, index) => parseTaskWorker(entry, `team.workers[${String(index)}]`)),
  };
  if (team.workers.some((worker) => worker.teamId !== team.id)) {
    throw new Error("team.workers 中有不属于该团队的 Worker");
  }
  return team;
}

export function parseStartTaskTeamResult(value: unknown): StartTaskTeamResult {
  const record = readRecord(value, "start team result");
  return {
    team: parseTaskTeam(record.team),
    leadDelegation: parseWorkItemDelegation(record.leadDelegation),
  };
}
