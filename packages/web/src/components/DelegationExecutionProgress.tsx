/** @input 服务端持久执行阶段与实际进度；@output 暂停原因、阶段预算及最近活动；@pos 无证据的指标不显示。 */
import { useI18n } from "../i18n/I18nProvider";
import type { WorkItemDelegation } from "../types/orchestration";
const PHASES = { brief: "生成实施指令", execution: "执行与验证", commit: "检查并提交", review: "独立审核" } as const;
const PAUSED = new Set(["max_turns_exhausted", "budget_exhausted", "quota_exhausted"]);
export const isDelegationPaused = (run: WorkItemDelegation) => run.status === "failed" && PAUSED.has(run.failureCode ?? "");
export function delegationStatusLabel(run: WorkItemDelegation): string {
  if (isDelegationPaused(run)) return "已暂停，等待接续";
  if (["executing", "reviewing"].includes(run.status) && run.execution) return PHASES[run.execution.phase];
  return ({ queued: "等待执行", executing: "正在执行", reviewing: "正在审核", changes_requested: "审核退回", approved: "审核通过", failed: "执行失败", cancelled: "已取消" } as const)[run.status];
}
export function DelegationExecutionProgress({ delegation }: { delegation: WorkItemDelegation }) {
  const { t, locale } = useI18n();
  const progress = delegation.execution;
  if (!progress) return null;
  const timestamp = new Date(progress.lastActivityAt);
  return <div className="delegation-checkpoint">
    <span>{t("阶段：{phase}", { phase: t(PHASES[progress.phase]) })}</span>
    {progress.turnsUsed !== undefined && progress.turnLimit !== undefined
      ? <span>{t("模型回合：{used}/{limit}", { used: progress.turnsUsed, limit: progress.turnLimit })}</span>
      : progress.turnLimit !== undefined ? <span>{t("本阶段最多 {limit} 个模型回合", { limit: progress.turnLimit })}</span> : null}
    {progress.toolCalls !== undefined ? <span>{t("已观察到 {count} 次工具调用", { count: progress.toolCalls })}</span> : null}
    {progress.lastTool ? <span>{t("最近工具：{tool}", { tool: progress.lastTool })}</span> : null}
    {!Number.isNaN(timestamp.getTime()) ? <span>{t("最近活动：{time}", { time: timestamp.toLocaleTimeString(locale) })}</span> : null}
    {progress.checkpointAvailable ? <span>{t("实施指令已保存")}</span> : null}
  </div>;
}
