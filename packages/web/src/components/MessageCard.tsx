/**
 * @input  依赖：带冻结 Actor 快照的 CouncilMessage、参与者回退资料、引用回复回调、MarkdownContent 与
 *         data/mention-parser 的 extractLeadingMentionChip
 * @output 导出：MessageCard 讨论时间线卡片
 * @pos    展示 Agent 公开方案、批评、回应和综合结论（内容按 Markdown 渲染并可折叠），并发起引用回复；
 *         正文以已知 Agent 召唤标记开头时（Composer 发布的指令性 note），把该标记抠出渲染成
 *         高亮芯片，其余正文照常交给 MarkdownContent
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Reply } from "lucide-react";
import { extractLeadingMentionChip } from "../data/mention-parser";
import type { CouncilMessage, Participant } from "../types/council";
import { MarkdownContent } from "./MarkdownContent";
import { AgentAvatar, messageKindLabels } from "./presentation";

export interface MessageCardProps {
  message: CouncilMessage;
  participant?: Participant;
  index: number;
  elementId?: string;
  /** 点击"引用回复"时把这条消息交给 Composer 生成引用草稿 */
  onQuote: (message: CouncilMessage) => void;
}

export function MessageCard({
  message,
  participant,
  index,
  elementId,
  onQuote,
}: MessageCardProps) {
  const mentionChip = extractLeadingMentionChip(message.content);
  const frozenParticipant: Participant = {
    id: message.actorSnapshot.actorId,
    slug: message.actorSnapshot.slug,
    name: message.actorSnapshot.displayName,
    shortName: message.actorSnapshot.shortName,
    role: message.actorSnapshot.role,
  };

  return (
    <article
      id={elementId}
      className={`message-card message-${message.kind}`}
      data-message-id={message.id}
      style={{ "--message-index": index } as React.CSSProperties}
    >
      <div className="timeline-avatar">
        <AgentAvatar agent={message.author} participant={frozenParticipant} />
      </div>
      <div className="message-surface">
        <header className="message-header">
          <div>
            <strong>{message.actorSnapshot.displayName || participant?.name || message.author}</strong>
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
        {mentionChip ? (
          <span className={`mention-chip mention-chip-${mentionChip.token}`}>
            @{mentionChip.token}
          </span>
        ) : null}
        <MarkdownContent content={mentionChip ? mentionChip.remainder : message.content} collapsible />
      </div>
    </article>
  );
}
