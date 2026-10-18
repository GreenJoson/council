/**
 * @input  依赖：council.ts 的任务行快照 CouncilWorkItem 与 WorkItemStatus
 * @output 导出：流水线模板/阶段/阶段状态常量与联合类型、PipelineStage、PipelineReview（含本轮缺少产物的交付物 missing）、PipelineDemo、CouncilPipelineDocument（schemaVersion 1，可选 demo 为非 Git 项目原型导出的 Demo 位置）、
 *         PipelineSummary（列表项）、PipelineListResult（列表读结果）、PipelineDetail（详情）、PipelineDispatchResult（从讨论消息派活的结果）、
 *         CreatePipelineInput（新建入参）
 * @pos    P3 流水线（/api/v1/pipelines）在 Web 端的稳定领域模型；字段与 docs/council-v2-refactor-plan.md
 *         「P3 落地契约」的 council-pipeline 文档一一对应。流水线本体 = kind=pipeline 的父任务，复用 CouncilWorkItem
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilWorkItem, WorkItemStatus } from "./council";

export const PIPELINE_TEMPLATES = ["app-mockup", "game-asset-pack", "concept-sheet"] as const;
export type PipelineTemplate = (typeof PIPELINE_TEMPLATES)[number];

export const PIPELINE_STAGE_IDS = ["brief", "image", "review", "select", "prototype"] as const;
export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

export const PIPELINE_STAGE_STATUSES = [
  "pending",
  "running",
  "waiting_human",
  "completed",
  "failed",
  "skipped",
] as const;
export type PipelineStageStatus = (typeof PIPELINE_STAGE_STATUSES)[number];

/** 各模板的阶段顺序：只有 app-mockup 带 prototype。 */
export const PIPELINE_TEMPLATE_STAGES: Record<PipelineTemplate, readonly PipelineStageId[]> = {
  "app-mockup": ["brief", "image", "review", "select", "prototype"],
  "game-asset-pack": ["brief", "image", "review", "select"],
  "concept-sheet": ["brief", "image", "review", "select"],
};

export interface PipelineStageError {
  code: string;
  message: string;
}

export interface PipelineStage {
  id: PipelineStageId;
  status: PipelineStageStatus;
  /** 需要 Agent 执行的阶段（image / prototype）对应的子任务。 */
  workItemId?: string;
  delegationId?: string;
  startedAt?: string;
  endedAt?: string;
  error?: PipelineStageError;
}

export interface PipelineReviewItem {
  assetId: string;
  deliverableId: string;
  ok: boolean;
  issue?: string;
  change?: string;
}

export interface PipelineReview {
  round: number;
  verdict: "pass" | "revise";
  items: PipelineReviewItem[];
  /** 本轮 brief 里没有任何产物的交付物 id（执行者跳过了卡住的生图）；有它时结论必为 revise。 */
  missing?: string[];
}

export interface PipelineAgents {
  brief: string;
  image: string;
  prototype?: { executor: string; supervisor?: string };
}

export interface PipelineRequest {
  goal: string;
  constraints?: string[];
  referenceAssetIds?: string[];
}

export interface PipelineDemo {
  path: string;
  fileCount: number;
}

export interface CouncilPipelineDocument {
  schemaVersion: 1;
  template: PipelineTemplate;
  request: PipelineRequest;
  agents: PipelineAgents;
  stages: PipelineStage[];
  currentStageId: PipelineStageId;
  /** brief 阶段产出、等人确认的 council-brief；前端编辑时再走 validateCouncilBrief。 */
  draftBrief?: Record<string, unknown>;
  /** 人确认后的 council-brief 副本。 */
  brief?: Record<string, unknown>;
  reviews: PipelineReview[];
  revisionCount: number;
  finalAssetIds?: string[];
  /** 非 Git 项目的原型通过后导出的静态 Demo：path 相对项目根（如 council-demos/xxx），入口是其中的 index.html。 */
  demo?: PipelineDemo;
  /** 取消后文档的标记；契约只写「置 cancelled」，具体字段由后端决定，前端只认这一处。 */
  status?: "cancelled";
  updatedAt: string;
}

/** 列表项：父任务 + 文档的轻量投影。 */
export interface PipelineSummary {
  id: string;
  title: string;
  template: PipelineTemplate;
  goal: string;
  currentStageId: PipelineStageId;
  currentStageStatus: PipelineStageStatus;
  /** 父任务状态（由子任务派生）。 */
  taskStatus: WorkItemStatus;
  cancelled: boolean;
  updatedAt: string;
  version: number;
}

export interface PipelineDetail {
  task: CouncilWorkItem;
  document: CouncilPipelineDocument;
  children: CouncilWorkItem[];
  /** 本流水线图像子任务的 output 资产，select 阶段的候选。 */
  outputAssetIds: string[];
  /** 桌面模式本地服务离线时的诚实提示；有它时其余字段不可信，仅用于占位。 */
  limitation?: string;
}

/** 从讨论消息派活：created=false 表示这条消息已经起过（未取消的）流水线，返回的是既有那条。 */
export interface PipelineDispatchResult {
  pipeline: PipelineDetail;
  created: boolean;
}

/** 列表读结果：桌面模式本地服务离线时 items 为空并带 limitation 诚实提示。 */
export interface PipelineListResult {
  items: PipelineSummary[];
  limitation?: string;
}

/** 项目路径由仓储实现持有，UI 不传；agents 缺省走服务端默认。 */
export interface CreatePipelineInput {
  template: PipelineTemplate;
  goal: string;
  constraints?: string[];
  referenceAssetIds?: string[];
  agents?: Partial<PipelineAgents>;
}
