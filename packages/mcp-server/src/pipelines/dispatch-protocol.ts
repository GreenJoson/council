/**
 * @input  依赖：pipeline-document（尾块提取、brief 模板校验、文档上限与协议错误）、templates（模板 id）
 * @output 导出：派活尾块围栏名 PIPELINE_DISPATCH_FENCE、给讨论 Agent 的协议说明 DISPATCH_PROTOCOL_PROMPT、
 *         PipelineDispatch 类型与严格解析 extractPipelineDispatch（消息正文 → 模板 + 项目内参考图相对路径 + 经模板校验的 brief）
 * @pos    讨论消息「一键派活」的协议正本：讨论 Agent 只读，不能自己起流水线，只能把派活方案写成本尾块；
 *         人在消息卡上点「按此起流水线」后，服务端从已存消息重新解析本块再开工（不信任前端回传的 JSON）。
 *         纯函数，不读写文件与数据库；参考图路径的项目内校验与入库由资产导入负责
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { z } from "zod/v4";
import type { CouncilBrief } from "./brief-protocol.js";
import {
  extractFencedBlock,
  parsePipelineBrief,
  PIPELINE_DOCUMENT_LIMITS,
  PipelineProtocolError,
  type PipelineBriefLimits,
} from "./pipeline-document.js";
import { PIPELINE_TEMPLATE_IDS, type PipelineTemplateId } from "./templates.js";

export const PIPELINE_DISPATCH_FENCE = "council-dispatch";

/**
 * 讨论 Agent 的派活说明，拼进各讨论适配器的可信前缀。
 * 只在用户要求开工时附尾块：普通讨论、圆桌立场回复都不该出现派活卡片。
 */
export const DISPATCH_PROTOCOL_PROMPT = [
  "需要出图、改图或开下一轮美术时，你只读、不能自己开工，也不要让用户手工搬运 brief：",
  "在正文之后附派活尾块，用户在消息卡上点「按此起流水线」即直接出图（跳过重写 brief）。只在用户要求派活、开工或安排下一轮时附，平时不要附。",
  "```council-dispatch",
  '{"template":"concept-sheet","references":["项目内参考图的相对路径.png"],"brief":{"schemaVersion":1,"kind":"concept-sheet","goal":"本轮目标（≤500 字）","deliverables":[{"id":"np-034-front","description":"这张图画什么、构图与细节要求","size":"1024x1536","count":1}],"style":{"palette":"配色","constraints":["每条 ≤500 字"]},"acceptance":["可检查的验收标准"]}}',
  "```",
  "- template 与 brief.kind 对应：concept-sheet→concept-sheet（角色/场景/道具设定图）；game-asset-pack→game-sprite（交付物合计至少 6 张、全部 transparent:true）；app-mockup→app-mockup（必须带 nextStage {\"kind\":\"prototype\",\"notes\":\"…\"}）。",
  `- references 只填项目里真实存在的 png/jpg/webp 相对路径（至多 ${String(PIPELINE_DOCUMENT_LIMITS.maxReferences)} 张），系统会自动导入资产库；brief 里不要写 style.references。`,
  "- 严格 JSON、不加注释；deliverable id 只用小写字母、数字和连字符；交付物合计张数（count 之和）默认不超过 16。",
].join("\n");

const REFERENCE_PATH = /\.(?:png|jpe?g|webp)$/iu;

const dispatchSchema = z.object({
  template: z.enum(PIPELINE_TEMPLATE_IDS),
  references: z.array(
    z.string().trim().min(1).max(300).regex(REFERENCE_PATH, "references 只接受 png/jpg/webp 图片路径"),
  ).max(PIPELINE_DOCUMENT_LIMITS.maxReferences).optional(),
  brief: z.unknown(),
}).strict();

export interface PipelineDispatch {
  template: PipelineTemplateId;
  /** 项目内相对路径，按出现顺序去重；入库与越界校验交给资产导入。 */
  referencePaths: string[];
  /** 已按模板校验；style.references 只可能是 Agent 写的资产 id，导入的参考图由调用方合并。 */
  brief: CouncilBrief;
}

/** 取消息里最后一个 council-dispatch 围栏；没有、JSON 损坏或不合模板一律抛 PipelineProtocolError。 */
export function extractPipelineDispatch(content: string, limits?: PipelineBriefLimits): PipelineDispatch {
  const block = extractFencedBlock(content, PIPELINE_DISPATCH_FENCE);
  if (block === undefined) {
    throw new PipelineProtocolError("brief_invalid", "这条消息没有 ```council-dispatch``` 派活尾块。");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    throw new PipelineProtocolError("brief_invalid", "派活尾块不是合法 JSON。");
  }
  const parsed = dispatchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
    throw new PipelineProtocolError("brief_invalid", `派活尾块无效：${where}: ${issue?.message ?? "格式无效"}`);
  }
  const brief = parsePipelineBrief(parsed.data.brief, parsed.data.template, limits);
  return {
    template: parsed.data.template,
    referencePaths: [...new Set(parsed.data.references ?? [])],
    brief,
  };
}
