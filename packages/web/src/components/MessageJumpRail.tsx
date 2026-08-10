/**
 * @input  依赖：界面语言上下文、CouncilMessage 列表、当前消息 ID 与跳转回调
 * @output 导出：MessageJumpRail 一卡一节点的阶梯式消息快速导航
 * @pos    DiscussionPanel 讨论滚动区左侧的桌面快速定位入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useLayoutEffect, useRef } from "react";
import type { CouncilMessage } from "../types/council";
import { useI18n } from "../i18n/I18nProvider";
import { messageKindLabels } from "./presentation";

export interface MessageJumpRailProps {
  messages: CouncilMessage[];
  activeMessageId?: string;
  onSelect: (messageId: string) => void;
}

const STAIR_STEP_COUNT = 4;

export function MessageJumpRail({
  messages,
  activeMessageId,
  onSelect,
}: MessageJumpRailProps) {
  const { t } = useI18n();
  const railRef = useRef<HTMLElement>(null);

  /*
   * 议题一长，梯子就装不下所有格，自己变成一个滚动容器。让它跟着当前消息
   * 走：滚时间线到底，最后一格自然被带进视野，用户不必再去单独拖梯子——
   * 那正是"拉不到最底下"的来源。只在越界时补最小位移，避免抢走手动滚动。
   */
  useLayoutEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>(".message-jump-step.is-active");
    if (!rail || !active) {
      return;
    }
    /*
     * 交给 block: "nearest"：已经看得见就不动，看不见才补最小位移。自己拿
     * offsetTop 算过一版，offsetParent 是 ol 不是 nav，坐标系对不上；改用
     * 矩形又要处理"可视高度比一格还矮"这种退化情形——都是浏览器已经定义好
     * 的边界，没必要在这里重写一遍。
     */
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeMessageId]);

  if (messages.length === 0) {
    return null;
  }

  return (
    <nav className="message-jump-rail" aria-label={t("消息卡片快速导航")} ref={railRef}>
      <ol className="message-jump-list">
        {messages.map((message, index) => {
          const author = message.author === "human" ? "User" : message.author;
          const label = t("第 {index} 条 · {author} · {kind} · {title}", {
            index: index + 1,
            author,
            kind: messageKindLabels[message.kind],
            title: message.title,
          });
          return (
            <li key={message.id}>
              <button
                className={`message-jump-step step-${message.kind} stair-${
                  index % STAIR_STEP_COUNT
                } ${
                  activeMessageId === message.id ? "is-active" : ""
                }`}
                type="button"
                aria-label={t("跳到{label}", { label })}
                aria-current={activeMessageId === message.id ? "true" : undefined}
                title={label}
                onClick={() => onSelect(message.id)}
              >
                <span aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
