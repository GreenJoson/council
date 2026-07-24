/**
 * @input  依赖：含 owner 冻结快照的当前议题、参与者回退、同步/发布状态、消息回调与自动轮次快照
 *         （驱动时间线 Agent 回复动态，并透传给 Composer 支撑 @agent 召唤）
 * @output 导出：DiscussionPanel 中央讨论工作区（可折叠议题摘要、讨论/元数据双 tab、
 *         卡片阶梯导航、活动 Agent 状态、引用回复发起）
 * @pos    Operator Console 的主要阅读、元数据核查和回复区域；过长议题问题默认收起
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CouncilMessage, MessageKind, Participant, SyncState, TopicDetail } from "../types/council";
import type { OrchestrationSnapshot } from "../types/orchestration";
import { AgentAvatar, participantFromActorSnapshot, StatusBadge } from "./presentation";
import {
  AgentReplyActivity,
  selectAgentReplyActivity,
} from "./AgentReplyActivity";
import { Composer, type MentionPublishRequest, type QuoteSeed } from "./Composer";
import { MarkdownContent } from "./MarkdownContent";
import { MessageCard } from "./MessageCard";
import { MessageJumpRail } from "./MessageJumpRail";

export interface DiscussionPanelProps {
  topic: TopicDetail;
  participants: Map<string, Participant>;
  sync: SyncState;
  isPublishing: boolean;
  onPublish: (kind: MessageKind, content: string, mention?: MentionPublishRequest) => Promise<boolean>;
  orchestration: OrchestrationSnapshot | null;
  orchestrationBusyAction: string | null;
}

type DiscussionTab = "discussion" | "metadata";

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
  topic,
  participants,
  sync,
  isPublishing,
  onPublish,
  orchestration,
  orchestrationBusyAction,
}: DiscussionPanelProps) {
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
              <span>创建于 {topic.createdLabel}</span>
              <span aria-hidden="true">·</span>
              <span>更新于 {topic.updatedLabel}</span>
            </div>
          </div>
          <div className="topic-participants" aria-label="议题参与者">
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
        <div className="topic-tabs" role="tablist" aria-label="议题视图">
          <button
            className={activeTab === "discussion" ? "active" : ""}
            type="button"
            role="tab"
            id="discussion-tab"
            aria-selected={activeTab === "discussion"}
            aria-controls="discussion-tabpanel"
            onClick={() => setActiveTab("discussion")}
          >
            讨论
            <span className="count-pill">{topic.messageTotal ?? topic.messages.length}</span>
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
            元数据
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
              aria-label="共享讨论时间线"
              ref={timelineRef}
            >
              {hiddenMessageCount > 0 ? (
                <p className="history-notice">
                  当前显示最近 {topic.messages.length} 条，另有 {hiddenMessageCount} 条历史消息。
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
                    <h2>议题已经准备好</h2>
                    <p>发布第一条 proposal，或让 Agent 读取此议题后提交公开方案。</p>
                  </div>
                </div>
              )}
              {agentReplyActivity ? (
                <AgentReplyActivity activity={agentReplyActivity} />
              ) : null}
            </section>
          </div>

          <Composer
            isPublishing={isPublishing}
            sync={sync}
            onPublish={onPublish}
            quoteSeed={quoteSeed}
            topicId={topic.id}
            orchestration={orchestration}
            orchestrationBusyAction={orchestrationBusyAction}
          />
        </>
      ) : (
        <section
          className="topic-metadata-panel"
          id="metadata-tabpanel"
          role="tabpanel"
          aria-labelledby="metadata-tab"
          aria-label="议题元数据"
        >
          <div className="metadata-field">
            <span className="metadata-label">议题 ID</span>
            <div className="metadata-id-row">
              <code className="metadata-id-value">{topic.id}</code>
              <button
                className={`copy-id-button ${isIdCopied ? "is-copied" : ""}`}
                type="button"
                onClick={() => void handleCopyId()}
              >
                {isIdCopied ? <Check size={14} /> : <Copy size={14} />}
                <span>{isIdCopied ? "已复制" : "复制"}</span>
              </button>
            </div>
          </div>

          <div className="metadata-field">
            <span className="metadata-label">完整问题描述</span>
            <div className="metadata-question-full">
              <MarkdownContent content={topic.question} />
            </div>
          </div>

          <div className="metadata-field-row">
            <div className="metadata-field">
              <span className="metadata-label">创建时间</span>
              <span className="metadata-value">{topic.createdLabel}</span>
            </div>
            <div className="metadata-field">
              <span className="metadata-label">最近更新</span>
              <span className="metadata-value">{topic.updatedLabel}</span>
            </div>
          </div>

          <div className="metadata-field">
            <span className="metadata-label">所有者</span>
            <div className="metadata-people-row">
              <span className="metadata-person">
                <AgentAvatar agent={topic.owner} participant={owner} size="small" />
                <span>{owner?.name ?? topic.owner}</span>
              </span>
            </div>
          </div>

          <div className="metadata-field">
            <span className="metadata-label">参与者</span>
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
              <span className="metadata-label">已加载消息</span>
              <span className="metadata-value metadata-value-mono">{topic.messages.length}</span>
            </div>
            <div className="metadata-field">
              <span className="metadata-label">消息总数</span>
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
