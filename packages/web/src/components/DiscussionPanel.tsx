/**
 * @input  依赖：当前议题、参与者、发布状态与消息回调
 * @output 导出：DiscussionPanel 中央讨论工作区
 * @pos    Operator Console 的主要阅读和回复区域
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { MoreHorizontal, Star, Users } from "lucide-react";
import type { MessageKind, Participant, TopicDetail } from "../types/council";
import { AgentAvatar, StatusBadge } from "./presentation";
import { Composer } from "./Composer";
import { MessageCard } from "./MessageCard";

export interface DiscussionPanelProps {
  topic: TopicDetail;
  participants: Map<string, Participant>;
  isPublishing: boolean;
  onPublish: (kind: MessageKind, content: string) => Promise<void>;
}

export function DiscussionPanel({
  topic,
  participants,
  isPublishing,
  onPublish,
}: DiscussionPanelProps) {
  return (
    <main className="discussion-panel" id="main-content" tabIndex={-1}>
      <header className="topic-header">
        <div className="topic-heading-row">
          <div>
            <div className="topic-title-line">
              <h1>{topic.title}</h1>
              <button className="icon-button compact" type="button" aria-label="收藏议题">
                <Star size={18} />
              </button>
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
              <AgentAvatar agent={agent} key={agent} size="small" />
            ))}
            <button className="icon-button compact" type="button" aria-label="邀请参与者">
              <Users size={17} />
            </button>
            <button className="icon-button compact" type="button" aria-label="更多议题操作">
              <MoreHorizontal size={18} />
            </button>
          </div>
        </div>
        <p className="topic-question">{topic.question}</p>
        <div className="topic-tabs" role="tablist" aria-label="议题视图">
          <button className="active" type="button" role="tab" aria-selected="true">
            讨论
          </button>
          <button type="button" role="tab" aria-selected="false">
            元数据
          </button>
          <button type="button" role="tab" aria-selected="false">
            变更记录
            <span className="count-pill">{topic.messages.length}</span>
          </button>
        </div>
      </header>

      <section className="message-timeline" aria-label="共享讨论时间线">
        {topic.messages.length > 0 ? (
          topic.messages.map((message, index) => (
            <MessageCard
              message={message}
              participant={participants.get(message.author)}
              index={index}
              key={message.id}
            />
          ))
        ) : (
          <div className="empty-discussion">
            <AgentAvatar agent="chair" />
            <div>
              <h2>议题已经准备好</h2>
              <p>发布第一条 proposal，或让 Agent 读取此议题后提交公开方案。</p>
            </div>
          </div>
        )}
      </section>

      <Composer isPublishing={isPublishing} onPublish={onPublish} />
    </main>
  );
}
