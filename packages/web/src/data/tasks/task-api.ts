/**
 * @input  依赖：api-types 的严格 WorkItem 解析、orchestration-api 的委派解析与 workspace-mapper 行映射
 * @output 导出：任务行、任务列表、可空任务（Tauri get_task）与任务详情 {task, topic?, delegations} 解析函数
 * @pos    任务领域唯一协议校验入口；REST 与 Tauri 返回的未知 JSON 都先经这里再进入 UI
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { parseApiWorkItem } from "../api-types";
import { parseWorkItemDelegations } from "../orchestration-api";
import { mapWorkItem } from "../workspace-mapper";
import type { CouncilWorkItem } from "../../types/council";
import type { TaskDetail, TaskTopicSummary } from "../../types/tasks";

const TOPIC_STATUSES: readonly TaskTopicSummary["status"][] = ["open", "decided", "closed"];

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} 必须是非空字符串`);
  }
  return value;
}

export function parseTask(value: unknown): CouncilWorkItem {
  return mapWorkItem(parseApiWorkItem(value));
}

export function parseTasks(value: unknown): CouncilWorkItem[] {
  if (!Array.isArray(value)) {
    throw new Error("tasks 必须是数组");
  }
  return value.map(parseTask);
}

/** Tauri get_task 对不存在的任务返回 null，交给仓储决定如何提示。 */
export function parseOptionalTask(value: unknown): CouncilWorkItem | null {
  return value === null ? null : parseTask(value);
}

function parseTaskTopic(value: unknown): TaskTopicSummary {
  const record = readRecord(value, "task.topic");
  const status = readNonEmptyString(record, "status", "task.topic");
  if (!TOPIC_STATUSES.includes(status as TaskTopicSummary["status"])) {
    throw new Error("task.topic.status 包含不支持的值");
  }
  return {
    id: readNonEmptyString(record, "id", "task.topic"),
    title: readNonEmptyString(record, "title", "task.topic"),
    status: status as TaskTopicSummary["status"],
  };
}

export function parseTaskDetail(value: unknown): TaskDetail {
  const record = readRecord(value, "task detail");
  const task = parseTask(record.task);
  const delegations = parseWorkItemDelegations(record.delegations);
  if (delegations.some((delegation) => delegation.workItemId !== task.id)) {
    throw new Error("task detail 的委派不属于该任务");
  }
  return {
    task,
    ...(record.topic === undefined ? {} : { topic: parseTaskTopic(record.topic) }),
    delegations,
  };
}
