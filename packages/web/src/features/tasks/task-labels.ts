/**
 * @input  依赖：types/council 的 WorkItemKind / WorkItemSource 与 WORK_ITEM_KINDS 常量
 * @output 导出：KIND_LABELS、SOURCE_LABELS 中文文案表，P1_CREATABLE_KINDS 新建任务可选 kind
 * @pos    任务视图内部共享的展示常量；状态文案复用 components/ImplementationProgress 的 WORK_ITEM_STATUS_LABELS，不另起一份
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { WorkItemKind, WorkItemSource } from "../../types/council";

/** 文案作为 i18n 键，经 t(KIND_LABELS[kind]) 翻译；新增 kind 时同步 catalog.en.ts。 */
export const KIND_LABELS: Record<WorkItemKind, string> = {
  code: "代码",
  image: "图片",
  prototype: "原型",
  research: "调研",
  pipeline: "流水线",
};

export const SOURCE_LABELS: Record<WorkItemSource, string> = {
  topic: "议题派生",
  direct: "直接创建",
  pipeline: "流水线产出",
};

/**
 * P1 只接入 code 任务的执行链路（委派 kind 也只有 code）。新建对话框仍列出全部 kind，
 * 但非 code 选项置灰并说明 P2 接入——让用户知道能力边界，而不是悄悄只给一个选项。
 */
export const P1_CREATABLE_KINDS: readonly WorkItemKind[] = ["code"];

