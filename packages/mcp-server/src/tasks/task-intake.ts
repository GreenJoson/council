/**
 * @input  依赖：CouncilDatabase（实施项写入）、project-path 规范化、共享常量与领域类型
 * @output 导出：normalizeDirectTaskInput、createDirectTask（直接任务入口）、createTopicTasks（议题拆解入口）
 * @pos    任务的两个创建入口：直接任务在此归一化（标题去空白且非空、项目路径规范化、kind/priority 缺省、brief 边界），议题入口沿用议题拆解语义
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { MAX_TASK_BRIEF_CHARS, MAX_TITLE_CHARS, MAX_WORK_ITEM_DETAILS_CHARS } from "../constants.js";
import type { CouncilDatabase } from "../database.js";
import { CouncilValidationError } from "../errors.js";
import { normalizeProjectPath } from "../project-path.js";
import type { WorkItem, WorkItemKind } from "../types.js";

export interface DirectTaskInput {
  projectPath: string;
  title: string;
  details?: string;
  kind?: WorkItemKind;
  priority?: number;
  brief?: Record<string, unknown>;
}

export interface NormalizedDirectTask {
  projectPath: string;
  title: string;
  details: string;
  kind: WorkItemKind;
  priority: number;
  brief?: Record<string, unknown>;
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new CouncilValidationError("任务标题不能为空。");
  if (trimmed.length > MAX_TITLE_CHARS) {
    throw new CouncilValidationError(`任务标题不能超过 ${String(MAX_TITLE_CHARS)} 字。`);
  }
  return trimmed;
}

function normalizeDetails(details: string | undefined): string {
  const value = (details ?? "").trim();
  if (value.length > MAX_WORK_ITEM_DETAILS_CHARS) {
    throw new CouncilValidationError(`任务说明不能超过 ${String(MAX_WORK_ITEM_DETAILS_CHARS)} 字。`);
  }
  return value;
}

/** 两个协议入口共用：HTTP/MCP 的 schema 只做形状校验，语义归一化在这里收口。 */
export function normalizeDirectTaskInput(input: DirectTaskInput): NormalizedDirectTask {
  const projectPath = normalizeProjectPath(input.projectPath);
  if (!projectPath) throw new CouncilValidationError("直接任务必须绑定项目路径。");
  const priority = input.priority ?? 0;
  if (!Number.isSafeInteger(priority)) throw new CouncilValidationError("任务优先级必须是整数。");
  if (input.brief !== undefined) {
    if (input.brief === null || typeof input.brief !== "object" || Array.isArray(input.brief)) {
      throw new CouncilValidationError("任务简报必须是 JSON 对象。");
    }
    if (JSON.stringify(input.brief).length > MAX_TASK_BRIEF_CHARS) {
      throw new CouncilValidationError(`任务简报序列化后不能超过 ${String(MAX_TASK_BRIEF_CHARS)} 字符。`);
    }
  }
  return {
    projectPath,
    title: normalizeTitle(input.title),
    details: normalizeDetails(input.details),
    kind: input.kind ?? "code",
    priority,
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
  };
}

/** 直接任务入口：不挂议题与决策，source=direct、origin=manual。 */
export function createDirectTask(
  database: CouncilDatabase,
  input: DirectTaskInput & { actorId: string },
): WorkItem {
  return database.createDirectTaskAsActor({ ...normalizeDirectTaskInput(input), actorId: input.actorId });
}

/** 议题入口：直接包议题拆解写入，归一化与去重沿用 WorkItemRepository 的既有语义，不改变旧行为。 */
export function createTopicTasks(
  database: CouncilDatabase,
  input: Parameters<CouncilDatabase["createWorkItemsAsActor"]>[0],
): WorkItem[] {
  return database.createWorkItemsAsActor(input);
}
