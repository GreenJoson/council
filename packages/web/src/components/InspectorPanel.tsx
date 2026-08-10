/**
 * @input  依赖：界面语言上下文、含 owner/备选/实施进度冻结快照的当前议题、参与者回退、自动轮次与决策操作
 * @output 导出：InspectorPanel 议题摘要、紧凑实施进度、圆桌/按需运行状态、人工签署入口和决策状态卡
 * @pos    Operator Console 右侧编排、约束、证据、备选方案与决策区域；决策这里只放状态、
 *         接受操作和「查看全文」入口——summary/rationale 是长文档，交给主列的决策 tab；
 *         决策状态徽章走 presentation.tsx 的 DecisionStatusBadge，三态共用同一套文案
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  FileText,
  History,
  Plus,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Participant, TopicDetail } from "../types/council";
import type {
  CycleReviewScope,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";
import { useI18n } from "../i18n/I18nProvider";
import { AutoRoundsPanel } from "./AutoRoundsPanel";
import { CyclePanel } from "./CyclePanel";
import { ImplementationSummary } from "./ImplementationProgress";
import {
  AgentAvatar,
  decisionStatusLabels,
  DecisionStatusBadge,
  participantFromActorSnapshot,
  StatusBadge,
} from "./presentation";

export interface InspectorPanelProps {
  topic: TopicDetail;
  participants: Map<string, Participant>;
  isAccepting: boolean;
  isRecordingManualDecision: boolean;
  isOpen: boolean;
  onAccept: () => Promise<void>;
  onRecordManualDecision: () => void;
  /** 切到主列「决策」tab 读全文 */
  onOpenDecision: () => void;
  onClose: () => void;
  orchestration: OrchestrationSnapshot | null;
  orchestrationBusyAction: string | null;
  onStartCycle: (
    participants: string[],
    roundBudget: number,
    reviewScope: CycleReviewScope,
  ) => Promise<boolean>;
  onAnswerCycleQuestion: (
    questionMessageId: string,
    content: string,
  ) => Promise<boolean>;
  onAbandonCycle: () => Promise<void>;
  onStartRun: (runId: string) => Promise<void>;
  onApproveRun: (run: OrchestrationRun) => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
  onRecoverRun: (runId: string) => Promise<void>;
  onCloseRuntimeBinding: (bindingId: string) => Promise<void>;
  onReopenRuntimeBinding: (bindingId: string) => Promise<void>;
}

export function InspectorPanel({
  topic,
  participants,
  isAccepting,
  isRecordingManualDecision,
  isOpen,
  onAccept,
  onRecordManualDecision,
  onOpenDecision,
  onClose,
  orchestration,
  orchestrationBusyAction,
  onStartCycle,
  onAnswerCycleQuestion,
  onAbandonCycle,
  onStartRun,
  onApproveRun,
  onCancelRun,
  onRecoverRun,
  onCloseRuntimeBinding,
  onReopenRuntimeBinding,
}: InspectorPanelProps) {
  const { t } = useI18n();
  const owner = participantFromActorSnapshot(
    topic.ownerSnapshot,
    participants.get(topic.owner),
  );
  const decision = topic.decision;
  const decisionAccepted = decision?.status === "accepted";
  const decisionSuperseded = decision?.status === "superseded";

  return (
    <aside className={`inspector-panel ${isOpen ? "panel-open" : ""}`} aria-label={t("议题摘要")}>
      <div className="inspector-heading">
        <h2>{t("概要")}</h2>
        <button className="icon-button inspector-close" type="button" aria-label={t("关闭议题摘要")} onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <dl className="summary-grid">
        <div>
          <dt>{t("状态")}</dt>
          <dd><StatusBadge status={topic.status} /></dd>
        </div>
        <div>
          <dt>{t("所有者")}</dt>
          <dd>
            <AgentAvatar agent={topic.owner} participant={owner} size="small" />
            <span>{owner?.name ?? topic.owner}</span>
          </dd>
        </div>
        <div>
          <dt>{t("参与者")}</dt>
          <dd className="summary-participants">
            {topic.participants.map((agent) => (
              <AgentAvatar
                agent={agent}
                participant={participants.get(agent)}
                key={agent}
                size="small"
              />
            ))}
          </dd>
        </div>
        <div>
          <dt>{t("更新")}</dt>
          <dd>{topic.updatedLabel}</dd>
        </div>
      </dl>

      <ImplementationSummary topic={topic} />

      <CyclePanel
        topicId={topic.id}
        initiatorActorId={topic.owner}
        isTopicOpen={topic.status !== "decided"}
        snapshot={orchestration}
        busyAction={orchestrationBusyAction}
        onStart={onStartCycle}
        onAnswer={onAnswerCycleQuestion}
        onAbandon={onAbandonCycle}
      />

      <AutoRoundsPanel
        topicId={topic.id}
        isTopicOpen={topic.status !== "decided"}
        snapshot={orchestration}
        busyAction={orchestrationBusyAction}
        onStart={onStartRun}
        onApprove={onApproveRun}
        onCancel={onCancelRun}
        onRecover={onRecoverRun}
        onCloseBinding={onCloseRuntimeBinding}
        onReopenBinding={onReopenRuntimeBinding}
      />

      <InspectorSection title="约束条件" count={topic.constraints.length}>
        <ul className="inspector-list constraint-list">
          {topic.constraints.map((constraint) => (
            <li key={constraint.id}>
              {constraint.tone === "warning" ? (
                <TriangleAlert className="warning-icon" size={15} />
              ) : (
                <Check className="positive-icon" size={15} />
              )}
              <span>{constraint.label}</span>
            </li>
          ))}
        </ul>
      </InspectorSection>

      <InspectorSection title="关键证据" count={topic.evidence.length}>
        {topic.evidence.length > 0 ? (
          <ul className="inspector-list evidence-list">
            {topic.evidence.map((evidence) => (
              <li key={evidence.id}>
                <FileText size={15} />
                <span>
                  <strong>{evidence.label}</strong>
                  <small>{evidence.meta}</small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-copy">{t("尚未添加证据。")}</p>
        )}
      </InspectorSection>

      <InspectorSection title="备选方案" count={topic.alternatives.length}>
        {topic.alternatives.length > 0 ? (
          <ol className="alternative-list">
            {topic.alternatives.map((alternative, index) => {
              const author = participantFromActorSnapshot(
                alternative.authorSnapshot,
                participants.get(alternative.author),
              );
              return (
                <li key={alternative.id}>
                  <span className="alternative-index">{index + 1}</span>
                  <div>
                    <strong>{alternative.title}</strong>
                    <small>
                      {author?.name ?? alternative.author}
                      <span aria-hidden="true"> · </span>
                      {alternative.createdLabel}
                    </small>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="empty-copy">{t("尚未提出备选方案。")}</p>
        )}
      </InspectorSection>

      {decision ? (
        <section
          className={`decision-card ${decisionAccepted ? "decision-accepted" : ""} ${decisionSuperseded ? "decision-superseded" : ""}`}
        >
          <div className="decision-title-row">
            <div>
              {decisionAccepted ? (
                <CheckCircle2 size={17} />
              ) : decisionSuperseded ? (
                <History size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
              <span>{t(decisionStatusLabels[decision.status])}</span>
            </div>
            <DecisionStatusBadge status={decision.status} />
          </div>
          <h3>{decision.title}</h3>
          {/*
            右栏只放状态与入口，不放正文。决策是带章节、表格和 mermaid 的长文档，
            340–440px 的窄栏读不了——正文交给主列的「决策」tab。
          */}
          <button className="decision-open-button" type="button" onClick={onOpenDecision}>
            <BookOpen size={16} />
            {t("查看全文")}
            <ArrowRight size={15} />
          </button>
          <button
            className="accept-button"
            type="button"
            disabled={decision.status !== "proposed" || isAccepting}
            onClick={() => void onAccept()}
          >
            <CheckCircle2 size={17} />
            {decisionAccepted
              ? t("决策已接受")
              : decisionSuperseded
                ? t("决策已被取代")
                : isAccepting
                  ? t("记录中…")
                  : t("标记为 Accepted")}
          </button>
          {decision.status === "proposed" ? (
            <button
              className="secondary-button manual-decision-entry"
              type="button"
              disabled={isAccepting || isRecordingManualDecision}
              onClick={onRecordManualDecision}
            >
              <FileText size={15} />
              {t("记录独立人工决策")}
            </button>
          ) : null}
        </section>
      ) : (
        <section className="decision-card">
          <div className="decision-title-row">
            <div>
              <ShieldCheck size={17} />
              <span>{t("决策")}</span>
            </div>
          </div>
          <h3>{t("尚无拟议决策")}</h3>
          <p>{t("无需等待 Agent，你可以直接记录外部实施结果并结束议题。")}</p>
          <button
            className="primary-button manual-decision-entry"
            type="button"
            disabled={isRecordingManualDecision}
            onClick={onRecordManualDecision}
          >
            <FileText size={15} />
            {t("人工记录并结束")}
          </button>
        </section>
      )}
    </aside>
  );
}

interface InspectorSectionProps {
  title: string;
  count: number;
  children: React.ReactNode;
}

function InspectorSection({ title, count, children }: InspectorSectionProps) {
  const { t } = useI18n();
  return (
    <section className="inspector-section">
      <header>
        <div>
          <h3>{t(title)}</h3>
          <span className="count-pill">{count}</span>
        </div>
        <button className="icon-button compact" type="button" aria-label={t("添加{title}", { title: t(title) })}>
          <Plus size={16} />
        </button>
      </header>
      {children}
    </section>
  );
}
