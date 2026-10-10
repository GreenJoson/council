/**
 * @input  依赖：types/assets.ts 的 council-brief 类型、data/tasks/council-brief 的校验
 * @output 导出：BriefDraft（表单/JSON 双模式草稿）、createBriefDraft、briefDraftToJson、briefDraftFromJson、resolveBriefDraft
 * @pos    BriefEditor 的纯数据层：表单字段与 council-brief 对象互转，提交前统一走 validateCouncilBrief；
 *         表单不暴露的字段（style.references、nextStage）原样保留，避免编辑时丢失；
 *         没有任何风格项时不输出 style（服务端 style 为可选对象）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { validateCouncilBrief, type BriefIssue } from "../../data/tasks/council-brief";
import type { CouncilBrief, CouncilBriefKind } from "../../types/assets";

export interface BriefDeliverableDraft {
  id: string;
  description: string;
  size: string;
  transparent: boolean;
  /** 输入框原文；空串表示不填，非法值交给校验报错。 */
  count: string;
}

export interface BriefFormDraft {
  kind: CouncilBriefKind;
  goal: string;
  deliverables: BriefDeliverableDraft[];
  /** 每行一条。 */
  constraints: string;
  /** 每行一条。 */
  acceptance: string;
  /** 配色描述，单个文本；空串表示不填。 */
  palette: string;
  references?: string[];
  nextStage?: CouncilBrief["nextStage"];
}

export interface BriefDraft {
  mode: "form" | "json";
  form: BriefFormDraft;
  json: string;
}

export function emptyDeliverable(index: number): BriefDeliverableDraft {
  return { id: `item-${String(index + 1)}`, description: "", size: "1024x1024", transparent: false, count: "" };
}

function splitLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function briefToForm(brief: CouncilBrief): BriefFormDraft {
  return {
    kind: brief.kind,
    goal: brief.goal,
    deliverables: brief.deliverables.map((entry) => ({
      id: entry.id,
      description: entry.description,
      size: entry.size ?? "",
      transparent: entry.transparent ?? false,
      count: entry.count === undefined ? "" : String(entry.count),
    })),
    constraints: (brief.style?.constraints ?? []).join("\n"),
    acceptance: brief.acceptance.join("\n"),
    palette: brief.style?.palette ?? "",
    ...(brief.style?.references ? { references: brief.style.references } : {}),
    ...(brief.nextStage ? { nextStage: brief.nextStage } : {}),
  };
}

/** 生成提交对象：可选字段留空即省略；count 非数字时保留 NaN 让校验报出具体条目。 */
function formToBrief(form: BriefFormDraft): Record<string, unknown> {
  const constraints = splitLines(form.constraints);
  const palette = form.palette.trim();
  const style = {
    ...(palette ? { palette } : {}),
    ...(form.references?.length ? { references: form.references } : {}),
    ...(constraints.length ? { constraints } : {}),
  };
  return {
    schemaVersion: 1,
    kind: form.kind,
    goal: form.goal.trim(),
    deliverables: form.deliverables.map((entry) => ({
      id: entry.id.trim(),
      description: entry.description.trim(),
      ...(entry.size.trim() ? { size: entry.size.trim() } : {}),
      ...(entry.transparent ? { transparent: true } : {}),
      ...(entry.count.trim() ? { count: Number(entry.count.trim()) } : {}),
    })),
    ...(Object.keys(style).length > 0 ? { style } : {}),
    acceptance: splitLines(form.acceptance),
    ...(form.nextStage ? { nextStage: form.nextStage } : {}),
  };
}

export function createBriefDraft(brief?: CouncilBrief | null): BriefDraft {
  const form: BriefFormDraft = brief ? briefToForm(brief) : {
    kind: "custom",
    goal: "",
    deliverables: [emptyDeliverable(0)],
    constraints: "",
    acceptance: "",
    palette: "",
  };
  return { mode: "form", form, json: JSON.stringify(formToBrief(form), null, 2) };
}

/** 表单 → JSON：总能成功。 */
export function briefDraftToJson(draft: BriefDraft): BriefDraft {
  return { ...draft, mode: "json", json: JSON.stringify(formToBrief(draft.form), null, 2) };
}

/** JSON → 表单：只有 JSON 是合法 council-brief 时才切换，否则返回问题列表、留在 JSON 模式。 */
export function briefDraftFromJson(draft: BriefDraft): { draft: BriefDraft; issues: BriefIssue[] } {
  const parsed = parseJson(draft.json);
  if ("issue" in parsed) return { draft, issues: [parsed.issue] };
  const { brief, issues } = validateCouncilBrief(parsed.value);
  if (!brief) return { draft, issues };
  return { draft: { ...draft, mode: "form", form: briefToForm(brief) }, issues: [] };
}

function parseJson(text: string): { value: unknown } | { issue: BriefIssue } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (reason: unknown) {
    return { issue: { message: "JSON 无法解析：{message}", params: { message: reason instanceof Error ? reason.message : String(reason) } } };
  }
}

/** 提交前统一出口：合法时给出可直接发给服务端的对象。 */
export function resolveBriefDraft(draft: BriefDraft): { brief: CouncilBrief | null; issues: BriefIssue[] } {
  if (draft.mode === "json") {
    const parsed = parseJson(draft.json);
    if ("issue" in parsed) return { brief: null, issues: [parsed.issue] };
    return validateCouncilBrief(parsed.value);
  }
  return validateCouncilBrief(formToBrief(draft.form));
}
