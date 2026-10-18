/**
 * @input  依赖：界面语言上下文、带冻结 Actor 快照的 CouncilMessage、参与者回退资料、引用回复与派活回调、MarkdownContent、
 *         召唤标记、结构化关联提交与派活尾块解析、PipelineDispatchCard
 * @output 导出：含项目文件链接、关联提交证据卡与派活方案卡的 MessageCard 讨论时间线卡片
 * @pos    展示 Agent 公开方案、批评、回应和综合结论（内容按 Markdown 渲染并可折叠），并发起引用回复；
 *         正文以已知 Agent 召唤标记开头时（Composer 发布的指令性 note，可连写多个做同题盲答），把这些标记抠出渲染成
 *         高亮芯片，其余正文照常交给 MarkdownContent；正文带 council-dispatch 尾块时从正文去掉原始 JSON，
 *         改为派活方案卡，人点「按此起流水线」才开工
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { GitCommitHorizontal, Reply } from "lucide-react";
import { extractCommitAssociation } from "../../data/commit-association";
import { extractLeadingMentionChips } from "../../data/mention-parser";
import { extractDispatchBlock } from "../../data/pipelines/dispatch-block";
import type { CouncilMessage, Participant } from "../../types/council";
import { useI18n } from "../../i18n/I18nProvider";
import { MarkdownContent } from "../../components/MarkdownContent";
import { AgentAvatar, messageKindLabels } from "../../components/presentation";
import { PipelineDispatchCard } from "./PipelineDispatchCard";

export interface MessageCardProps {
  topicId?: string;
  message: CouncilMessage;
  participant?: Participant;
  index: number;
  elementId?: string;
  /** 点击"引用回复"时把这条消息交给 Composer 生成引用草稿 */
  onQuote: (message: CouncilMessage) => void;
  /** 点击派活方案卡的「按此起流水线」；未提供时方案卡只展示不带按钮 */
  onDispatchPipeline?: () => Promise<void>;
}

export function MessageCard({
  message,
  participant,
  index,
  elementId,
  onQuote,
  onDispatchPipeline,
  topicId,
}: MessageCardProps) {
  const { t } = useI18n();
  const commitAssociation = extractCommitAssociation(message.content);
  const dispatchBlock = extractDispatchBlock(commitAssociation?.body ?? message.content);
  const visibleContent = dispatchBlock?.body ?? commitAssociation?.body ?? message.content;
  const mentionChips = extractLeadingMentionChips(visibleContent);
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
              aria-label={t("引用回复")}
              title={t("引用回复")}
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
        {mentionChips?.tokens.map((token) => (
          <span key={token} className={`mention-chip mention-chip-${token}`}>
            @{token}
          </span>
        ))}
        {(mentionChips ? mentionChips.remainder : visibleContent) ? (
          <MarkdownContent content={mentionChips ? mentionChips.remainder : visibleContent} topicId={topicId} collapsible />
        ) : null}
        {dispatchBlock ? (
          <PipelineDispatchCard
            dispatch={dispatchBlock.dispatch}
            problem={dispatchBlock.problem}
            onDispatch={onDispatchPipeline}
          />
        ) : null}
        {commitAssociation ? (
          <aside className="commit-association-card" aria-label={t("关联提交")}>
            <div className="commit-association-card-heading">
              <GitCommitHorizontal size={15} />
              <strong>{t("关联提交")}</strong>
              <span>{t("{count} 个提交", { count: commitAssociation.targets.length })}</span>
            </div>
            <ul>
              {commitAssociation.targets.map((target) => (
                <li key={`${target.repository}:${target.commit}`}>
                  <span>{target.repository === "." ? t("当前项目") : target.repository}</span>
                  <code>{target.commit}</code>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
      </div>
    </article>
  );
}
