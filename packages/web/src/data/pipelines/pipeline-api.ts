/**
 * @input  依赖：task-api 的任务行解析（复用 parseApiWorkItem + mapWorkItem）、types/pipelines 的常量与类型
 * @output 导出：parseCouncilPipelineDocument、parsePipelineSummaries（{items}）、parsePipelineDetail（{task, document, children, outputAssetIds}）、
 *         parsePipelineCreated（POST / 的 201 {pipeline}）
 * @pos    流水线领域唯一协议校验入口；REST 返回的未知 JSON 都先经这里再进入 UI。
 *         已知字段严格校验（枚举越界、类型不符直接拒绝），未知字段忽略——后端可加字段而不打断前端
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { parseTask, parseTasks } from "../tasks/task-api";
import {
  PIPELINE_STAGE_IDS,
  PIPELINE_STAGE_STATUSES,
  PIPELINE_TEMPLATES,
  type CouncilPipelineDocument,
  type PipelineAgents,
  type PipelineDetail,
  type PipelineReview,
  type PipelineStage,
  type PipelineSummary,
} from "../../types/pipelines";
import type { WorkItemStatus } from "../../types/council";

const TASK_STATUSES: readonly WorkItemStatus[] = ["pending", "in_progress", "blocked", "completed"];

type JsonRecord = Record<string, unknown>;

function readRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as JsonRecord;
}

function readString(record: JsonRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} 必须是非空字符串`);
  }
  return value;
}

function readOptionalString(record: JsonRecord, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${path}.${key} 必须是字符串`);
  return value;
}

function readEnum<T extends string>(record: JsonRecord, key: string, allowed: readonly T[], path: string): T {
  const value = readString(record, key, path);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${path}.${key} 包含不支持的值`);
  }
  return value as T;
}

function readNonNegativeInteger(record: JsonRecord, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path}.${key} 必须是非负整数`);
  }
  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} 必须是字符串数组`);
  }
  return value as string[];
}

function readOptionalStringArray(record: JsonRecord, key: string, path: string): string[] | undefined {
  const value = record[key];
  return value === undefined || value === null ? undefined : readStringArray(value, `${path}.${key}`);
}

function readOptionalRecord(record: JsonRecord, key: string, path: string): JsonRecord | undefined {
  const value = record[key];
  return value === undefined || value === null ? undefined : readRecord(value, `${path}.${key}`);
}

function parseStage(value: unknown, index: number): PipelineStage {
  const path = `pipeline.stages[${String(index)}]`;
  const record = readRecord(value, path);
  const errorRecord = readOptionalRecord(record, "error", path);
  const workItemId = readOptionalString(record, "workItemId", path);
  const delegationId = readOptionalString(record, "delegationId", path);
  const startedAt = readOptionalString(record, "startedAt", path);
  const endedAt = readOptionalString(record, "endedAt", path);
  return {
    id: readEnum(record, "id", PIPELINE_STAGE_IDS, path),
    status: readEnum(record, "status", PIPELINE_STAGE_STATUSES, path),
    ...(workItemId ? { workItemId } : {}),
    ...(delegationId ? { delegationId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(errorRecord ? {
      error: {
        code: readString(errorRecord, "code", `${path}.error`),
        message: readOptionalString(errorRecord, "message", `${path}.error`) ?? "",
      },
    } : {}),
  };
}

function parseReview(value: unknown, index: number): PipelineReview {
  const path = `pipeline.reviews[${String(index)}]`;
  const record = readRecord(value, path);
  const verdict = readEnum(record, "verdict", ["pass", "revise"] as const, path);
  if (!Array.isArray(record.items)) throw new Error(`${path}.items 必须是数组`);
  const missing = readOptionalStringArray(record, "missing", path);
  return {
    round: readNonNegativeInteger(record, "round", path),
    verdict,
    ...(missing && missing.length > 0 ? { missing } : {}),
    items: record.items.map((raw, at) => {
      const itemPath = `${path}.items[${String(at)}]`;
      const item = readRecord(raw, itemPath);
      if (typeof item.ok !== "boolean") throw new Error(`${itemPath}.ok 必须是布尔值`);
      const issue = readOptionalString(item, "issue", itemPath);
      const change = readOptionalString(item, "change", itemPath);
      return {
        assetId: readString(item, "assetId", itemPath),
        deliverableId: readString(item, "deliverableId", itemPath),
        ok: item.ok,
        ...(issue ? { issue } : {}),
        ...(change ? { change } : {}),
      };
    }),
  };
}

function parseAgents(value: unknown): PipelineAgents {
  const record = readRecord(value, "pipeline.agents");
  const prototype = readOptionalRecord(record, "prototype", "pipeline.agents");
  const supervisor = prototype ? readOptionalString(prototype, "supervisor", "pipeline.agents.prototype") : undefined;
  return {
    brief: readString(record, "brief", "pipeline.agents"),
    image: readString(record, "image", "pipeline.agents"),
    ...(prototype ? {
      prototype: {
        executor: readString(prototype, "executor", "pipeline.agents.prototype"),
        ...(supervisor ? { supervisor } : {}),
      },
    } : {}),
  };
}

export function parseCouncilPipelineDocument(value: unknown): CouncilPipelineDocument {
  const record = readRecord(value, "pipeline");
  if (record.schemaVersion !== 1) throw new Error("pipeline.schemaVersion 必须是 1");
  const request = readRecord(record.request, "pipeline.request");
  const constraints = readOptionalStringArray(request, "constraints", "pipeline.request");
  const referenceAssetIds = readOptionalStringArray(request, "referenceAssetIds", "pipeline.request");
  if (!Array.isArray(record.stages) || record.stages.length === 0) throw new Error("pipeline.stages 必须是非空数组");
  if (!Array.isArray(record.reviews)) throw new Error("pipeline.reviews 必须是数组");
  const stages = record.stages.map(parseStage);
  const currentStageId = readEnum(record, "currentStageId", PIPELINE_STAGE_IDS, "pipeline");
  if (!stages.some((stage) => stage.id === currentStageId)) {
    throw new Error("pipeline.currentStageId 不在阶段列表中");
  }
  const draftBrief = readOptionalRecord(record, "draftBrief", "pipeline");
  const brief = readOptionalRecord(record, "brief", "pipeline");
  const finalAssetIds = readOptionalStringArray(record, "finalAssetIds", "pipeline");
  return {
    schemaVersion: 1,
    template: readEnum(record, "template", PIPELINE_TEMPLATES, "pipeline"),
    request: {
      goal: readString(request, "goal", "pipeline.request"),
      ...(constraints ? { constraints } : {}),
      ...(referenceAssetIds ? { referenceAssetIds } : {}),
    },
    agents: parseAgents(record.agents),
    stages,
    currentStageId,
    ...(draftBrief ? { draftBrief } : {}),
    ...(brief ? { brief } : {}),
    reviews: record.reviews.map(parseReview),
    revisionCount: readNonNegativeInteger(record, "revisionCount", "pipeline"),
    ...(finalAssetIds ? { finalAssetIds } : {}),
    ...(record.status === "cancelled" ? { status: "cancelled" as const } : {}),
    updatedAt: readString(record, "updatedAt", "pipeline"),
  };
}

function parseSummary(value: unknown, index: number): PipelineSummary {
  const path = `pipelines.items[${String(index)}]`;
  const record = readRecord(value, path);
  const currentStageStatus = readEnum(record, "currentStageStatus", PIPELINE_STAGE_STATUSES, path);
  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`${path}.version 必须是正整数`);
  }
  return {
    id: readString(record, "id", path),
    title: readString(record, "title", path),
    template: readEnum(record, "template", PIPELINE_TEMPLATES, path),
    goal: readString(record, "goal", path),
    currentStageId: readEnum(record, "currentStageId", PIPELINE_STAGE_IDS, path),
    currentStageStatus,
    taskStatus: readEnum(record, "taskStatus", TASK_STATUSES, path),
    // 后端约定：取消时把当前阶段置 skipped（error.code=cancelled），摘要里不再单列取消标记。
    cancelled: record.cancelled === true || currentStageStatus === "skipped",
    updatedAt: readString(record, "updatedAt", path),
    version,
  };
}

export function parsePipelineSummaries(value: unknown): PipelineSummary[] {
  const record = readRecord(value, "pipelines");
  if (!Array.isArray(record.items)) throw new Error("pipelines.items 必须是数组");
  return record.items.map(parseSummary);
}

export function parsePipelineDetail(value: unknown): PipelineDetail {
  const record = readRecord(value, "pipeline detail");
  const task = parseTask(record.task);
  if (task.kind !== "pipeline") throw new Error("pipeline detail 的父任务必须是 kind=pipeline");
  const children = parseTasks(record.children);
  if (children.some((child) => child.parentId !== task.id)) {
    throw new Error("pipeline detail 的子任务不属于该流水线");
  }
  return {
    task,
    document: parseCouncilPipelineDocument(record.document),
    children,
    outputAssetIds: readStringArray(record.outputAssetIds, "pipeline detail.outputAssetIds"),
  };
}

/** POST / 返回 201 { pipeline: PipelineDetail }；也接受直接返回详情，避免包装层差异卡住创建。 */
export function parsePipelineCreated(value: unknown): PipelineDetail {
  const record = readRecord(value, "pipeline created");
  return parsePipelineDetail(record.pipeline ?? record);
}
