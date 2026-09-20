/**
 * @input  依赖：界面语言上下文、CouncilDecision 与决策状态徽章、MarkdownContent
 * @output 导出：DecisionCard 决策正文卡（四态、可折叠正文），尾部由调用方补
 * @pos    议题决策 tab 与决策记录视图共用的唯一决策渲染出口；右栏只放摘要不走这里
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { CheckCircle2, History, ShieldCheck, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CouncilDecision } from "../types/council";
import { useI18n } from "../i18n/I18nProvider";
import { MarkdownContent } from "./MarkdownContent";
import { DecisionStatusBadge, decisionStatusLabels } from "./presentation";

export interface DecisionCardProps {
  decision: CouncilDecision;
  /** 卡片尾部：决策记录里放提出人，议题里放接受操作 */
  children?: ReactNode;
  /** 决策包列表默认折叠长正文，归档详情保持完整展开。 */
  collapsible?: boolean;
}

export function DecisionCard({ decision, children, collapsible = false }: DecisionCardProps) {
  const { t } = useI18n();
  const accepted = decision.status === "accepted";
  const superseded = decision.status === "superseded";
  const rejected = decision.status === "rejected";
  const body = (
    <>
      <div className="decision-summary-block">
        <MarkdownContent content={decision.summary} />
      </div>
      <div className="decision-rationale-block">
        <MarkdownContent content={decision.rationale} />
      </div>
    </>
  );
  return (
    <section
      className={`decision-card ${accepted ? "decision-accepted" : ""} ${superseded ? "decision-superseded" : ""} ${rejected ? "decision-rejected" : ""}`}
      data-decision-id={decision.id}
    >
      <div className="decision-title-row">
        <div>
          {accepted ? (
            <CheckCircle2 size={17} />
          ) : rejected ? (
            <XCircle size={17} />
          ) : superseded ? (
            <History size={17} />
          ) : (
            <ShieldCheck size={17} />
          )}
          <span>{t(decisionStatusLabels[decision.status])}</span>
        </div>
        <DecisionStatusBadge status={decision.status} />
      </div>
      <h3>{decision.title}</h3>
      {collapsible ? (
        <details className="decision-body-disclosure">
          <summary>{t("查看决策正文")}</summary>
          {body}
        </details>
      ) : body}
      {children}
    </section>
  );
}
