/** @input 委派的已记录提交和最近审核；@output 可见交付节点及待修问题；@pos 提交、审核通过与人工验收分别展示。 */
import { useI18n } from "../i18n/I18nProvider";
import type { WorkItemDelegation } from "../types/orchestration";

export function delegationReview(delegation: WorkItemDelegation): { verdict: string; summary: string; findings: string[] } | undefined {
  if (!delegation.review) return undefined;
  try {
    const review: unknown = JSON.parse(delegation.review);
    if (!review || typeof review !== "object" || !("verdict" in review) || !("summary" in review)
      || !("findings" in review) || !["approved", "changes_requested", "blocked"].includes(String(review.verdict))
      || typeof review.summary !== "string" || !Array.isArray(review.findings)
      || !review.findings.every(value => typeof value === "string")) return undefined;
    return { verdict: String(review.verdict), summary: review.summary, findings: review.findings };
  } catch { return undefined; }
}

export function DelegationDeliveryEvidence({ delegation }: { delegation: WorkItemDelegation }) {
  const { t } = useI18n();
  const review = delegationReview(delegation);
  if (!delegation.headCommit && !review) return null;
  return <div className="delegation-delivery-evidence">
    {delegation.headCommit ? <p>{t("已保存代码提交：{commit}", { commit: delegation.headCommit.slice(0, 12) })}</p> : null}
    {review ? <details>
      <summary>{t(review.verdict === "blocked" ? "审核受阻：材料待补查" : review.verdict === "changes_requested" ? "上轮审核：需要修正（{count} 项）" : "最近审核：通过", { count: review.findings.length })}</summary>
      <p>{review.summary}</p>
      {review.findings.length ? <ul>{review.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul> : null}
    </details> : null}
  </div>;
}
