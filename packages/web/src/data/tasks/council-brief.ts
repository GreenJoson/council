/**
 * @input  依赖：types/assets.ts 的 council-brief v1 类型与 kind 枚举
 * @output 导出：BRIEF_LIMITS（与服务端 BRIEF_PROTOCOL_LIMITS 对齐的长度/数量上限）、
 *         validateCouncilBrief（逐项校验并返回问题列表）、parseCouncilBrief（合法时返回 CouncilBrief，否则 null）、
 *         BriefIssue（可直接交给 t(message, params) 的问题描述）
 * @pos    council-brief 在 Web 端的唯一校验点：任务详情据此决定结构化展示还是回退成键值，BriefEditor 提交前预检，
 *         mock 任务仓储据此模拟服务端拒绝。权威是服务端 mcp-server 的 pipelines/brief-protocol.ts（zod strict），
 *         这里逐项镜像其规则（字符串先 trim 再计长度、未知字段拒绝），避免前端放行、服务端拒绝
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  COUNCIL_BRIEF_KINDS,
  type CouncilBrief,
  type CouncilBriefKind,
} from "../../types/assets";

export interface BriefIssue {
  /** 中文文案键，展示时走 t(message, params)。 */
  message: string;
  params?: Record<string, string | number>;
}

/** 与服务端 BRIEF_PROTOCOL_LIMITS 一一对应；服务端改动时这里同步。 */
export const BRIEF_LIMITS = {
  maxDeliverables: 16,
  maxCountPerDeliverable: 16,
  maxReferences: 16,
  maxImageEdge: 8_192,
  maxShortText: 500,
  maxLongText: 4_000,
  maxListItems: 20,
  maxDeliverableIdLength: 64,
} as const;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "kind", "goal", "deliverables", "style", "acceptance", "nextStage"]);
const DELIVERABLE_KEYS = new Set(["id", "description", "size", "transparent", "count"]);
const STYLE_KEYS = new Set(["palette", "references", "constraints"]);
const NEXT_STAGE_KEYS = new Set(["kind", "notes"]);
const DELIVERABLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ASSET_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const SIZE_PATTERN = /^([1-9][0-9]{1,4})x([1-9][0-9]{1,4})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 服务端 shortText/longText：trim 后 1..max 字。 */
function isText(value: unknown, max: number): value is string {
  if (typeof value !== "string") return false;
  const length = value.trim().length;
  return length >= 1 && length <= max;
}

function isValidSize(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = SIZE_PATTERN.exec(value);
  return match !== null
    && Number(match[1]) <= BRIEF_LIMITS.maxImageEdge
    && Number(match[2]) <= BRIEF_LIMITS.maxImageEdge;
}

function reportUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  issues: BriefIssue[],
  issue: (field: string) => BriefIssue,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(key));
  }
}

/** 服务端 textList：每项 shortText，最多 maxListItems 项。 */
function validateTextList(value: unknown, field: string, issues: BriefIssue[]) {
  if (!Array.isArray(value) || value.length > BRIEF_LIMITS.maxListItems) {
    issues.push({ message: "{field} 必须是字符串数组，最多 {max} 项。", params: { field, max: BRIEF_LIMITS.maxListItems } });
    return;
  }
  value.forEach((entry, index) => {
    if (!isText(entry, BRIEF_LIMITS.maxShortText)) {
      issues.push({
        message: "{field} 第 {index} 项不能为空，且不超过 {max} 字。",
        params: { field, index: index + 1, max: BRIEF_LIMITS.maxShortText },
      });
    }
  });
}

function validateDeliverable(value: unknown, index: number, seenIds: Set<string>, issues: BriefIssue[]) {
  const position = index + 1;
  if (!isRecord(value)) {
    issues.push({ message: "交付物 {index} 必须是对象。", params: { index: position } });
    return;
  }
  reportUnknownKeys(value, DELIVERABLE_KEYS, issues, (field) => ({
    message: "交付物 {index} 含未知字段：{field}",
    params: { index: position, field },
  }));
  if (typeof value.id !== "string" || value.id.length === 0) {
    issues.push({ message: "交付物 {index} 缺少 id。", params: { index: position } });
  } else if (!DELIVERABLE_ID.test(value.id)) {
    issues.push({
      message: "交付物 {index} 的 id 只允许小写字母、数字与连字符，须以字母或数字开头，最长 {max} 位。",
      params: { index: position, max: BRIEF_LIMITS.maxDeliverableIdLength },
    });
  } else if (seenIds.has(value.id)) {
    issues.push({ message: "交付物 id 重复：{id}", params: { id: value.id } });
  } else {
    seenIds.add(value.id);
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    issues.push({ message: "交付物 {index} 缺少描述。", params: { index: position } });
  } else if (!isText(value.description, BRIEF_LIMITS.maxLongText)) {
    issues.push({ message: "交付物 {index} 的描述不能超过 {max} 字。", params: { index: position, max: BRIEF_LIMITS.maxLongText } });
  }
  if (value.size !== undefined && !isValidSize(value.size)) {
    issues.push({
      message: "交付物 {index} 的尺寸应形如 1024x1024，单边不超过 {max}。",
      params: { index: position, max: BRIEF_LIMITS.maxImageEdge },
    });
  }
  if (value.transparent !== undefined && typeof value.transparent !== "boolean") {
    issues.push({ message: "交付物 {index} 的透明背景只能是 true 或 false。", params: { index: position } });
  }
  if (value.count !== undefined && !(
    typeof value.count === "number" && Number.isInteger(value.count)
    && value.count >= 1 && value.count <= BRIEF_LIMITS.maxCountPerDeliverable
  )) {
    issues.push({
      message: "交付物 {index} 的数量必须是 1 到 {max} 的整数。",
      params: { index: position, max: BRIEF_LIMITS.maxCountPerDeliverable },
    });
  }
}

/** style 整体可选；出现时必须是对象，各字段也都可选。 */
function validateStyle(value: unknown, issues: BriefIssue[]) {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ message: "style 必须是对象。" });
    return;
  }
  reportUnknownKeys(value, STYLE_KEYS, issues, (field) => ({ message: "style 含未知字段：{field}", params: { field } }));
  if (value.palette !== undefined && !isText(value.palette, BRIEF_LIMITS.maxShortText)) {
    issues.push({ message: "style.palette 必须是 1 到 {max} 字的文本。", params: { max: BRIEF_LIMITS.maxShortText } });
  }
  if (value.references !== undefined && !(
    Array.isArray(value.references)
    && value.references.length <= BRIEF_LIMITS.maxReferences
    && value.references.every((entry) => typeof entry === "string" && ASSET_ID.test(entry))
  )) {
    issues.push({ message: "style.references 必须是资产 id 数组，最多 {max} 个。", params: { max: BRIEF_LIMITS.maxReferences } });
  }
  if (value.constraints !== undefined) validateTextList(value.constraints, "style.constraints", issues);
}

function validateNextStage(value: unknown, issues: BriefIssue[]) {
  if (value === undefined) return;
  const valid = isRecord(value)
    && Object.keys(value).every((key) => NEXT_STAGE_KEYS.has(key))
    && value.kind === "prototype"
    && isText(value.notes, BRIEF_LIMITS.maxLongText);
  if (!valid) {
    issues.push({
      message: "nextStage 只能是 kind 为 prototype、notes 为 1 到 {max} 字的对象。",
      params: { max: BRIEF_LIMITS.maxLongText },
    });
  }
}

export function validateCouncilBrief(value: unknown): { brief: CouncilBrief | null; issues: BriefIssue[] } {
  const issues: BriefIssue[] = [];
  if (!isRecord(value)) {
    return { brief: null, issues: [{ message: "简报必须是 JSON 对象。" }] };
  }
  reportUnknownKeys(value, TOP_LEVEL_KEYS, issues, (field) => ({ message: "简报含未知字段：{field}", params: { field } }));
  if (value.schemaVersion !== 1) {
    issues.push({ message: "schemaVersion 必须为 1。" });
  }
  if (!COUNCIL_BRIEF_KINDS.includes(value.kind as CouncilBriefKind)) {
    issues.push({ message: "简报类型不受支持。" });
  }
  if (typeof value.goal !== "string" || value.goal.trim().length === 0) {
    issues.push({ message: "目标不能为空。" });
  } else if (!isText(value.goal, BRIEF_LIMITS.maxShortText)) {
    issues.push({ message: "目标不能超过 {max} 字。", params: { max: BRIEF_LIMITS.maxShortText } });
  }
  if (!Array.isArray(value.deliverables) || value.deliverables.length === 0) {
    issues.push({ message: "至少需要一项交付物。" });
  } else if (value.deliverables.length > BRIEF_LIMITS.maxDeliverables) {
    issues.push({ message: "交付物不能超过 {max} 项。", params: { max: BRIEF_LIMITS.maxDeliverables } });
  } else {
    const seenIds = new Set<string>();
    value.deliverables.forEach((entry, index) => validateDeliverable(entry, index, seenIds, issues));
  }
  validateStyle(value.style, issues);
  // acceptance 必填，可为空数组。
  if (value.acceptance === undefined) {
    issues.push({ message: "缺少验收条目（可以为空数组）。" });
  } else {
    validateTextList(value.acceptance, "acceptance", issues);
  }
  validateNextStage(value.nextStage, issues);
  return { brief: issues.length === 0 ? value as unknown as CouncilBrief : null, issues };
}

export function parseCouncilBrief(value: unknown): CouncilBrief | null {
  return validateCouncilBrief(value).brief;
}
