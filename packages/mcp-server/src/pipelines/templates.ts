/**
 * @input  依赖：brief-protocol 的 CouncilBriefKind
 * @output 导出：流水线模板 id/阶段 id 常量、PipelineTemplate 类型、PIPELINE_TEMPLATES 与 pipelineTemplate(id)
 * @pos    P3 流水线模板正本：只描述阶段序列与 brief 生成要求（kind、nextStage、最少交付物），
 *         不起进程、不读写数据库；驱动器与服务按这里的阶段序列推进
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilBriefKind } from "./brief-protocol.js";

export const PIPELINE_TEMPLATE_IDS = ["app-mockup", "game-asset-pack", "concept-sheet"] as const;
export const PIPELINE_STAGE_IDS = ["brief", "image", "review", "select", "prototype"] as const;

export type PipelineTemplateId = (typeof PIPELINE_TEMPLATE_IDS)[number];
export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

export interface PipelineTemplate {
  id: PipelineTemplateId;
  /** 父任务标题前缀 `[name] goal` 与界面展示用。 */
  name: string;
  stages: readonly PipelineStageId[];
  briefKind: CouncilBriefKind;
  /** brief 是否必须带 `nextStage.kind = prototype`。 */
  requiresPrototype: boolean;
  /** 写进 brief 生成指令的模板要求（数据，不是执行规则）。 */
  briefRequirements: readonly string[];
}

export const PIPELINE_TEMPLATES: Readonly<Record<PipelineTemplateId, PipelineTemplate>> = {
  "app-mockup": {
    id: "app-mockup",
    name: "App 原型",
    stages: ["brief", "image", "review", "select", "prototype"],
    briefKind: "app-mockup",
    requiresPrototype: true,
    briefRequirements: [
      "kind 必须为 app-mockup。",
      "交付物是关键界面的高保真设计稿（每个界面一个 deliverable）。",
      "必须给出 nextStage：{\"kind\":\"prototype\",\"notes\":\"…\"}，notes 说明原型应实现的页面与交互。",
    ],
  },
  "game-asset-pack": {
    id: "game-asset-pack",
    name: "游戏素材包",
    stages: ["brief", "image", "review", "select"],
    briefKind: "game-sprite",
    requiresPrototype: false,
    briefRequirements: [
      "kind 必须为 game-sprite。",
      "交付物合计至少 6 张 sprite（可用 count 表示同一 deliverable 的多张），全部 transparent: true。",
      "不要给出 nextStage。",
    ],
  },
  "concept-sheet": {
    id: "concept-sheet",
    name: "概念设定",
    stages: ["brief", "image", "review", "select"],
    briefKind: "concept-sheet",
    requiresPrototype: false,
    briefRequirements: [
      "kind 必须为 concept-sheet。",
      "交付物是概念设定图（角色/场景/道具等），每类一个 deliverable。",
      "不要给出 nextStage。",
    ],
  },
};

export function pipelineTemplate(id: PipelineTemplateId): PipelineTemplate {
  return PIPELINE_TEMPLATES[id];
}
