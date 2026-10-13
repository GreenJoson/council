/**
 * @input  依赖：brief-protocol（CouncilBrief 解析与限制）、templates（模板/阶段 id 与模板要求）
 * @output 导出：council-pipeline 文档类型与严格解析 parsePipelineDocument（request.source 记录派活来源的议题/消息）、初始文档 createPipelineDocument、
 *         阶段读写 helper（stageOf/withStage/nextStageAfter）、模板校验 assertBriefMatchesTemplate（含交付物合计张数 ≤ 单次生图上限 PipelineBriefLimits）、
 *         brief 解析 parsePipelineBrief（deliverable id 先转小写再严格校验）、
 *         尾块提取 extractFencedBlock/extractCouncilBrief、council-review 解析 parseCouncilReview、
 *         修订 brief 生成 buildRevisionBrief（以原 brief 为基线只保留不合格与本轮缺少产物的交付物并带本轮改法，goal 开头声明本轮范围）、文档上限 PIPELINE_DOCUMENT_LIMITS（HTTP/MCP 入口共用），以及 PipelineProtocolError
 * @pos    流水线驱动状态的协议正本：纯函数，不起进程、不读写数据库；与 brief-protocol 同一严格度
 *         （未知字段拒绝、尾块取最后一个围栏、损坏即失败关闭）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { z } from "zod/v4";
import {
  BRIEF_PROTOCOL_LIMITS,
  CouncilProtocolError,
  parseCouncilBrief,
  type CouncilBrief,
} from "./brief-protocol.js";
import {
  PIPELINE_STAGE_IDS,
  PIPELINE_TEMPLATE_IDS,
  pipelineTemplate,
  type PipelineStageId,
  type PipelineTemplateId,
} from "./templates.js";

// ┌─────────────────────────────────────────────────────────────┐
// │ 常量与错误                                                  │
// └─────────────────────────────────────────────────────────────┘

export const PIPELINE_STAGE_STATUSES = [
  "pending",
  "running",
  "waiting_human",
  "completed",
  "failed",
  "skipped",
] as const;

export type PipelineStageStatus = (typeof PIPELINE_STAGE_STATUSES)[number];

export const PIPELINE_BRIEF_FENCE = "council-brief";
export const PIPELINE_REVIEW_FENCE = "council-review";

/** 文档协议上限；HTTP/MCP 入口的形状校验复用 request 相关上限，避免入口放行、写文档时才失败。 */
export const PIPELINE_DOCUMENT_LIMITS = {
  maxGoal: 2_000,
  maxConstraint: 500,
  maxConstraints: 20,
  maxReferences: 8,
  maxReviewItems: 64,
  maxText: 1_000,
  maxReviews: 32,
} as const;
const LIMITS = PIPELINE_DOCUMENT_LIMITS;

export class PipelineProtocolError extends Error {
  override readonly name = "PipelineProtocolError";

  constructor(
    readonly code: "pipeline_invalid" | "brief_invalid" | "review_invalid",
    message: string,
  ) {
    super(message);
  }
}

// ┌─────────────────────────────────────────────────────────────┐
// │ council-pipeline 文档                                       │
// └─────────────────────────────────────────────────────────────┘

const idText = z.string().trim().min(1).max(250);
const shortText = z.string().trim().min(1).max(LIMITS.maxText);
const isoText = z.string().min(1).max(64);

/** brief 字段按 brief-protocol 原样严格校验，文档里存的是解析后的副本。 */
const briefField = z.unknown().transform((value, context) => {
  try {
    return parseCouncilBrief(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "brief 无效" });
    return z.NEVER;
  }
});

const stageSchema = z.object({
  id: z.enum(PIPELINE_STAGE_IDS),
  status: z.enum(PIPELINE_STAGE_STATUSES),
  workItemId: idText.optional(),
  delegationId: idText.optional(),
  startedAt: isoText.optional(),
  endedAt: isoText.optional(),
  error: z.object({ code: z.string().min(1).max(64), message: shortText }).strict().optional(),
}).strict();

const reviewItemSchema = z.object({
  assetId: idText,
  deliverableId: z.string().min(1).max(64),
  ok: z.boolean(),
  issue: shortText.optional(),
  change: shortText.optional(),
}).strict();

const reviewRecordSchema = z.object({
  round: z.number().int().min(1),
  verdict: z.enum(["pass", "revise"]),
  items: z.array(reviewItemSchema).max(LIMITS.maxReviewItems),
  /** 本轮 brief 里没有任何产物的交付物 id（执行者跳过卡住的那张）；由驱动计算，不来自复盘者。 */
  missing: z.array(z.string().min(1).max(64)).max(LIMITS.maxReviewItems).optional(),
}).strict();

const documentSchema = z.object({
  schemaVersion: z.literal(1),
  template: z.enum(PIPELINE_TEMPLATE_IDS),
  status: z.literal("cancelled").optional(),
  request: z.object({
    goal: z.string().trim().min(1).max(LIMITS.maxGoal),
    constraints: z.array(z.string().trim().min(1).max(LIMITS.maxConstraint)).max(LIMITS.maxConstraints).optional(),
    referenceAssetIds: z.array(idText).max(LIMITS.maxReferences).optional(),
    /** 从讨论消息的派活尾块起的流水线：记下出处，同一条消息重复点按钮时返回既有流水线。 */
    source: z.object({ topicId: idText, messageId: idText }).strict().optional(),
  }).strict(),
  agents: z.object({
    brief: idText,
    image: idText,
    prototype: z.object({ executor: idText, supervisor: idText.optional() }).strict().optional(),
  }).strict(),
  stages: z.array(stageSchema).min(1).max(PIPELINE_STAGE_IDS.length),
  currentStageId: z.enum(PIPELINE_STAGE_IDS),
  draftBrief: briefField.optional(),
  brief: briefField.optional(),
  reviews: z.array(reviewRecordSchema).max(LIMITS.maxReviews),
  revisionCount: z.number().int().min(0),
  finalAssetIds: z.array(idText).max(BRIEF_PROTOCOL_LIMITS.maxManifestOutputs).optional(),
  /** 实现扩展：复盘达到修订上限等需要告知用户、但不是失败的说明。 */
  notice: shortText.optional(),
  updatedAt: isoText,
}).strict();

export type PipelineStage = z.infer<typeof stageSchema>;
export type PipelineReviewItem = z.infer<typeof reviewItemSchema>;
export type PipelineReviewRecord = z.infer<typeof reviewRecordSchema>;
export type PipelineDocument = z.infer<typeof documentSchema>;
export type PipelineAgents = PipelineDocument["agents"];
export type PipelineRequest = PipelineDocument["request"];

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "格式无效";
  const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
  return `${where}: ${issue.message}`;
}

export function parsePipelineDocument(value: unknown): PipelineDocument {
  const result = documentSchema.safeParse(value);
  if (!result.success) {
    throw new PipelineProtocolError("pipeline_invalid", `council-pipeline 无效：${firstIssue(result.error)}`);
  }
  const document = result.data;
  const expected = pipelineTemplate(document.template).stages;
  if (document.stages.map((stage) => stage.id).join(",") !== expected.join(",")) {
    throw new PipelineProtocolError("pipeline_invalid", "council-pipeline 无效：stages 与模板不一致");
  }
  if (!expected.includes(document.currentStageId)) {
    throw new PipelineProtocolError("pipeline_invalid", "council-pipeline 无效：currentStageId 不在模板阶段内");
  }
  return document;
}

export function createPipelineDocument(input: {
  template: PipelineTemplateId;
  request: PipelineRequest;
  agents: PipelineAgents;
  now: string;
}): PipelineDocument {
  const stages = pipelineTemplate(input.template).stages.map((id): PipelineStage => ({ id, status: "pending" }));
  return parsePipelineDocument({
    schemaVersion: 1,
    template: input.template,
    request: input.request,
    agents: input.agents,
    stages,
    currentStageId: stages[0]?.id ?? "brief",
    reviews: [],
    revisionCount: 0,
    updatedAt: input.now,
  });
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 阶段 helper（全部返回新对象，不原地修改）                    │
// └─────────────────────────────────────────────────────────────┘

export function stageOf(document: PipelineDocument, id: PipelineStageId): PipelineStage | undefined {
  return document.stages.find((stage) => stage.id === id);
}

export function currentStage(document: PipelineDocument): PipelineStage {
  const stage = stageOf(document, document.currentStageId);
  if (!stage) throw new PipelineProtocolError("pipeline_invalid", "council-pipeline 当前阶段缺失。");
  return stage;
}

/** 用 replace 整体替换阶段字段（未给出的可选字段被清掉），避免旧错误残留。 */
export function withStage(
  document: PipelineDocument,
  id: PipelineStageId,
  replace: Omit<PipelineStage, "id">,
  now: string,
): PipelineDocument {
  return {
    ...document,
    stages: document.stages.map((stage) => stage.id === id ? { id, ...replace } : stage),
    updatedAt: now,
  };
}

export function nextStageAfter(document: PipelineDocument, id: PipelineStageId): PipelineStageId | undefined {
  const stages = pipelineTemplate(document.template).stages;
  return stages[stages.indexOf(id) + 1];
}

export function isPipelineFinished(document: PipelineDocument): boolean {
  return document.status === "cancelled"
    || document.stages.every((stage) => stage.status === "completed" || stage.status === "skipped");
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 尾块提取与 brief 模板校验                                   │
// └─────────────────────────────────────────────────────────────┘

/** 与任务规划同一写法：取最后一个 ```<fence>``` 围栏的正文，没有则 undefined。 */
export function extractFencedBlock(content: string, fence: string): string | undefined {
  const pattern = new RegExp(`^\`\`\`${fence}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?^\`\`\`[ \\t]*$`, "gmu");
  let last: string | undefined;
  for (const match of content.matchAll(pattern)) {
    last = match[1];
  }
  return last;
}

/**
 * brief 的运行时上限：交付物 count 合计不得超过单次图像委派能入库的张数（COUNCIL_CODEX_IMAGE_MAX_OUTPUTS）。
 * 超出的产物会被生图侧丢弃、复盘必然打回，流水线只会在修订轮里空转，所以在 brief 阶段就拒绝。
 */
export interface PipelineBriefLimits {
  maxImageOutputs: number;
}

/** brief 交付物合计张数（count 缺省为 1）。 */
export function briefOutputCount(brief: CouncilBrief): number {
  return brief.deliverables.reduce((sum, item) => sum + (item.count ?? 1), 0);
}

/** 模板对 brief 的硬要求；人工确认与模型产出走同一套校验。 */
export function assertBriefMatchesTemplate(
  brief: CouncilBrief,
  template: PipelineTemplateId,
  limits?: PipelineBriefLimits,
): void {
  const spec = pipelineTemplate(template);
  if (brief.kind !== spec.briefKind) {
    throw new PipelineProtocolError("brief_invalid", `brief.kind 必须为 ${spec.briefKind}。`);
  }
  if (spec.requiresPrototype && brief.nextStage?.kind !== "prototype") {
    throw new PipelineProtocolError("brief_invalid", "该模板的 brief 必须包含 nextStage（kind=prototype）。");
  }
  const total = briefOutputCount(brief);
  if (limits && total > limits.maxImageOutputs) {
    throw new PipelineProtocolError(
      "brief_invalid",
      `交付物合计 ${String(total)} 张，超过单次生图上限 ${String(limits.maxImageOutputs)} 张`
        + "（COUNCIL_CODEX_IMAGE_MAX_OUTPUTS）；请减少交付物或 count，或拆成多条流水线。",
    );
  }
  if (template === "game-asset-pack") {
    if (total < 6 || brief.deliverables.some((item) => item.transparent !== true)) {
      throw new PipelineProtocolError("brief_invalid", "游戏素材包至少需要 6 张 sprite，且全部 transparent: true。");
    }
  }
}

/**
 * Agent 起草的 brief 常把 deliverable id 写成大写（如 `NP-034-coilback`），提示词已要求小写仍会出现。
 * 大小写不影响含义，校验前统一转小写，不为此让整个简报阶段失败；JSON 损坏等其它问题原样交给严格解析报错。
 */
function lowercaseDeliverableIds(value: unknown): unknown {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return value;
  const record = decoded as Record<string, unknown>;
  if (!Array.isArray(record.deliverables)) return value;
  return {
    ...record,
    deliverables: record.deliverables.map((item: unknown) => {
      if (!item || typeof item !== "object") return item;
      const deliverable = item as Record<string, unknown>;
      return typeof deliverable.id === "string" ? { ...deliverable, id: deliverable.id.toLowerCase() } : deliverable;
    }),
  };
}

/** 解析并校验 brief（对象或 JSON 字符串，deliverable id 先转小写）；协议错误统一转成 brief_invalid。 */
export function parsePipelineBrief(
  value: unknown,
  template: PipelineTemplateId,
  limits?: PipelineBriefLimits,
): CouncilBrief {
  let brief: CouncilBrief;
  try {
    brief = parseCouncilBrief(lowercaseDeliverableIds(value));
  } catch (error) {
    if (error instanceof CouncilProtocolError) throw new PipelineProtocolError("brief_invalid", error.message);
    throw error;
  }
  assertBriefMatchesTemplate(brief, template, limits);
  return brief;
}

export function extractCouncilBrief(
  content: string,
  template: PipelineTemplateId,
  limits?: PipelineBriefLimits,
): CouncilBrief {
  const block = extractFencedBlock(content, PIPELINE_BRIEF_FENCE);
  if (block === undefined) {
    throw new PipelineProtocolError("brief_invalid", "回复末尾缺少 ```council-brief``` 围栏 JSON。");
  }
  return parsePipelineBrief(block, template, limits);
}

// ┌─────────────────────────────────────────────────────────────┐
// │ council-review                                              │
// └─────────────────────────────────────────────────────────────┘

const reviewSchema = z.object({
  schemaVersion: z.literal(1),
  verdict: z.enum(["pass", "revise"]),
  items: z.array(reviewItemSchema).min(1).max(LIMITS.maxReviewItems),
}).strict();

export interface CouncilReview {
  verdict: "pass" | "revise";
  items: PipelineReviewItem[];
  /** 本轮没有产物的交付物 id：驱动按清单与复盘条目计算后补上，复盘者的尾块里没有这一项。 */
  missing?: readonly string[];
}

/**
 * 解析回复末尾的 council-review 尾块：assetId 必须是本轮给出的产物、deliverableId 必须在 brief 内；
 * revise 至少一项 ok=false 且带 change，否则无法生成修订任务，按无效处理。
 */
export function parseCouncilReview(
  content: string,
  options: { brief: CouncilBrief; assetIds: readonly string[] },
): CouncilReview {
  const block = extractFencedBlock(content, PIPELINE_REVIEW_FENCE);
  if (block === undefined) {
    throw new PipelineProtocolError("review_invalid", "回复末尾缺少 ```council-review``` 围栏 JSON。");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(block) as unknown;
  } catch {
    throw new PipelineProtocolError("review_invalid", "council-review 不是有效 JSON。");
  }
  const result = reviewSchema.safeParse(raw);
  if (!result.success) {
    throw new PipelineProtocolError("review_invalid", `council-review 无效：${firstIssue(result.error)}`);
  }
  const assetIds = new Set(options.assetIds);
  const deliverableIds = new Set(options.brief.deliverables.map((item) => item.id));
  for (const [index, item] of result.data.items.entries()) {
    if (!assetIds.has(item.assetId)) {
      throw new PipelineProtocolError("review_invalid", `council-review 无效：items.${String(index)}.assetId 不是本轮产物`);
    }
    if (!deliverableIds.has(item.deliverableId)) {
      throw new PipelineProtocolError("review_invalid", `council-review 无效：items.${String(index)}.deliverableId 不在 brief 中`);
    }
  }
  if (result.data.verdict === "revise" && !result.data.items.some((item) => !item.ok && item.change)) {
    throw new PipelineProtocolError("review_invalid", "council-review 无效：revise 至少需要一项 ok=false 且给出 change");
  }
  return { verdict: result.data.verdict, items: result.data.items };
}

/**
 * 修订子任务的 brief：只保留不合格与本轮缺少产物（review.missing）的交付物，change 追加进 style.constraints
 * （到 brief 协议上限即停止追加）；返回修订 brief 与要作为输入的原图资产 id（不超过委派输入上限 8 张，缺失项没有原图）。
 * 调用方应传确认后的原 brief 而不是上一轮修订简报，否则改法逐轮累加、goal 前缀嵌套。
 */
export function buildRevisionBrief(
  brief: CouncilBrief,
  review: CouncilReview,
): { brief: CouncilBrief; inputAssetIds: string[] } {
  const failed = review.items.filter((item) => !item.ok);
  const failedIds = new Set([...failed.map((item) => item.deliverableId), ...(review.missing ?? [])]);
  const deliverables = brief.deliverables.filter((item) => failedIds.has(item.id));
  const constraints = [...(brief.style?.constraints ?? [])];
  const changes = [
    ...failed.flatMap((item) => item.change ? [`[${item.deliverableId}] ${item.change}`] : []),
    ...(review.missing ?? []).map((id) => `[${id}] 上一轮没有产出，本轮补做`),
  ];
  for (const change of changes) {
    if (constraints.length >= BRIEF_PROTOCOL_LIMITS.maxListItems) break;
    const text = change.slice(0, BRIEF_PROTOCOL_LIMITS.maxShortText);
    if (!constraints.includes(text)) constraints.push(text);
  }
  // 真实 Codex 会按 goal 里描述的整套界面重做全部交付物，再把已通过的也写进清单；
  // goal 开头先声明本轮范围，交付物列表与清单校验才不会「答非所问」。
  const narrowed = deliverables.length > 0 && deliverables.length < brief.deliverables.length;
  const goal = narrowed
    ? `【修订】本轮只重做交付物 ${deliverables.map((item) => item.id).join("、")}；其余交付物已通过复盘，不要重新生成。原目标：${brief.goal}`
      .slice(0, BRIEF_PROTOCOL_LIMITS.maxShortText)
    : brief.goal;
  const revised = parseCouncilBrief({
    ...brief,
    goal,
    deliverables: deliverables.length > 0 ? deliverables : brief.deliverables,
    style: { ...(brief.style ?? {}), constraints },
  });
  const inputAssetIds = [...new Set(failed.map((item) => item.assetId))].slice(0, LIMITS.maxReferences);
  return { brief: revised, inputAssetIds };
}
