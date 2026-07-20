/**
 * @input  依赖：CouncilMessage、参与者资料、引用回复回调与 MarkdownContent
 * @output 导出：MessageCard 讨论时间线卡片
 * @pos    展示 Agent 公开方案、批评、回应和综合结论（内容按 Markdown 渲染并可折叠），并发起引用回复
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Reply } from "lucide-react";
import type { CouncilMessage, Participant } from "../types/council";
import { MarkdownContent } from "./MarkdownContent";
import { AgentAvatar, messageKindLabels } from "./presentation";

export interface MessageCardProps {
  message: CouncilMessage;
  participant?: Participant;
  index: number;
  /** 点击"引用回复"时把这条消息交给 Composer 生成引用草稿 */
  onQuote: (message: CouncilMessage) => void;
}

export function MessageCard({ message, participant, index, onQuote }: MessageCardProps) {
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
            <button
              className="icon-button compact"
              type="button"
              aria-label="引用回复"
              title="引用回复"
              onClick={() => onQuote(message)}
            >
              <Reply size={16} />
            </button>
          </div>
        </header>
        <span className={`kind-badge kind-${message.kind}`}>
          {messageKindLabels[message.kind]}
        </span>
        <h2>{message.title}</h2>
        <MarkdownContent content={message.content} collapsible />
      </div>
    </article>
  );
}
