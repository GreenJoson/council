/**
 * @input  依赖：CouncilDecision 完整决策数组
 * @output 导出：决策包计数、待确认项与右栏摘要选择器
 * @pos    讨论面板、检查器和 App 接受流程共享的纯决策包查询边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilDecision } from "../types/council";

export interface DecisionPackageSummary {
  total: number;
  proposed: number;
  accepted: number;
  rejected: number;
  superseded: number;
}

export function summarizeDecisionPackage(
  decisions: readonly CouncilDecision[],
): DecisionPackageSummary {
  const summary: DecisionPackageSummary = {
    total: decisions.length,
    proposed: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
  };
  for (const decision of decisions) {
    summary[decision.status] += 1;
  }
  return summary;
}

export function pendingDecisions(
  decisions: readonly CouncilDecision[],
): CouncilDecision[] {
  return decisions.filter((decision) => decision.status === "proposed");
}

/** 右栏只作入口：优先提示最新待办，否则展示最近的有效定论/历史记录。 */
export function selectDecisionPackageLead(
  decisions: readonly CouncilDecision[],
): CouncilDecision | undefined {
  return [...decisions].reverse().find((decision) => decision.status === "proposed")
    ?? [...decisions].reverse().find((decision) => decision.status === "accepted")
    ?? decisions.at(-1);
}
