/**
 * @input  依赖：已决策议题摘要、参与者、只读议题详情懒加载回调（CouncilRepository.loadTopicDetail）与打开讨论回调
 * @output 导出：DecisionRecordsView ADR 风格决策档案（左列表右详情）
 * @pos    Operator Console 决策记录视图：归档已接受/拟议中的结构化决策，详情按需懒加载并缓存
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  FileCheck2,
  FileText,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Participant, TopicDetail, TopicSummary } from "../types/council";
import { AgentAvatar, StatusBadge } from "./presentation";

export interface DecisionRecordsViewProps {
  /** 只读取摘要字段用于左列表，复用已加载的 workspace.topics，不发起请求 */
  topics: TopicSummary[];
  participants: Map<string, Participant>;
  /** 只读旁路加载完整详情；不改变 activeTopicId，不触发订阅（见 CouncilRepository.loadTopicDetail） */
  onLoadDetail: (topicId: string) => Promise<TopicDetail>;
  onOpenTopic: (topicId: string) => void;
}

export function DecisionRecordsView({
  topics,
  participants,
  onLoadDetail,
  onOpenTopic,
}: DecisionRecordsViewProps) {
  const decidedTopics = useMemo(
    () => topics.filter((topic) => topic.status === "decided"),
    [topics],
  );
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Map<string, TopicDetail>>(() => new Map());
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

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

  // 只读懒加载完整决策详情，命中缓存则跳过；用 active 局部闭包（与 App.tsx 选题效果同一范式）
  // 防止组件卸载或选中项已切换（含 StrictMode 开发期二次调用）后的过期响应写入状态。
  useEffect(() => {
    if (!selectedTopicId || detailCache.has(selectedTopicId)) {
      setLoadErrorMessage(null);
      return;
    }
    let active = true;
    setLoadErrorMessage(null);
    void onLoadDetail(selectedTopicId)
      .then((detail) => {
        if (!active) {
          return; // 组件已卸载或选中项已切换：这是过期响应，丢弃
        }
        setDetailCache((current) => new Map(current).set(selectedTopicId, detail));
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setLoadErrorMessage(error instanceof Error ? error.message : "加载议题详情失败");
      });
    return () => {
      active = false;
    };
    // selectedTopicId 变化或手动重试才应发起新请求。
    // detailCache 只用于判断是否命中缓存，不放入依赖数组，否则写入缓存会立刻重触发本 effect；
    // onLoadDetail 由父组件每次渲染都可能创建新的函数引用，放入依赖数组会让父组件任何重渲染
    // 都触发多余的重复请求，这里只需读取调用时刻的最新闭包值。
  }, [selectedTopicId, retryNonce]);

  const selectedDetail = selectedTopicId ? detailCache.get(selectedTopicId) : undefined;
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
              onClick={() => setRetryNonce((current) => current + 1)}
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

function DecisionRecordArticle({ detail, participants, onOpenTopic }: DecisionRecordArticleProps) {
  const decision = detail.decision;
  const decisionAccepted = decision?.status === "accepted";
  const owner = participants.get(detail.owner);
  const proposer = decision ? participants.get(decision.proposedBy) : undefined;

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
          <div className="decision-record-proposer">
            <AgentAvatar agent={decision.proposedBy} size="small" />
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
            {detail.alternatives.map((alternative, index) => (
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
      </section>

      <section className="inspector-section decision-record-question-section">
        <header>
          <div>
            <h3>议题原始问题</h3>
          </div>
        </header>
        <p className="metadata-question-full">{detail.question}</p>
      </section>

      <div className="decision-record-owner">
        <span className="metadata-label">所有者</span>
        <span className="metadata-person">
          <AgentAvatar agent={detail.owner} size="small" />
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
