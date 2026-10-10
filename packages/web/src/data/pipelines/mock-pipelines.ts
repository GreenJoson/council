/**
 * @input  依赖：API 任务行类型、mock-data 的 Actor 快照、mock-tasks 的占位项目路径、types/pipelines 的文档类型
 * @output 导出：MockPipelineRecord、MOCK_PIPELINE_OUTPUT_ASSET_IDS、mockPipelineTitle、mockPipelineTask/mockPipelineChild 行构造器、
 *         mockPipelineDraftBrief、createMockPipelineFixtures()
 * @pos    流水线 mock 夹具：三条预置流水线覆盖「选 final 等人」「图像阶段失败可恢复」「已完成」三种形态；
 *         产物资产 id 复用 mock 资产库里已有的图片，缩略图与 Lightbox 能直接显示
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { ApiWorkItem } from "../api-types";
import { mockActorSnapshot } from "../mock-data";
import { MOCK_TASK_PROJECT_PATH } from "../tasks/mock-tasks";
import type { WorkItemKind } from "../../types/council";
import {
  PIPELINE_TEMPLATE_STAGES,
  type CouncilPipelineDocument,
  type PipelineStage,
  type PipelineTemplate,
} from "../../types/pipelines";

/** 内存中的一条流水线：父任务行 + 文档 + 子任务行 + 图像产物。 */
export interface MockPipelineRecord {
  task: ApiWorkItem;
  document: CouncilPipelineDocument;
  children: ApiWorkItem[];
  outputAssetIds: string[];
}

/** mock 资产库里已有的三张图（结算页空状态插画两版 + 图标），作为图像阶段的产物。 */
export const MOCK_PIPELINE_OUTPUT_ASSET_IDS = [
  "asset_mock_empty_light",
  "asset_mock_empty_dark",
  "asset_mock_empty_icon",
] as const;

const DEFAULT_AGENTS = { brief: "claude", image: "codex" } as const;

/** 模板 → council-brief kind，与契约一致。 */
const BRIEF_KIND: Record<PipelineTemplate, string> = {
  "app-mockup": "app-mockup",
  "game-asset-pack": "game-sprite",
  "concept-sheet": "concept-sheet",
};

/** 契约：父任务标题为「[模板名] goal」；mock 用模板 id 作模板名。 */
export function mockPipelineTitle(template: PipelineTemplate, goal: string): string {
  return `[${template}] ${goal}`;
}

export function mockPipelineTask(
  fields: Pick<ApiWorkItem, "id" | "title" | "details" | "status" | "version" | "createdAt" | "updatedAt">
    & { document: CouncilPipelineDocument },
): ApiWorkItem {
  const snapshot = mockActorSnapshot("human");
  const { document, ...rest } = fields;
  return {
    ...rest,
    kind: "pipeline",
    source: "direct",
    priority: 0,
    projectPath: MOCK_TASK_PROJECT_PATH,
    brief: document as unknown as Record<string, unknown>,
    sortOrder: 0,
    origin: "manual",
    createdByActorId: "human",
    createdBySnapshot: snapshot,
    updatedByActorId: "human",
    updatedBySnapshot: snapshot,
    ...(fields.status === "completed" ? { completedAt: fields.updatedAt } : {}),
  };
}

export function mockPipelineChild(
  parent: ApiWorkItem,
  fields: {
    id: string;
    kind: WorkItemKind;
    title: string;
    status: ApiWorkItem["status"];
    at: string;
    brief?: Record<string, unknown>;
  },
): ApiWorkItem {
  const snapshot = mockActorSnapshot("codex");
  return {
    id: fields.id,
    kind: fields.kind,
    source: "pipeline",
    priority: 0,
    projectPath: MOCK_TASK_PROJECT_PATH,
    parentId: parent.id,
    ...(fields.brief ? { brief: structuredClone(fields.brief) } : {}),
    title: fields.title,
    details: "",
    status: fields.status,
    sortOrder: 0,
    origin: "manual",
    version: 1,
    createdByActorId: "codex",
    createdBySnapshot: snapshot,
    updatedByActorId: "codex",
    updatedBySnapshot: snapshot,
    createdAt: fields.at,
    updatedAt: fields.at,
    ...(fields.status === "completed" ? { completedAt: fields.at } : {}),
  };
}

/** brief 阶段的 mock 产出：一份合法的 council-brief v1（与前端 validateCouncilBrief 规则一致）。 */
export function mockPipelineDraftBrief(
  template: PipelineTemplate,
  goal: string,
  constraints: readonly string[] = [],
  referenceAssetIds: readonly string[] = [],
): Record<string, unknown> {
  const deliverables = template === "game-asset-pack"
    ? [{ id: "sprite-set", description: "透明底道具 sprite", size: "256x256", transparent: true, count: 6 }]
    : [
        { id: "screen-light", description: "浅色主题主界面", size: "1024x1024" },
        { id: "screen-dark", description: "深色主题主界面", size: "1024x1024" },
        { id: "app-icon", description: "透明底应用图标", size: "256x256", transparent: true },
      ];
  return {
    schemaVersion: 1,
    kind: BRIEF_KIND[template],
    goal: goal.slice(0, 200),
    deliverables,
    style: {
      constraints: constraints.length > 0 ? [...constraints] : ["扁平风格", "不出现文字"],
      ...(referenceAssetIds.length > 0 ? { references: [...referenceAssetIds] } : {}),
    },
    acceptance: ["主色与设计 token 一致", "透明交付物背景透明"],
    ...(template === "app-mockup" ? { nextStage: { kind: "prototype", notes: "按选定视觉稿出可点击原型" } } : {}),
  };
}

function stagesOf(
  template: PipelineTemplate,
  overrides: Partial<Record<PipelineStage["id"], Partial<PipelineStage>>>,
): PipelineStage[] {
  return PIPELINE_TEMPLATE_STAGES[template].map((id) => ({ id, status: "pending", ...overrides[id] }));
}

function selectWaitingFixture(): MockPipelineRecord {
  const id = "work_item_pipeline_checkout_mockup";
  const goal = "结算页改版视觉稿";
  const brief = mockPipelineDraftBrief("app-mockup", goal, ["沿用品牌主色"], ["asset_mock_brand_palette"]);
  const document: CouncilPipelineDocument = {
    schemaVersion: 1,
    template: "app-mockup",
    request: { goal, constraints: ["沿用品牌主色"], referenceAssetIds: ["asset_mock_brand_palette"] },
    agents: { ...DEFAULT_AGENTS, prototype: { executor: "codex", supervisor: "claude" } },
    stages: stagesOf("app-mockup", {
      brief: { status: "completed", startedAt: "2026-10-09T02:00:00.000Z", endedAt: "2026-10-09T02:01:30.000Z" },
      image: {
        status: "completed",
        workItemId: `${id}_image_2`,
        delegationId: "delegation_mock_pipeline_image_2",
        startedAt: "2026-10-09T02:05:00.000Z",
        endedAt: "2026-10-09T02:09:00.000Z",
      },
      review: { status: "completed", startedAt: "2026-10-09T02:09:10.000Z", endedAt: "2026-10-09T02:10:00.000Z" },
      select: { status: "waiting_human", startedAt: "2026-10-09T02:10:00.000Z" },
    }),
    currentStageId: "select",
    draftBrief: brief,
    brief,
    reviews: [
      {
        round: 1,
        verdict: "revise",
        items: [{
          assetId: "asset_mock_empty_dark",
          deliverableId: "screen-dark",
          ok: false,
          issue: "深色版对比度不足",
          change: "提高正文与背景对比度",
        }],
      },
      { round: 2, verdict: "pass", items: [{ assetId: "asset_mock_empty_dark", deliverableId: "screen-dark", ok: true }] },
    ],
    revisionCount: 1,
    updatedAt: "2026-10-09T02:10:00.000Z",
  };
  const task = mockPipelineTask({
    id,
    title: mockPipelineTitle("app-mockup", goal),
    details: goal,
    status: "in_progress",
    version: 6,
    createdAt: "2026-10-09T02:00:00.000Z",
    updatedAt: document.updatedAt,
    document,
  });
  return {
    task,
    document,
    children: [
      mockPipelineChild(task, {
        id: `${id}_image_1`, kind: "image", title: "图像生成（第 1 轮）", status: "completed", at: "2026-10-09T02:07:00.000Z", brief,
      }),
      mockPipelineChild(task, {
        id: `${id}_image_2`, kind: "image", title: "图像修改（第 2 轮）", status: "completed", at: "2026-10-09T02:09:00.000Z", brief,
      }),
    ],
    outputAssetIds: [...MOCK_PIPELINE_OUTPUT_ASSET_IDS],
  };
}

function imageFailedFixture(): MockPipelineRecord {
  const id = "work_item_pipeline_member_concept";
  const goal = "会员权益页概念图";
  const brief = mockPipelineDraftBrief("concept-sheet", goal);
  const document: CouncilPipelineDocument = {
    schemaVersion: 1,
    template: "concept-sheet",
    request: { goal },
    agents: { ...DEFAULT_AGENTS },
    stages: stagesOf("concept-sheet", {
      brief: { status: "completed", startedAt: "2026-10-08T07:00:00.000Z", endedAt: "2026-10-08T07:01:00.000Z" },
      image: {
        status: "failed",
        workItemId: `${id}_image_1`,
        delegationId: "delegation_mock_pipeline_failed",
        startedAt: "2026-10-08T07:02:00.000Z",
        endedAt: "2026-10-08T07:06:00.000Z",
        error: { code: "outputs_missing", message: "图像 Agent 已结束，但没有交付任何图片。" },
      },
    }),
    currentStageId: "image",
    draftBrief: brief,
    brief,
    reviews: [],
    revisionCount: 0,
    updatedAt: "2026-10-08T07:06:00.000Z",
  };
  const task = mockPipelineTask({
    id,
    title: mockPipelineTitle("concept-sheet", goal),
    details: goal,
    status: "blocked",
    version: 4,
    createdAt: "2026-10-08T07:00:00.000Z",
    updatedAt: document.updatedAt,
    document,
  });
  return {
    task,
    document,
    children: [mockPipelineChild(task, {
      id: `${id}_image_1`, kind: "image", title: "图像生成（第 1 轮）", status: "blocked", at: "2026-10-08T07:06:00.000Z", brief,
    })],
    outputAssetIds: [],
  };
}

function completedFixture(): MockPipelineRecord {
  const id = "work_item_pipeline_pixel_items";
  const goal = "像素风道具图标包";
  const brief = mockPipelineDraftBrief("game-asset-pack", goal, ["16 色调色板"]);
  const document: CouncilPipelineDocument = {
    schemaVersion: 1,
    template: "game-asset-pack",
    request: { goal, constraints: ["16 色调色板"] },
    agents: { ...DEFAULT_AGENTS },
    stages: stagesOf("game-asset-pack", {
      brief: { status: "completed", startedAt: "2026-10-07T03:00:00.000Z", endedAt: "2026-10-07T03:01:00.000Z" },
      image: {
        status: "completed", workItemId: `${id}_image_1`, startedAt: "2026-10-07T03:02:00.000Z", endedAt: "2026-10-07T03:08:00.000Z",
      },
      review: { status: "completed", startedAt: "2026-10-07T03:08:10.000Z", endedAt: "2026-10-07T03:09:00.000Z" },
      select: { status: "completed", startedAt: "2026-10-07T03:09:00.000Z", endedAt: "2026-10-07T03:20:00.000Z" },
    }),
    currentStageId: "select",
    draftBrief: brief,
    brief,
    reviews: [{ round: 1, verdict: "pass", items: [{ assetId: "asset_mock_empty_icon", deliverableId: "sprite-set", ok: true }] }],
    revisionCount: 0,
    finalAssetIds: ["asset_mock_empty_icon"],
    updatedAt: "2026-10-07T03:20:00.000Z",
  };
  const task = mockPipelineTask({
    id,
    title: mockPipelineTitle("game-asset-pack", goal),
    details: goal,
    status: "completed",
    version: 7,
    createdAt: "2026-10-07T03:00:00.000Z",
    updatedAt: document.updatedAt,
    document,
  });
  return {
    task,
    document,
    children: [mockPipelineChild(task, {
      id: `${id}_image_1`, kind: "image", title: "图像生成（第 1 轮）", status: "completed", at: "2026-10-07T03:08:00.000Z", brief,
    })],
    outputAssetIds: ["asset_mock_empty_icon", "asset_mock_empty_light"],
  };
}

/** 每次返回深拷贝，刷新页面即重置。 */
export function createMockPipelineFixtures(): MockPipelineRecord[] {
  return structuredClone([selectWaitingFixture(), imageFailedFixture(), completedFixture()]);
}
