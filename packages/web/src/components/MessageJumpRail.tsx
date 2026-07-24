/**
 * @input  依赖：CouncilMessage 列表、当前消息 ID 与跳转回调
 * @output 导出：MessageJumpRail 一卡一节点的阶梯式消息快速导航
 * @pos    DiscussionPanel 讨论滚动区左侧的桌面快速定位入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilMessage } from "../types/council";
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
  if (messages.length === 0) {
    return null;
  }

  return (
    <nav className="message-jump-rail" aria-label="消息卡片快速导航">
      <ol className="message-jump-list">
        {messages.map((message, index) => {
          const author = message.author === "human" ? "User" : message.author;
          const label =
            `第 ${index + 1} 条 · ${author} · ${messageKindLabels[message.kind]} · ${message.title}`;
          return (
            <li key={message.id}>
              <button
                className={`message-jump-step step-${message.kind} stair-${
                  index % STAIR_STEP_COUNT
                } ${
                  activeMessageId === message.id ? "is-active" : ""
                }`}
                type="button"
                aria-label={`跳到${label}`}
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
