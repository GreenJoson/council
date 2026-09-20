/**
 * @input  依赖：界面语言上下文、当前项目名、含 owner/完整决策包/实施任务冻结快照的当前议题、参与者回退、同步/发布状态、消息回调与自动轮次快照
 *         （驱动时间线 Agent 回复动态，并透传议题开放状态给 Composer 控制 @agent 召唤）
 * @output 导出：DiscussionPanel 中央工作区（讨论/完整决策包、单条/批量接受、任务/元数据、
 *         议题关闭、人工签署、阶梯导航与引用回复）
 * @pos    Operator Console 的主要阅读、决策通读、任务执行、元数据核查和回复区域；过长议题问题默认
 *         收起；决策 tab 按主列流体宽度渲染全文，右栏经 decisionFocusNonce 切过来
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Archive, Check, CheckCircle2, Copy, FileCheck2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CouncilMessage,
  CouncilWorkItem,
  MessageKind,
  Participant,
  SyncState,
  TopicDetail,
  WorkItemStatus,
} from "../types/council";
import type {
  OrchestrationAdapter,
  OrchestrationSnapshot,
  WorkItemDelegation,
} from "../types/orchestration";
import { pendingDecisions, summarizeDecisionPackage } from "../data/decision-package";
import { summarizeWorkItemProgress } from "../data/work-item-tree";
import { useI18n } from "../i18n/I18nProvider";
import { AgentAvatar, participantFromActorSnapshot, StatusBadge } from "./presentation";
import {
  AgentReplyActivity,
  selectAgentReplyActivity,
} from "./AgentReplyActivity";
import { Composer, type MentionPublishRequest, type QuoteSeed } from "./Composer";
import { DecisionCard } from "./DecisionCard";
import { ImplementationProgress } from "./ImplementationProgress";
import { MarkdownContent } from "./MarkdownContent";
import { MessageCard } from "./MessageCard";
import { MessageJumpRail } from "./MessageJumpRail";
import type { BatchDelegationOptions } from "./BatchWorkItemDelegationPanel";

export interface DiscussionPanelProps {
  projectName: string;
  topic: TopicDetail;
  participants: Map<string, Participant>;
  sync: SyncState;
  isPublishing: boolean;
  onPublish: (kind: MessageKind, content: string, mention?: MentionPublishRequest) => Promise<boolean>;
  orchestration: OrchestrationSnapshot | null;
  orchestrationBusyAction: string | null;
  workItemBusyAction: string | null;
  onGenerateWorkItems: (adapterId: string) => Promise<void>;
  onAddWorkItem: (title: string, details: string, parentId?: string) => Promise<boolean>;
  onUpdateWorkItem: (
    item: CouncilWorkItem,
    status: WorkItemStatus,
    statusNote: string,
  ) => Promise<void>;
  onClaimWorkItem: (item: CouncilWorkItem) => Promise<void>;
  delegationAgents?: OrchestrationAdapter[];
  delegations?: WorkItemDelegation[];
  delegationBusyAction?: string | null;
  onDelegateWorkItem?: (
    item: CouncilWorkItem,
    input: {
      supervisorAgentId: string;
      executorAgentId: string;
      requestedPermission: "workspace_write" | "danger_full_access";
      createInitialBaseline?: boolean;
    },
  ) => Promise<void>;
  onDelegateWorkItems?: (
    items: CouncilWorkItem[],
    input: BatchDelegationOptions,
  ) => Promise<void>;
  onCancelDelegation?: (delegationId: string) => Promise<void>;
  isAccepting: boolean;
  onAccept: (decisionIds: string[]) => Promise<void> | void;
  isRecordingManualDecision: boolean;
  onRecordManualDecision: () => void;
  isClosingTopic: boolean;
  onCloseTopic: () => void;
  /** 右栏「查看全文」发来的切换请求；nonce 变化即一次新请求，同一议题重复点也生效 */
  decisionFocusNonce?: number;
}

type DiscussionTab = "discussion" | "decision" | "tasks" | "metadata";

const QUOTE_LINE_LIMIT = 88;
const TIMELINE_FOLLOW_THRESHOLD = 240;

function messageElementId(messageId: string): string {
  return `message-card-${encodeURIComponent(messageId)}`;
}

/** 把消息首行截断为合理长度后组装成 Markdown 引用，供 Composer 续写 */
function buildQuoteText(message: CouncilMessage, participants: Map<string, Participant>): string {
  const authorName =
    message.actorSnapshot.displayName ||
    participants.get(message.author)?.name ||
    message.author;
  const firstLine = message.content.split("\n")[0]?.trim() ?? "";
  const truncated =
    firstLine.length > QUOTE_LINE_LIMIT ? `${firstLine.slice(0, QUOTE_LINE_LIMIT)}…` : firstLine;
  return `> ${authorName}：${truncated}\n\n`;
}

export function DiscussionPanel({
  projectName,
  topic,
  participants,
  sync,
  isPublishing,
  onPublish,
  orchestration,
  orchestrationBusyAction,
  workItemBusyAction,
  onGenerateWorkItems,
  onAddWorkItem,
  onUpdateWorkItem,
  onClaimWorkItem,
  delegationAgents = [],
  delegations = [],
  delegationBusyAction = null,
  onDelegateWorkItem = async () => undefined,
  onDelegateWorkItems = async () => undefined,
  onCancelDelegation = async () => undefined,
  isAccepting,
  onAccept,
  isRecordingManualDecision,
  onRecordManualDecision,
  isClosingTopic,
  onCloseTopic,
  decisionFocusNonce,
}: DiscussionPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DiscussionTab>("discussion");
  const [quoteSeed, setQuoteSeed] = useState<QuoteSeed | null>(null);
  const [isIdCopied, setIsIdCopied] = useState(false);
  const [selectedDecisionIds, setSelectedDecisionIds] = useState<Set<string>>(new Set());
  const [activeMessageId, setActiveMessageId] = useState(topic.messages[0]?.id);
  const timelineRef = useRef<HTMLElement>(null);
  const shouldFollowTimelineRef = useRef(true);
  const quoteNonceRef = useRef(0);
  const copyResetTimeoutRef = useRef<number | undefined>(undefined);

  // 切换议题时回到"讨论" tab，避免带着上一个议题的元数据视图
  useEffect(() => {
    setActiveTab("discussion");
    setActiveMessageId(topic.messages[0]?.id);
    setSelectedDecisionIds(new Set());
    shouldFollowTimelineRef.current = false;
  }, [topic.id]);

  // 接受完成或后台刷新后，及时剔除已不再是 proposed 的选中项。
  useEffect(() => {
    const pendingIds = new Set(
      topic.decisions
        .filter((decision) => decision.status === "proposed")
        .map((decision) => decision.id),
    );
    setSelectedDecisionIds((current) => {
      const next = new Set([...current].filter((id) => pendingIds.has(id)));
      const unchanged = next.size === current.size
        && [...next].every((id) => current.has(id));
      return unchanged ? current : next;
    });
  }, [topic.decisions]);

  // 右栏「查看全文」：nonce 变化即切到决策 tab。初值 undefined 不触发，避免开局抢走讨论
  useEffect(() => {
    if (decisionFocusNonce === undefined) {
      return;
    }
    setActiveTab("decision");
  }, [decisionFocusNonce]);

  useEffect(() => {
    if (activeTab !== "discussion") {
      return;
    }
    const timeline = timelineRef.current;
    if (!timeline || topic.messages.length === 0) {
      return;
    }

    let animationFrame: number | undefined;
    const updateActiveMessage = () => {
      animationFrame = undefined;
      const timelineRect = timeline.getBoundingClientRect();
      const distanceFromEnd =
        timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
      shouldFollowTimelineRef.current = distanceFromEnd <= TIMELINE_FOLLOW_THRESHOLD;
      const readingLine = timelineRect.top + Math.min(120, timelineRect.height * 0.24);
      let currentId = topic.messages[0]?.id;

      if (distanceFromEnd <= 2) {
        currentId = topic.messages.at(-1)?.id;
      } else {
        for (const message of topic.messages) {
          const card = document.getElementById(messageElementId(message.id));
          if (card && card.getBoundingClientRect().top <= readingLine) {
            currentId = message.id;
          }
        }
      }
      setActiveMessageId(currentId);
    };
    const scheduleUpdate = () => {
      if (animationFrame === undefined) {
        animationFrame = requestAnimationFrame(updateActiveMessage);
      }
    };

    scheduleUpdate();
    timeline.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      timeline.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [activeTab, topic.id, topic.messages]);

  const agentReplyActivity = selectAgentReplyActivity(orchestration, topic.id);
  const agentReplyActivityKey = agentReplyActivity
    ? `${agentReplyActivity.runId}:${agentReplyActivity.adapterId}:${agentReplyActivity.phase}`
    : null;
  const agentReplyContentLength = agentReplyActivity?.content.length ?? 0;

  useEffect(() => {
    if (!agentReplyActivityKey || !shouldFollowTimelineRef.current) {
      return;
    }
    const animationFrame = requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline) {
        return;
      }
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      timeline.scrollTo({
        top: timeline.scrollHeight,
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [agentReplyActivityKey]);

  useEffect(() => {
    if (agentReplyContentLength === 0 || !shouldFollowTimelineRef.current) {
      return;
    }
    const animationFrame = requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (timeline) {
        timeline.scrollTo({ top: timeline.scrollHeight, behavior: "auto" });
      }
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [agentReplyContentLength]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  const hiddenMessageCount = Math.max(
    0,
    (topic.messageTotal ?? topic.messages.length) - topic.messages.length,
  );
  const owner = participantFromActorSnapshot(
    topic.ownerSnapshot,
    participants.get(topic.owner),
  );
  const decisionSummary = summarizeDecisionPackage(topic.decisions);
  const proposedDecisions = pendingDecisions(topic.decisions);
  const allProposedSelected = proposedDecisions.length > 0
    && proposedDecisions.every((decision) => selectedDecisionIds.has(decision.id));
  // 任务 tab 的计数必须和侧边栏、实施进度卡共用一套口径：都只数叶子。
  // 父任务的状态本来就是子任务算出来的，再进一次分母等于把同一件事记两次。
  const workItemProgress = topic.workItemProgress ?? summarizeWorkItemProgress(topic.workItems);
  const completedWorkItems = workItemProgress?.completed ?? 0;
  const totalWorkItems = workItemProgress?.total ?? 0;

  function handleQuote(message: CouncilMessage): void {
    quoteNonceRef.current += 1;
    setQuoteSeed({ text: buildQuoteText(message, participants), nonce: quoteNonceRef.current });
  }

  function toggleDecisionSelection(decisionId: string): void {
    setSelectedDecisionIds((current) => {
      const next = new Set(current);
      if (next.has(decisionId)) {
        next.delete(decisionId);
      } else {
        next.add(decisionId);
      }
      return next;
    });
  }

  function toggleAllProposedDecisions(): void {
    setSelectedDecisionIds(
      allProposedSelected
        ? new Set()
        : new Set(proposedDecisions.map((decision) => decision.id)),
    );
  }

  function handleMessageJump(messageId: string): void {
    const target = document.getElementById(messageElementId(messageId));
    if (!target) {
      return;
    }
    setActiveMessageId(messageId);
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }

  async function handleCopyId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(topic.id);
      setIsIdCopied(true);
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = window.setTimeout(() => setIsIdCopied(false), 1600);
    } catch {
      // 剪贴板权限缺失时静默失败，不打断操作员当前操作
    }
  }

  return (
    <main className="discussion-panel" id="main-content" tabIndex={-1}>
      <header className="topic-header">
        <div className="topic-heading-row">
          <div>
            <div className="topic-title-line">
              <h1>{topic.title}</h1>
            </div>
            <div className="topic-metadata">
              <StatusBadge status={topic.status} />
              <span>{t("创建于 {time}", { time: topic.createdLabel })}</span>
              <span aria-hidden="true">·</span>
              <span>{t("更新于 {time}", { time: topic.updatedLabel })}</span>
            </div>
          </div>
          <div className="topic-heading-actions">
            {topic.status !== "closed" ? (
              <button
                className="topic-close-button"
                type="button"
                disabled={isClosingTopic}
                onClick={onCloseTopic}
              >
                <Archive size={14} aria-hidden="true" />
                {t(isClosingTopic ? "正在关闭" : "关闭议题")}
              </button>
            ) : null}
            <div className="topic-participants" aria-label={t("议题参与者")}>
              {topic.participants.map((agent) => (
                <AgentAvatar
                  agent={agent}
                  participant={participants.get(agent)}
                  key={agent}
                  size="small"
                />
              ))}
            </div>
          </div>
        </div>
        <div className="topic-question">
          <MarkdownContent content={topic.question} collapsible collapseVariant="topic" />
        </div>
        <div className="topic-tabs" role="tablist" aria-label={t("议题视图")}>
          <button
            className={activeTab === "discussion" ? "active" : ""}
            type="button"
            role="tab"
            id="discussion-tab"
            aria-selected={activeTab === "discussion"}
            aria-controls="discussion-tabpanel"
            onClick={() => setActiveTab("discussion")}
          >
            {t("讨论")}
            <span className="count-pill">{topic.messageTotal ?? topic.messages.length}</span>
          </button>
          <button
            className={activeTab === "decision" ? "active" : ""}
            type="button"
            role="tab"
            id="decision-tab"
            aria-selected={activeTab === "decision"}
            aria-controls="decision-tabpanel"
            onClick={() => setActiveTab("decision")}
          >
            {t("决策")}
            <span className="count-pill">{decisionSummary.total}</span>
            {/* 只要决策包里仍有 proposed 就亮点；部分接受不能把剩余待办藏掉。 */}
            {decisionSummary.proposed > 0 ? (
              <span className="tab-dot" aria-label={t("有待审阅的拟议决策")} />
            ) : null}
          </button>
          <button
            className={activeTab === "tasks" ? "active" : ""}
            type="button"
            role="tab"
            id="tasks-tab"
            aria-selected={activeTab === "tasks"}
            aria-controls="tasks-tabpanel"
            onClick={() => setActiveTab("tasks")}
          >
            {t("任务")}
            <span
              className="count-pill task-count-pill"
              aria-label={t("已完成 {completed}，共 {total} 项任务", {
                completed: completedWorkItems,
                total: totalWorkItems,
              })}
            >
              {completedWorkItems}/{totalWorkItems}
            </span>
          </button>
          <button
            className={activeTab === "metadata" ? "active" : ""}
            type="button"
            role="tab"
            id="metadata-tab"
            aria-selected={activeTab === "metadata"}
            aria-controls="metadata-tabpanel"
            onClick={() => setActiveTab("metadata")}
          >
            {t("元数据")}
          </button>
        </div>
      </header>

      {activeTab === "discussion" ? (
        <>
          <div className="discussion-scroll-shell">
            <MessageJumpRail
              messages={topic.messages}
              activeMessageId={activeMessageId}
              onSelect={handleMessageJump}
            />
            <section
              className="message-timeline"
              id="discussion-tabpanel"
              role="tabpanel"
              aria-labelledby="discussion-tab"
              aria-label={t("共享讨论时间线")}
              ref={timelineRef}
            >
              {hiddenMessageCount > 0 ? (
                <p className="history-notice">
                  {t("当前显示最近 {visible} 条，另有 {hidden} 条历史消息。", {
                    visible: topic.messages.length,
                    hidden: hiddenMessageCount,
                  })}
                </p>
              ) : null}
              {topic.messages.length > 0 ? (
                topic.messages.map((message, index) => (
                  <MessageCard
                    message={message}
                    participant={participants.get(message.author)}
                    index={index}
                    elementId={messageElementId(message.id)}
                    onQuote={handleQuote}
                    key={message.id}
                  />
                ))
              ) : (
                <div className="empty-discussion">
                  <AgentAvatar agent="council" />
                  <div>
                    <h2>{t("议题已经准备好")}</h2>
                    <p>{t("发布第一条 proposal，或让 Agent 读取此议题后提交公开方案。")}</p>
                  </div>
                </div>
              )}
              {agentReplyActivity ? (
                <AgentReplyActivity activity={agentReplyActivity} />
              ) : null}
            </section>
          </div>

          <Composer
            currentProjectName={projectName}
            isPublishing={isPublishing}
            allowAgentCalls={topic.status !== "decided" && topic.status !== "closed"}
            sync={sync}
            onPublish={onPublish}
            quoteSeed={quoteSeed}
            topicId={topic.id}
            orchestration={orchestration}
            orchestrationBusyAction={orchestrationBusyAction}
          />
        </>
      ) : activeTab === "decision" ? (
        <section
          className="topic-decision-panel"
          id="decision-tabpanel"
          role="tabpanel"
          aria-labelledby="decision-tab"
          aria-label={t("议题决策")}
        >
          {topic.decisions.length > 0 ? (
            <>
              <header className="decision-package-header">
                <div>
                  <span className="dialog-kicker">{t("决策包")}</span>
                  <h2>{t("共 {total} 条决策", { total: decisionSummary.total })}</h2>
                  <p>
                    {t("{proposed} 条待确认，{accepted} 条已接受", {
                      proposed: decisionSummary.proposed,
                      accepted: decisionSummary.accepted,
                    })}
                  </p>
                </div>
                {topic.status !== "decided" && topic.status !== "closed" ? (
                  <button
                    className="secondary-button manual-decision-entry"
                    type="button"
                    disabled={isRecordingManualDecision || isAccepting}
                    onClick={onRecordManualDecision}
                  >
                    <FileCheck2 size={16} />
                    {t("记录独立人工决策")}
                  </button>
                ) : null}
              </header>

              {proposedDecisions.length > 1 ? (
                <div className="decision-batch-bar" aria-label={t("批量决策操作")}>
                  <label className="decision-select-control">
                    <input
                      type="checkbox"
                      checked={allProposedSelected}
                      onChange={toggleAllProposedDecisions}
                    />
                    <span>{t("选择全部待确认决策")}</span>
                  </label>
                  <span className="decision-selection-count">
                    {t("已选择 {count} 条", { count: selectedDecisionIds.size })}
                  </span>
                  <button
                    className="accept-button"
                    type="button"
                    disabled={selectedDecisionIds.size === 0 || isAccepting}
                    onClick={() => void onAccept([...selectedDecisionIds])}
                  >
                    <CheckCircle2 size={17} />
                    {isAccepting
                      ? t("记录中…")
                      : t("接受选中的 {count} 条", { count: selectedDecisionIds.size })}
                  </button>
                </div>
              ) : null}

              <div className="decision-package-list">
                {topic.decisions.map((decision) => {
                  const proposer = participantFromActorSnapshot(
                    decision.proposedBySnapshot,
                    participants.get(decision.proposedBy),
                  );
                  const isProposed = decision.status === "proposed";
                  return (
                    <div className="decision-package-item" key={decision.id}>
                      {isProposed ? (
                        <label className="decision-card-selector">
                          <input
                            type="checkbox"
                            checked={selectedDecisionIds.has(decision.id)}
                            onChange={() => toggleDecisionSelection(decision.id)}
                          />
                          <span>{t("选择决策：{title}", { title: decision.title })}</span>
                        </label>
                      ) : null}
                      <DecisionCard decision={decision} collapsible={topic.decisions.length > 1}>
                        <div className="topic-decision-actions">
                          <span className="topic-decision-proposer">
                            <AgentAvatar
                              agent={decision.proposedBy}
                              participant={proposer}
                              size="small"
                            />
                            <span>{t("由 {name} 提出", {
                              name: proposer?.name ?? decision.proposedBy,
                            })}</span>
                          </span>
                          {isProposed ? (
                            <button
                              className="accept-button"
                              type="button"
                              disabled={isAccepting}
                              onClick={() => void onAccept([decision.id])}
                            >
                              <CheckCircle2 size={17} />
                              {isAccepting ? t("记录中…") : t("接受此决策")}
                            </button>
                          ) : null}
                        </div>
                      </DecisionCard>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="empty-discussion">
              <AgentAvatar agent="council" />
              <div>
                <h2>{t("尚无拟议决策")}</h2>
                <p>{t("可以等待 Agent 提案，也可以由你直接记录结论并结束议题。")}</p>
                <button
                  className="primary-button manual-decision-entry"
                  type="button"
                  disabled={isRecordingManualDecision}
                  onClick={onRecordManualDecision}
                >
                  <FileCheck2 size={16} />
                  {t("记录人工决策")}
                </button>
              </div>
            </div>
          )}
        </section>
      ) : activeTab === "tasks" ? (
        <section
          className="topic-implementation-panel"
          id="tasks-tabpanel"
          role="tabpanel"
          aria-labelledby="tasks-tab"
          aria-label={t("实施任务")}
        >
          <ImplementationProgress
            topic={topic}
            participants={participants}
            busyAction={workItemBusyAction}
            onGenerate={onGenerateWorkItems}
            onAdd={onAddWorkItem}
            onUpdate={onUpdateWorkItem}
            onClaim={onClaimWorkItem}
            delegationAgents={delegationAgents}
            delegations={delegations}
            delegationBusyAction={delegationBusyAction}
            onDelegate={onDelegateWorkItem}
            onDelegateBatch={onDelegateWorkItems}
            onCancelDelegation={onCancelDelegation}
          />
        </section>
      ) : (
        <section
          className="topic-metadata-panel"
          id="metadata-tabpanel"
          role="tabpanel"
          aria-labelledby="metadata-tab"
          aria-label={t("议题元数据")}
        >
          <div className="metadata-field">
            <span className="metadata-label">{t("议题 ID")}</span>
            <div className="metadata-id-row">
              <code className="metadata-id-value">{topic.id}</code>
              <button
                className={`copy-id-button ${isIdCopied ? "is-copied" : ""}`}
                type="button"
                onClick={() => void handleCopyId()}
              >
                {isIdCopied ? <Check size={14} /> : <Copy size={14} />}
                <span>{isIdCopied ? t("已复制") : t("复制")}</span>
              </button>
            </div>
          </div>

          <div className="metadata-field">
            <span className="metadata-label">{t("完整问题描述")}</span>
            <div className="metadata-question-full">
              <MarkdownContent content={topic.question} />
            </div>
          </div>

          <div className="metadata-field-row">
            <div className="metadata-field">
              <span className="metadata-label">{t("创建时间")}</span>
              <span className="metadata-value">{topic.createdLabel}</span>
            </div>
            <div className="metadata-field">
              <span className="metadata-label">{t("最近更新")}</span>
              <span className="metadata-value">{topic.updatedLabel}</span>
            </div>
          </div>

          <div className="metadata-field">
            <span className="metadata-label">{t("所有者")}</span>
            <div className="metadata-people-row">
              <span className="metadata-person">
                <AgentAvatar agent={topic.owner} participant={owner} size="small" />
                <span>{owner?.name ?? topic.owner}</span>
              </span>
            </div>
          </div>

          <div className="metadata-field">
            <span className="metadata-label">{t("参与者")}</span>
            <div className="metadata-people-row">
              {topic.participants.map((agent) => (
                <span className="metadata-person" key={agent}>
                  <AgentAvatar
                    agent={agent}
                    participant={participants.get(agent)}
                    size="small"
                  />
                  <span>{participants.get(agent)?.name ?? agent}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="metadata-field-row">
            <div className="metadata-field">
              <span className="metadata-label">{t("已加载消息")}</span>
              <span className="metadata-value metadata-value-mono">{topic.messages.length}</span>
            </div>
            <div className="metadata-field">
              <span className="metadata-label">{t("消息总数")}</span>
              <span className="metadata-value metadata-value-mono">
                {topic.messageTotal ?? topic.messages.length}
              </span>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
