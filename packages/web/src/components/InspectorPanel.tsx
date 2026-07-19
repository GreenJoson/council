/**
 * @input  依赖：当前议题、参与者、自动轮次、决策操作与面板状态
 * @output 导出：InspectorPanel 议题摘要、自动轮次和决策检查器
 * @pos    Operator Console 右侧编排、约束、证据、备选方案与决策区域
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Check,
  CheckCircle2,
  FileText,
  Plus,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Participant, TopicDetail } from "../types/council";
import type {
  OrchestrationMessageKind,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";
import { AutoRoundsPanel } from "./AutoRoundsPanel";
import { AgentAvatar, StatusBadge } from "./presentation";

export interface InspectorPanelProps {
  topic: TopicDetail;
  participants: Map<string, Participant>;
  isAccepting: boolean;
  isOpen: boolean;
  onAccept: () => Promise<void>;
  onClose: () => void;
  orchestration: OrchestrationSnapshot | null;
  orchestrationBusyAction: string | null;
  onCreateAndStartRun: (
    adapterId: string,
    messageKind: OrchestrationMessageKind,
    instruction: string,
  ) => Promise<boolean>;
  onStartRun: (runId: string) => Promise<void>;
  onApproveRun: (run: OrchestrationRun) => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
  onRecoverRun: (runId: string) => Promise<void>;
}

export function InspectorPanel({
  topic,
  participants,
  isAccepting,
  isOpen,
  onAccept,
  onClose,
  orchestration,
  orchestrationBusyAction,
  onCreateAndStartRun,
  onStartRun,
  onApproveRun,
  onCancelRun,
  onRecoverRun,
}: InspectorPanelProps) {
  const owner = participants.get(topic.owner);
  const decision = topic.decision;
  const decisionAccepted = decision?.status === "accepted";

  return (
    <aside className={`inspector-panel ${isOpen ? "panel-open" : ""}`} aria-label="议题摘要">
      <div className="inspector-heading">
        <h2>概要</h2>
        <button className="icon-button inspector-close" type="button" aria-label="关闭议题摘要" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <dl className="summary-grid">
        <div>
          <dt>状态</dt>
          <dd><StatusBadge status={topic.status} /></dd>
        </div>
        <div>
          <dt>所有者</dt>
          <dd>
            <AgentAvatar agent={topic.owner} size="small" />
            <span>{owner?.name ?? topic.owner}</span>
          </dd>
        </div>
        <div>
          <dt>参与者</dt>
          <dd className="summary-participants">
            {topic.participants.map((agent) => (
              <AgentAvatar agent={agent} key={agent} size="small" />
            ))}
          </dd>
        </div>
        <div>
          <dt>更新</dt>
          <dd>{topic.updatedLabel}</dd>
        </div>
      </dl>

      <AutoRoundsPanel
        topicId={topic.id}
        snapshot={orchestration}
        busyAction={orchestrationBusyAction}
        onCreateAndStart={onCreateAndStartRun}
        onStart={onStartRun}
        onApprove={onApproveRun}
        onCancel={onCancelRun}
        onRecover={onRecoverRun}
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
          <p className="empty-copy">尚未添加证据。</p>
        )}
      </InspectorSection>

      <InspectorSection title="备选方案" count={topic.alternatives.length}>
        {topic.alternatives.length > 0 ? (
          <ol className="alternative-list">
            {topic.alternatives.map((alternative, index) => (
              <li key={alternative.id}>
                <span className="alternative-index">{index + 1}</span>
                <div>
                  <strong>{alternative.title}</strong>
                  <small>
                    {participants.get(alternative.author)?.name ?? alternative.author}
                    <span aria-hidden="true"> · </span>
                    {alternative.createdLabel}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-copy">尚未提出备选方案。</p>
        )}
      </InspectorSection>

      {decision ? (
        <section className={`decision-card ${decisionAccepted ? "decision-accepted" : ""}`}>
          <div className="decision-title-row">
            <div>
              {decisionAccepted ? <CheckCircle2 size={17} /> : <ShieldCheck size={17} />}
              <span>{decisionAccepted ? "已接受决策" : "拟议决策"}</span>
            </div>
            <span className="decision-status">{decisionAccepted ? "Accepted" : "Proposed"}</span>
          </div>
          <h3>{decision.title}</h3>
          <p>{decision.summary}</p>
          <small>{decision.rationale}</small>
          <button
            className="accept-button"
            type="button"
            disabled={decisionAccepted || isAccepting}
            onClick={() => void onAccept()}
          >
            <CheckCircle2 size={17} />
            {decisionAccepted ? "决策已接受" : isAccepting ? "记录中…" : "标记为 Accepted"}
          </button>
        </section>
      ) : (
        <section className="decision-card">
          <div className="decision-title-row">
            <div>
              <ShieldCheck size={17} />
              <span>决策</span>
            </div>
          </div>
          <h3>尚无拟议决策</h3>
          <p>Agent 提交结构化决策后，可以在这里审阅和接受。</p>
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
  return (
    <section className="inspector-section">
      <header>
        <div>
          <h3>{title}</h3>
          <span className="count-pill">{count}</span>
        </div>
        <button className="icon-button compact" type="button" aria-label={`添加${title}`}>
          <Plus size={16} />
        </button>
      </header>
      {children}
    </section>
  );
}
