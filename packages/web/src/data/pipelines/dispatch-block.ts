/**
 * @input  依赖：types/pipelines 的模板枚举、tasks/council-brief 的 brief 校验
 * @output 导出：PipelineDispatchPreview、DispatchBlockExtraction 与 extractDispatchBlock（消息正文 → 去掉派活尾块的正文 + 卡片预览）
 * @pos    讨论消息「一键派活」在 Web 端的展示解析：只为消息卡挑出 council-dispatch 尾块、从正文里去掉原始 JSON，
 *         并给出够用的预检提示。真正执行时服务端（mcp-server pipelines/dispatch-protocol.ts）从已存消息严格重解析，
 *         这里放宽也不会放行无效方案；围栏匹配规则与服务端 extractFencedBlock 一致（行首围栏，取最后一个）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilBrief } from "../../types/assets";
import { PIPELINE_TEMPLATES, type PipelineTemplate } from "../../types/pipelines";
import { validateCouncilBrief } from "../tasks/council-brief";

export interface PipelineDispatchPreview {
  template: PipelineTemplate;
  referencePaths: string[];
  brief: CouncilBrief;
}

export interface DispatchBlockExtraction {
  /** 去掉所有派活尾块后的正文，交给 Markdown 渲染。 */
  body: string;
  /** 最后一个尾块解析成功时的预览。 */
  dispatch?: PipelineDispatchPreview;
  /** 尾块存在但解析不了：中文文案键，展示时走 t()。 */
  problem?: string;
}

const DISPATCH_BLOCK = /^```council-dispatch[ \t]*\r?\n([\s\S]*?)\r?\n?^```[ \t]*$/gmu;
/** 与服务端模板约束同源：模板决定 brief.kind。 */
const TEMPLATE_KIND: Record<PipelineTemplate, CouncilBrief["kind"]> = {
  "app-mockup": "app-mockup",
  "game-asset-pack": "game-sprite",
  "concept-sheet": "concept-sheet",
};

export function extractDispatchBlock(content: string): DispatchBlockExtraction | undefined {
  const matches = [...content.matchAll(DISPATCH_BLOCK)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const body = content.replace(DISPATCH_BLOCK, "").replace(/\n{3,}/gu, "\n\n").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1] ?? "") as unknown;
  } catch {
    return { body, problem: "派活方案不是合法 JSON，请让 Agent 重新给出。" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { body, problem: "派活方案格式不对，请让 Agent 重新给出。" };
  }
  const record = parsed as Record<string, unknown>;
  const template = PIPELINE_TEMPLATES.find((item) => item === record.template);
  if (!template) return { body, problem: "派活方案的模板无法识别，请让 Agent 重新给出。" };
  const references = record.references ?? [];
  if (!Array.isArray(references) || references.some((item) => typeof item !== "string")) {
    return { body, problem: "派活方案的参考图列表格式不对，请让 Agent 重新给出。" };
  }
  const brief = validateCouncilBrief(record.brief).brief;
  if (!brief) return { body, problem: "派活方案里的简报不完整，请让 Agent 重新给出。" };
  if (brief.kind !== TEMPLATE_KIND[template]) {
    return { body, problem: "派活方案的简报类型和模板对不上，请让 Agent 重新给出。" };
  }
  return {
    body,
    dispatch: { template, referencePaths: [...new Set(references as string[])], brief },
  };
}
