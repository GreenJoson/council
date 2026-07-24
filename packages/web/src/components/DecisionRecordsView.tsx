/**
 * @input  依赖：含 owner/决策/备选冻结快照的议题、参与者回退、详情懒加载回调，
 *         经共享的 useTopicDetails hook）、外部跳转定位请求（focusRequest）、打开讨论回调与 MarkdownContent
 * @output 导出：DecisionRecordsView ADR 风格决策档案（左列表右详情）、
 *         DecisionRecordArticle 单条冻结身份档案
 * @pos    Operator Console 决策记录视图：归档已接受/拟议中/已被取代的结构化决策
 *         （summary/rationale/原始问题按 Markdown 渲染、不折叠，含内嵌 mermaid 围栏），
 *         详情经 useTopicDetails 按需懒加载并缓存；架构档案时间线点击某条 ADR 后
 *         通过 focusRequest 定位到对应条目
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  FileCheck2,
  FileText,
  History,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTopicDetails } from "../hooks/useTopicDetails";
import type { Participant, TopicDetail, TopicSummary } from "../types/council";
import { MarkdownContent } from "./MarkdownContent";
import {
  AgentAvatar,
  decisionStatusLabels,
  DecisionStatusBadge,
  participantFromActorSnapshot,
  StatusBadge,
} from "./presentation";

/** 外部触发的定位请求：nonce 保证重复点击同一 ADR 也能重新生效（见 App.tsx handleOpenDecisionRecord） */
export interface DecisionRecordFocusRequest {
  topicId: string;
  nonce: number;
}

export interface DecisionRecordsViewProps {
  /** 只读取摘要字段用于左列表，复用已加载的 workspace.topics，不发起请求 */
  topics: TopicSummary[];
  participants: Map<string, Participant>;
  /** 只读旁路加载完整详情；不改变 activeTopicId，不触发订阅（见 CouncilRepository.loadTopicDetail） */
  onLoadDetail: (topicId: string) => Promise<TopicDetail>;
  onOpenTopic: (topicId: string) => void;
  /** 架构档案时间线跳转过来时携带的定位请求；为空表示按默认规则自动选中最新一条 */
  focusRequest?: DecisionRecordFocusRequest | null;
}

export function DecisionRecordsView({
  topics,
  participants,
  onLoadDetail,
  onOpenTopic,
  focusRequest,
}: DecisionRecordsViewProps) {
  const decidedTopics = useMemo(
    () => topics.filter((topic) => topic.status === "decided"),
    [topics],
  );
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);

  // 已决策列表变化时：当前选中项若已不在列表中（或尚未选中），自动定位到最新的一条
  useEffect(() => {
    const first = decidedTopics[0];
    setSelectedTopicId((current) => {
      if (current && decidedTopics.some((topic) => topic.id === current)) {
        return current;
      }
      return first?.id ?? null;
    });
  }, [decidedTopics]);

  // 架构档案时间线点击跳转：nonce 变化即视为一次新的定位请求，即使 topicId 与当前选中相同
  useEffect(() => {
    if (!focusRequest) {
      return;
    }
    setSelectedTopicId(focusRequest.topicId);
  }, [focusRequest]);

  const { details, errors, retry } = useTopicDetails(
    selectedTopicId ? [selectedTopicId] : [],
    onLoadDetail,
  );
  const selectedDetail = selectedTopicId ? details.get(selectedTopicId) : undefined;
  const loadErrorMessage = selectedTopicId ? (errors.get(selectedTopicId) ?? null) : null;
  const isLoading = Boolean(selectedTopicId) && !selectedDetail && !loadErrorMessage;

  return (
    <section className="decision-records-view" aria-label="决策记录">
      <aside className="decision-records-list" aria-label="已决策议题列表">
        <header className="decision-records-list-header">
          <h1>决策记录</h1>
          <span className="count-pill">{decidedTopics.length}</span>
        </header>
        {decidedTopics.length > 0 ? (
          <div className="topic-list" role="list">
            {decidedTopics.map((topic) => (
              <div role="listitem" key={topic.id}>
                <button
                  className={`topic-row ${topic.id === selectedTopicId ? "selected" : ""}`}
                  type="button"
                  onClick={() => setSelectedTopicId(topic.id)}
                >
                  <span className="topic-title">{topic.title}</span>
                  <span className="topic-updated">{topic.updatedLabel}</span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-topics">
            <FileCheck2 size={22} aria-hidden="true" />
            <p>接受决策后会在这里归档</p>
          </div>
        )}
      </aside>

      <div className="decision-records-detail">
        {!selectedTopicId ? (
          <div className="decision-records-placeholder">
            <FileCheck2 size={28} aria-hidden="true" />
            <p>选择左侧的已决策议题查看归档详情</p>
          </div>
        ) : loadErrorMessage ? (
          <div className="decision-records-placeholder">
            <TriangleAlert size={28} aria-hidden="true" />
            <p>{loadErrorMessage}</p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => selectedTopicId && retry(selectedTopicId)}
            >
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        ) : isLoading ? (
          <div className="decision-records-skeleton" aria-busy="true" aria-label="正在加载决策详情">
            <div className="skeleton-line skeleton-line-title" />
            <div className="skeleton-block" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        ) : selectedDetail ? (
          <DecisionRecordArticle detail={selectedDetail} participants={participants} onOpenTopic={onOpenTopic} />
        ) : null}
      </div>
    </section>
  );
}

interface DecisionRecordArticleProps {
  detail: TopicDetail;
  participants: Map<string, Participant>;
  onOpenTopic: (topicId: string) => void;
}

export function DecisionRecordArticle({
  detail,
  participants,
  onOpenTopic,
}: DecisionRecordArticleProps) {
  const decision = detail.decision;
  const decisionAccepted = decision?.status === "accepted";
  const decisionSuperseded = decision?.status === "superseded";
  const owner = participantFromActorSnapshot(
    detail.ownerSnapshot,
    participants.get(detail.owner),
  );
  const proposer = decision
    ? participantFromActorSnapshot(
      decision.proposedBySnapshot,
      participants.get(decision.proposedBy),
    )
    : undefined;

  return (
    <article className="decision-record-article">
      <header className="decision-record-header">
        <div>
          <StatusBadge status={detail.status} />
          <h2>{detail.title}</h2>
        </div>
        <span className="decision-record-updated">更新于 {detail.updatedLabel}</span>
      </header>

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
              <span>{decisionStatusLabels[decision.status]}</span>
            </div>
            <DecisionStatusBadge status={decision.status} />
          </div>
          <h3>{decision.title}</h3>
          <div className="decision-summary-block">
            <MarkdownContent content={decision.summary} />
          </div>
          <div className="decision-rationale-block">
            <MarkdownContent content={decision.rationale} />
          </div>
          <div className="decision-record-proposer">
            <AgentAvatar
              agent={decision.proposedBy}
              participant={proposer}
              size="small"
            />
            <span>由 {proposer?.name ?? decision.proposedBy} 提出</span>
          </div>
        </section>
      ) : (
        <p className="decision-record-honest-notice">
          <TriangleAlert size={15} aria-hidden="true" />
          该议题已决定，但未记录结构化决策。
        </p>
      )}

      <section className="inspector-section">
        <header>
          <div>
            <h3>约束条件</h3>
            <span className="count-pill">{detail.constraints.length}</span>
          </div>
        </header>
        {detail.constraints.length > 0 ? (
          <ul className="inspector-list constraint-list">
            {detail.constraints.map((constraint) => (
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
        ) : (
          <p className="empty-copy">尚未记录约束条件。</p>
        )}
      </section>

      <section className="inspector-section">
        <header>
          <div>
            <h3>关键证据</h3>
            <span className="count-pill">{detail.evidence.length}</span>
          </div>
        </header>
        {detail.evidence.length > 0 ? (
          <ul className="inspector-list evidence-list">
            {detail.evidence.map((evidence) => (
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
      </section>

      <section className="inspector-section">
        <header>
          <div>
            <h3>备选方案</h3>
            <span className="count-pill">{detail.alternatives.length}</span>
          </div>
        </header>
        {detail.alternatives.length > 0 ? (
          <ol className="alternative-list">
            {detail.alternatives.map((alternative, index) => {
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
          <p className="empty-copy">尚未提出备选方案。</p>
        )}
      </section>

      <section className="inspector-section decision-record-question-section">
        <header>
          <div>
            <h3>议题原始问题</h3>
          </div>
        </header>
        <div className="metadata-question-full">
          <MarkdownContent content={detail.question} />
        </div>
      </section>

      <div className="decision-record-owner">
        <span className="metadata-label">所有者</span>
        <span className="metadata-person">
          <AgentAvatar agent={detail.owner} participant={owner} size="small" />
          <span>{owner?.name ?? detail.owner}</span>
        </span>
      </div>

      <footer className="decision-record-footer">
        <button className="secondary-button" type="button" onClick={() => onOpenTopic(detail.id)}>
          <ArrowUpRight size={16} />
          在讨论中打开
        </button>
      </footer>
    </article>
  );
}
