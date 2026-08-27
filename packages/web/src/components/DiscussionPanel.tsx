/**
 * @input  依赖：界面语言上下文、当前项目名、含 owner/实施任务冻结快照的当前议题、参与者回退、同步/发布状态、消息回调与自动轮次快照
 *         （驱动时间线 Agent 回复动态，并透传议题开放状态给 Composer 控制 @agent 召唤）
 * @output 导出：DiscussionPanel 中央工作区（讨论/决策/任务/元数据、人工签署、阶梯导航与引用回复）
 * @pos    Operator Console 的主要阅读、决策通读、任务执行、元数据核查和回复区域；过长议题问题默认
 *         收起；决策 tab 按主列流体宽度渲染全文，右栏经 decisionFocusNonce 切过来
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Check, CheckCircle2, Copy, FileCheck2 } from "lucide-react";
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
import type { OrchestrationSnapshot } from "../types/orchestration";
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
  planningAgentLabel?: string;
  onGenerateWorkItems: () => Promise<void>;
  onAddWorkItem: (title: string, details: string, parentId?: string) => Promise<boolean>;
  onUpdateWorkItem: (
    item: CouncilWorkItem,
    status: WorkItemStatus,
    statusNote: string,
  ) => Promise<void>;
  onClaimWorkItem: (item: CouncilWorkItem) => Promise<void>;
  isAccepting: boolean;
  onAccept: () => Promise<void> | void;
  isRecordingManualDecision: boolean;
  onRecordManualDecision: () => void;
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
  planningAgentLabel,
  onGenerateWorkItems,
  onAddWorkItem,
  onUpdateWorkItem,
  onClaimWorkItem,
  isAccepting,
  onAccept,
  isRecordingManualDecision,
  onRecordManualDecision,
  decisionFocusNonce,
}: DiscussionPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DiscussionTab>("discussion");
  const [quoteSeed, setQuoteSeed] = useState<QuoteSeed | null>(null);
  const [isIdCopied, setIsIdCopied] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState(topic.messages[0]?.id);
  const timelineRef = useRef<HTMLElement>(null);
  const shouldFollowTimelineRef = useRef(true);
  const quoteNonceRef = useRef(0);
  const copyResetTimeoutRef = useRef<number | undefined>(undefined);

  // 切换议题时回到"讨论" tab，避免带着上一个议题的元数据视图
  useEffect(() => {
    setActiveTab("discussion");
    setActiveMessageId(topic.messages[0]?.id);
    shouldFollowTimelineRef.current = false;
  }, [topic.id]);

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
  const decisionProposer = topic.decision
    ? participantFromActorSnapshot(
      topic.decision.proposedBySnapshot,
      participants.get(topic.decision.proposedBy),
    )
    : undefined;
  // 任务 tab 的计数必须和侧边栏、实施进度卡共用一套口径：都只数叶子。
  // 父任务的状态本来就是子任务算出来的，再进一次分母等于把同一件事记两次。
  const workItemProgress = topic.workItemProgress ?? summarizeWorkItemProgress(topic.workItems);
  const completedWorkItems = workItemProgress?.completed ?? 0;
  const totalWorkItems = workItemProgress?.total ?? 0;

  function handleQuote(message: CouncilMessage): void {
    quoteNonceRef.current += 1;
    setQuoteSeed({ text: buildQuoteText(message, participants), nonce: quoteNonceRef.current });
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
            {/* 只有 proposed 才亮点：已接受/已取代不是待办，不该一直催 */}
            {topic.decision?.status === "proposed" ? (
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
            allowAgentCalls={topic.status !== "decided"}
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
          {topic.decision ? (
            <DecisionCard decision={topic.decision}>
              <div className="topic-decision-actions">
                <span className="topic-decision-proposer">
                  <AgentAvatar
                    agent={topic.decision.proposedBy}
                    participant={decisionProposer}
                    size="small"
                  />
                  <span>{t("由 {name} 提出", { name: decisionProposer?.name ?? topic.decision.proposedBy })}</span>
                </span>
                <button
                  className="accept-button"
                  type="button"
                  disabled={topic.decision.status !== "proposed" || isAccepting}
                  onClick={() => void onAccept()}
                >
                  <CheckCircle2 size={17} />
                  {topic.decision.status === "accepted"
                    ? t("决策已接受")
                    : topic.decision.status === "superseded"
                      ? t("决策已被取代")
                      : isAccepting
                        ? t("记录中…")
                        : t("标记为 Accepted")}
                </button>
                {topic.decision.status === "proposed" ? (
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
              </div>
            </DecisionCard>
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
            planningAgentLabel={planningAgentLabel}
            onGenerate={onGenerateWorkItems}
            onAdd={onAddWorkItem}
            onUpdate={onUpdateWorkItem}
            onClaim={onClaimWorkItem}
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
