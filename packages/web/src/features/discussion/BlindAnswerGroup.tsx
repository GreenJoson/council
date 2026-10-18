/**
 * @input  依赖：界面语言上下文、同题盲答分组与互评指令（data/blind-answers）、召唤名、编排 Adapter 列表、MessageCard
 * @output 导出：BlindAnswerGroupView（同一道题的多个 Agent 回答并排展示，附状态与「让他们互评」按钮）
 * @pos    讨论时间线里替代逐条平铺的盲答展示：DiscussionPanel 把组内回答从普通流里摘出、放到请求消息后面；
 *         「让他们互评」复用 Composer 的发布 + @ 召唤链路（onPublish），不另开接口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useState } from "react";
import { LoaderCircle, Scale } from "lucide-react";
import {
  type BlindAnswerGroup,
  buildBlindReviewInstructions,
} from "../../data/blind-answers";
import { getMentionToken } from "../../data/mention-parser";
import { useI18n } from "../../i18n/I18nProvider";
import type { CouncilMessage, MessageKind, Participant } from "../../types/council";
import type { OrchestrationAdapter } from "../../types/orchestration";
import type { MentionPublishRequest } from "./Composer";
import { MessageCard } from "./MessageCard";

const OPEN_STATUSES = new Set(["idle", "running", "waiting_agent", "waiting_user"]);

export interface BlindAnswerGroupViewProps {
  topicId: string;
  group: BlindAnswerGroup;
  adapters: readonly OrchestrationAdapter[];
  participants: Map<string, Participant>;
  /** 组内第一张回答卡在时间线里的序号，沿用消息卡的入场动画节奏 */
  index: number;
  elementIdOf: (messageId: string) => string;
  onQuote: (message: CouncilMessage) => void;
  onDispatchPipeline?: (messageId: string) => Promise<void>;
  /** 互评发不出去的原因（中文文案键：议题已决、已有活动 Run、编排离线等）；缺省表示可以 */
  reviewBlockedReason?: string;
  isPublishing: boolean;
  onPublish: (kind: MessageKind, content: string, mention?: MentionPublishRequest) => Promise<boolean>;
}

export function BlindAnswerGroupView({
  topicId,
  group,
  adapters,
  participants,
  index,
  elementIdOf,
  onQuote,
  onDispatchPipeline,
  reviewBlockedReason,
  isPublishing,
  onPublish,
}: BlindAnswerGroupViewProps) {
  const { t } = useI18n();
  const [isRequesting, setIsRequesting] = useState(false);
  const adapterOf = (adapterId: string) => adapters.find((adapter) => adapter.id === adapterId);
  const labelOf = (adapterId: string) => adapterOf(adapterId)?.label ?? adapterId;
  const { run } = group;
  const isOpen = OPEN_STATUSES.has(run.status);
  const answeredCount = group.slots.filter((slot) => slot.message).length;
  const allAnswered = answeredCount === group.slots.length;
  const unavailable = group.slots.map((slot) => adapterOf(slot.adapterId)).find((adapter) => !adapter?.available);

  const statusText = run.status === "completed"
    ? t("已完成")
    : run.status === "cancelled"
      ? t("已取消")
      : run.status === "failed"
        ? t("没有全部完成")
        : run.status === "waiting_user"
          ? t("等待你确认")
          : t("作答中 {done}/{total}", { done: answeredCount, total: group.slots.length });

  const blockedReason = reviewBlockedReason
    ? t(reviewBlockedReason)
    : unavailable === undefined
      ? undefined
      : t("{agent} 当前不能被 Web 主动调用。", { agent: unavailable?.label ?? t("Agent") });
  const canOfferReview = !group.isReview && !group.hasReview && allAnswered && run.status === "completed";

  async function requestReview(): Promise<void> {
    if (blockedReason || isPublishing || isRequesting) {
      return;
    }
    const adapterIds = group.slots.map((slot) => slot.adapterId);
    const tokens = adapterIds.map((adapterId) => {
      const adapter = adapterOf(adapterId);
      return `@${adapter ? getMentionToken(adapter) : adapterId}`;
    });
    const instruction = t("请互评上面这组同题盲答：各自点评对方的方案，再说哪版更好、为什么。");
    setIsRequesting(true);
    try {
      await onPublish("note", `${tokens.join(" ")} ${instruction}`, {
        adapterIds,
        instruction,
        responseKind: "critique",
        instructions: buildBlindReviewInstructions(group, labelOf),
      });
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <section
      className={`blind-answer-group ${group.isReview ? "is-review" : ""}`}
      aria-label={group.isReview ? t("互评") : t("同题盲答")}
      data-run-id={run.id}
    >
      <header className="blind-answer-group-header">
        <Scale size={15} />
        <strong>{group.isReview ? t("互评") : t("同题盲答")}</strong>
        <span className="blind-answer-group-agents">
          {group.slots.map((slot) => labelOf(slot.adapterId)).join(" vs ")}
        </span>
        <span className={`blind-answer-group-status status-${run.status}`}>{statusText}</span>
      </header>
      <div className="blind-answer-group-grid">
        {group.slots.map((slot, slotIndex) =>
          slot.message ? (
            <MessageCard
              key={slot.message.id}
              topicId={topicId}
              message={slot.message}
              participant={participants.get(slot.message.author)}
              index={index + slotIndex}
              elementId={elementIdOf(slot.message.id)}
              onQuote={onQuote}
              onDispatchPipeline={onDispatchPipeline
                ? () => onDispatchPipeline(slot.message?.id ?? "")
                : undefined}
            />
          ) : (
            <div key={slot.adapterId} className="blind-answer-placeholder" data-adapter-id={slot.adapterId}>
              {isOpen ? <LoaderCircle size={15} className="spin" /> : null}
              <span>
                {!isOpen
                  ? t("{agent} 这轮没有作答", { agent: labelOf(slot.adapterId) })
                  : run.activeAgentId === slot.adapterId
                    ? t("{agent} 正在作答…", { agent: labelOf(slot.adapterId) })
                    : t("{agent} 排队作答，看不到其他人的回答", { agent: labelOf(slot.adapterId) })}
              </span>
            </div>
          ))}
      </div>
      {group.hasReview && !group.isReview ? (
        <p className="blind-answer-group-note">{t("已发起互评，见下方")}</p>
      ) : canOfferReview ? (
        <footer className="blind-answer-group-footer">
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(blockedReason) || isPublishing || isRequesting}
            aria-busy={isRequesting}
            onClick={() => void requestReview()}
          >
            {isRequesting ? <LoaderCircle size={15} className="spin" /> : <Scale size={15} />}
            {t("让他们互评")}
          </button>
          <span className="blind-answer-group-note">
            {blockedReason ?? t("每位 Agent 评审对方的回答，并说哪版更好")}
          </span>
        </footer>
      ) : null}
    </section>
  );
}
