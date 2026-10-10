/**
 * @input  依赖：界面语言、某任务的历史委派（不含当前由 WorkItemDelegationPanel 展示的最近一次）、可用 Agent 列表、
 *         components 的 delegationStatusLabel/isDelegationPaused 与 RuntimeAuditDetails
 * @output 导出：DelegationTimeline —— 按 createdAt 倒序的历史委派列表（状态、执行者→审核者（图像委派只显示执行者）、分支/提交、失败分类、审计入口）
 * @pos    任务详情委派区的下半部分；只读展示，不提供操作（接续/取消都作用于最近一次委派，由面板负责）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, GitBranch } from "lucide-react";
import { delegationStatusLabel, isDelegationPaused } from "../../components/DelegationExecutionProgress";
import { RuntimeAuditDetails } from "../../components/RuntimeAuditDetails";
import { useI18n } from "../../i18n/I18nProvider";
import type { OrchestrationAdapter, WorkItemDelegation } from "../../types/orchestration";

export interface DelegationTimelineProps {
  delegations: WorkItemDelegation[];
  adapters: OrchestrationAdapter[];
}

export function DelegationTimeline({ delegations, adapters }: DelegationTimelineProps) {
  const { t, locale } = useI18n();
  if (delegations.length === 0) {
    return null;
  }
  const labelOf = (agentId: string) => adapters.find((agent) => agent.id === agentId)?.label ?? agentId;
  const ordered = [...delegations].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return (
    <section className="task-delegation-timeline" aria-label={t("历史委派")}>
      <h3>{t("历史委派")}</h3>
      <ol>
        {ordered.map((entry) => {
          const created = new Date(entry.createdAt);
          return (
            <li key={entry.id} className={`is-${isDelegationPaused(entry) ? "paused" : entry.status}`}>
              <header>
                <strong>{t(delegationStatusLabel(entry))}</strong>
                <time dateTime={entry.createdAt}>
                  {Number.isNaN(created.getTime()) ? entry.createdAt : created.toLocaleString(locale)}
                </time>
              </header>
              <small>
                {labelOf(entry.executorAgentId)}{entry.kind === "image" ? null : <> → {labelOf(entry.supervisorAgentId)}</>}
                {entry.attempt > 0 ? ` · ${t("审核轮次：{used}/{limit}", { used: entry.attempt, limit: entry.maxAttempts })}` : ""}
              </small>
              {entry.headCommit || entry.branchName ? (
                <code>
                  <GitBranch size={12} />
                  {entry.branchName ?? ""}
                  {entry.headCommit ? ` · ${entry.headCommit.slice(0, 12)}` : ""}
                </code>
              ) : null}
              {entry.failureCode ? (
                <p><AlertTriangle size={12} />{t("失败分类：{code}", { code: entry.failureCode })}</p>
              ) : null}
              {/* 审计按议题分页；直接任务的委派没有 topicId，P1 不发空 topicId 的无效查询。 */}
              {entry.topicId ? <RuntimeAuditDetails topicId={entry.topicId} sourceKind="delegation" sourceId={entry.id} /> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
