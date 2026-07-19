/**
 * @input  依赖：CouncilMessage 与参与者资料
 * @output 导出：MessageCard 讨论时间线卡片
 * @pos    展示 Agent 公开方案、批评、回应和综合结论
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Bookmark, FileText, MoreHorizontal, Reply } from "lucide-react";
import type { CouncilMessage, Participant } from "../types/council";
import { AgentAvatar, messageKindLabels } from "./presentation";

export interface MessageCardProps {
  message: CouncilMessage;
  participant?: Participant;
  index: number;
}

export function MessageCard({ message, participant, index }: MessageCardProps) {
  return (
    <article
      className={`message-card message-${message.kind}`}
      style={{ "--message-index": index } as React.CSSProperties}
    >
      <div className="timeline-avatar">
        <AgentAvatar agent={message.author} />
      </div>
      <div className="message-surface">
        <header className="message-header">
          <div>
            <strong>{participant?.name ?? message.author}</strong>
            <span>{message.createdLabel}</span>
          </div>
          <div className="message-actions">
            <button className="icon-button compact" type="button" aria-label="回复消息">
              <Reply size={16} />
            </button>
            <button className="icon-button compact" type="button" aria-label="收藏消息">
              <Bookmark size={16} />
            </button>
            <button className="icon-button compact" type="button" aria-label="更多消息操作">
              <MoreHorizontal size={16} />
            </button>
          </div>
        </header>
        <span className={`kind-badge kind-${message.kind}`}>
          {messageKindLabels[message.kind]}
        </span>
        <h2>{message.title}</h2>
        <p>{message.content}</p>
        {message.attachment ? (
          <button className="attachment-chip" type="button">
            <FileText size={17} />
            <span>
              <strong>{message.attachment.name}</strong>
              <small>{message.attachment.meta}</small>
            </span>
          </button>
        ) : null}
      </div>
    </article>
  );
}
