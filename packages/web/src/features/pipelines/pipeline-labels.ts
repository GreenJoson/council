/**
 * @input  依赖：types/pipelines 的模板/阶段/阶段状态联合类型与列表项
 * @output 导出：TEMPLATE_LABELS、TEMPLATE_HINTS、STAGE_LABELS、STAGE_STATUS_LABELS 中文文案表（同时作 i18n 键）、
 *         PipelineGroup 分组与 pipelineGroupOf()、PIPELINE_GROUP_ORDER、PIPELINE_GROUP_LABELS、formatPipelineTime()
 * @pos    流水线视图内部共享的展示常量与纯函数；分组以「已取消 / 父任务完成 / 末阶段完成」为已完成，
 *         因为 app-mockup 的原型子任务要等人验收，父任务派生状态不会自动到 completed；新增文案时同步 i18n/catalog.en.ts 的「P3：流水线」段
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  PIPELINE_TEMPLATE_STAGES,
  type PipelineStageId,
  type PipelineStageStatus,
  type PipelineSummary,
  type PipelineTemplate,
} from "../../types/pipelines";

export const TEMPLATE_LABELS: Record<PipelineTemplate, string> = {
  "app-mockup": "应用视觉稿",
  "game-asset-pack": "游戏素材包",
  "concept-sheet": "概念设定图",
};

export const TEMPLATE_HINTS: Record<PipelineTemplate, string> = {
  "app-mockup": "简报 → 出图 → 复盘 → 选定 → 可点击原型",
  "game-asset-pack": "简报 → 至少 6 张透明 sprite → 复盘 → 选定",
  "concept-sheet": "简报 → 出图 → 复盘 → 选定",
};

export const STAGE_LABELS: Record<PipelineStageId, string> = {
  brief: "简报",
  image: "出图",
  review: "复盘",
  select: "选定",
  prototype: "原型",
};

export const STAGE_STATUS_LABELS: Record<PipelineStageStatus, string> = {
  pending: "未开始",
  running: "进行中",
  waiting_human: "等待处理",
  completed: "已完成",
  failed: "失败",
  skipped: "已取消",
};

export type PipelineGroup = "waiting" | "running" | "failed" | "done";

/** 分组顺序：先看等我处理的，再看在跑和失败的，已结束垫底。 */
export const PIPELINE_GROUP_ORDER: readonly PipelineGroup[] = ["waiting", "running", "failed", "done"];

export const PIPELINE_GROUP_LABELS: Record<PipelineGroup, string> = {
  waiting: "等待我处理",
  running: "进行中",
  failed: "失败",
  done: "已完成",
};

/** 取消的流水线与完成的一起归入「已完成」，靠阶段徽标区分。 */
export function pipelineGroupOf(summary: PipelineSummary): PipelineGroup {
  if (summary.cancelled || summary.taskStatus === "completed") return "done";
  // 末阶段完成即流水线走完：app-mockup 的原型子任务在委派通过后仍等人验收（任务页），
  // 父任务按子任务派生会停在 in_progress，不能只看 taskStatus。
  const stages = PIPELINE_TEMPLATE_STAGES[summary.template];
  if (summary.currentStageId === stages[stages.length - 1] && summary.currentStageStatus === "completed") return "done";
  if (summary.currentStageStatus === "waiting_human") return "waiting";
  if (summary.currentStageStatus === "failed") return "failed";
  return "running";
}

export function formatPipelineTime(value: string | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}
