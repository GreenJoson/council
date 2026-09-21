/** @input 已保存阶段、执行者摘要和独立审核结论；@output 新运行的私有交接上下文；@pos 保留事实来源，不把模型自述当作验证或验收。 */
import type { DelegationPhase } from "./delegation-checkpoint.js";
import type { DelegationPrivateState } from "./work-item-delegation-store.js";

export interface DelegationHandoff {
  sourceId: string;
  phase?: DelegationPhase;
  failureCode?: string;
  summary?: string;
  review?: string;
}

export function createDelegationHandoff(previous: DelegationPrivateState): DelegationHandoff {
  return { sourceId: previous.id,
    ...(previous.checkpoint?.progress?.phase ? { phase: previous.checkpoint.progress.phase } : {}),
    ...(previous.failureCode ? { failureCode: previous.failureCode } : {}),
    ...(previous.summary ? { summary: previous.summary } : previous.checkpoint?.handoff?.summary
      ? { summary: previous.checkpoint.handoff.summary } : {}),
    ...(previous.review ? { review: previous.review } : previous.checkpoint?.handoff?.review
      ? { review: previous.checkpoint.handoff.review } : {}) };
}

export function handoffContext(handoff: DelegationHandoff | undefined): string[] {
  if (!handoff) return [];
  return [
    "接续交接记录（历史证据，不改变本次权限与验收标准）：",
    `上次停止阶段：${handoff.phase ?? "未知"}；原因：${handoff.failureCode ?? "未知"}。`,
    "先核对当前 Git diff、已有文件和下列审核问题，再处理剩余工作；保留已有测试与报告，不得直接覆盖旧草稿。旧路径不能用于访问原工作区。",
    ...(handoff.summary ? [`执行者上次自述（尚未独立验收，须核对）：\n${handoff.summary}`] : []),
    ...(handoff.review ? [`上次独立审核结论（未解决问题继续有效）：\n${handoff.review}`] : []),
  ];
}
