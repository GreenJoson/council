/**
 * @input  依赖：types/assets.ts 的 council-brief v1 类型与 kind 枚举
 * @output 导出：validateCouncilBrief（逐项校验并返回问题列表）、parseCouncilBrief（合法时返回 CouncilBrief，否则 null）、
 *         BriefIssue（可直接交给 t(message, params) 的问题描述）
 * @pos    council-brief 在 Web 端的唯一校验点：任务详情据此决定结构化展示还是回退成键值，BriefEditor 提交前预检，
 *         mock 任务仓储据此模拟服务端拒绝。服务端 brief-protocol 才是权威，这里只做「提交前先拦住明显错误」
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  COUNCIL_BRIEF_KINDS,
  type CouncilBrief,
  type CouncilBriefDeliverable,
  type CouncilBriefKind,
  type CouncilBriefStyle,
} from "../../types/assets";

export interface BriefIssue {
  /** 中文文案键，展示时走 t(message, params)。 */
  message: string;
  params?: Record<string, string | number>;
}

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "kind", "goal", "deliverables", "style", "acceptance", "nextStage"]);
const DELIVERABLE_KEYS = new Set(["id", "description", "size", "transparent", "count"]);
const STYLE_KEYS = new Set(["palette", "references", "constraints"]);
const SIZE_PATTERN = /^\d{2,5}x\d{2,5}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateDeliverable(
  value: unknown,
  index: number,
  seenIds: Set<string>,
  issues: BriefIssue[],
): CouncilBriefDeliverable | null {
  const position = index + 1;
  if (!isRecord(value)) {
    issues.push({ message: "交付物 {index} 必须是对象。", params: { index: position } });
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!DELIVERABLE_KEYS.has(key)) {
      issues.push({ message: "交付物 {index} 含未知字段：{field}", params: { index: position, field: key } });
    }
  }
  const before = issues.length;
  if (!nonEmpty(value.id)) {
    issues.push({ message: "交付物 {index} 缺少 id。", params: { index: position } });
  } else if (seenIds.has(value.id)) {
    issues.push({ message: "交付物 id 重复：{id}", params: { id: value.id } });
  } else {
    seenIds.add(value.id);
  }
  if (!nonEmpty(value.description)) {
    issues.push({ message: "交付物 {index} 缺少描述。", params: { index: position } });
  }
  if (value.size !== undefined && !(typeof value.size === "string" && SIZE_PATTERN.test(value.size))) {
    issues.push({ message: "交付物 {index} 的尺寸应形如 1024x1024。", params: { index: position } });
  }
  if (value.transparent !== undefined && typeof value.transparent !== "boolean") {
    issues.push({ message: "交付物 {index} 的透明背景只能是 true 或 false。", params: { index: position } });
  }
  if (value.count !== undefined && !(Number.isSafeInteger(value.count) && (value.count as number) >= 1)) {
    issues.push({ message: "交付物 {index} 的数量必须是正整数。", params: { index: position } });
  }
  return issues.length === before ? value as unknown as CouncilBriefDeliverable : null;
}

function validateStyle(value: unknown, issues: BriefIssue[]): CouncilBriefStyle | null {
  if (!isRecord(value)) {
    issues.push({ message: "style 必须是对象（可以为空对象）。" });
    return null;
  }
  const before = issues.length;
  for (const [key, entry] of Object.entries(value)) {
    if (!STYLE_KEYS.has(key)) {
      issues.push({ message: "style 含未知字段：{field}", params: { field: key } });
    } else if (!isStringArray(entry)) {
      issues.push({ message: "style.{field} 必须是字符串数组。", params: { field: key } });
    }
  }
  return issues.length === before ? value as CouncilBriefStyle : null;
}

export function validateCouncilBrief(value: unknown): { brief: CouncilBrief | null; issues: BriefIssue[] } {
  const issues: BriefIssue[] = [];
  if (!isRecord(value)) {
    return { brief: null, issues: [{ message: "简报必须是 JSON 对象。" }] };
  }
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      issues.push({ message: "简报含未知字段：{field}", params: { field: key } });
    }
  }
  if (value.schemaVersion !== 1) {
    issues.push({ message: "schemaVersion 必须为 1。" });
  }
  if (!COUNCIL_BRIEF_KINDS.includes(value.kind as CouncilBriefKind)) {
    issues.push({ message: "简报类型不受支持。" });
  }
  if (!nonEmpty(value.goal)) {
    issues.push({ message: "目标不能为空。" });
  }
  if (!Array.isArray(value.deliverables) || value.deliverables.length === 0) {
    issues.push({ message: "至少需要一项交付物。" });
  } else {
    const seenIds = new Set<string>();
    value.deliverables.forEach((entry, index) => validateDeliverable(entry, index, seenIds, issues));
  }
  validateStyle(value.style, issues);
  if (!isStringArray(value.acceptance)) {
    issues.push({ message: "验收条目必须是字符串数组。" });
  }
  if (value.nextStage !== undefined) {
    const next = value.nextStage;
    if (!isRecord(next) || next.kind !== "prototype" || typeof next.notes !== "string"
      || Object.keys(next).some((key) => key !== "kind" && key !== "notes")) {
      issues.push({ message: "nextStage 只能是 kind 为 prototype 且带 notes 的对象。" });
    }
  }
  return { brief: issues.length === 0 ? value as unknown as CouncilBrief : null, issues };
}

export function parseCouncilBrief(value: unknown): CouncilBrief | null {
  return validateCouncilBrief(value).brief;
}
