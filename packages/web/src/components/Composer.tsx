/**
 * @input  依赖：当前消息类型、同步状态、发布状态、提交回调与引用回复种子
 * @output 导出：Composer 公开回复编辑器
 * @pos    将用户可见结论发布到共享 Council 时间线，并承接消息卡片发起的引用回复
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Link2, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MessageKind, SyncState } from "../types/council";
import { messageKindLabels } from "./presentation";

const composerKinds: MessageKind[] = ["proposal", "critique", "rebuttal", "synthesis"];

/** 引用回复种子：text 是待插入的引用文本，nonce 保证连续引用同一条消息也能重新触发插入 */
export interface QuoteSeed {
  text: string;
  nonce: number;
}

export interface ComposerProps {
  isPublishing: boolean;
  sync: SyncState;
  onPublish: (kind: MessageKind, content: string) => Promise<boolean>;
  quoteSeed?: QuoteSeed | null;
}

export function Composer({ isPublishing, sync, onPublish, quoteSeed }: ComposerProps) {
  const [kind, setKind] = useState<MessageKind>("rebuttal");
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appliedQuoteNonceRef = useRef<number | null>(null);

  // 引用回复：把消息卡片发起的引用文本追加到草稿开头，再聚焦并把光标移到末尾方便续写
  useEffect(() => {
    if (!quoteSeed || appliedQuoteNonceRef.current === quoteSeed.nonce) {
      return;
    }
    appliedQuoteNonceRef.current = quoteSeed.nonce;
    setContent((current) => `${quoteSeed.text}${current}`);
    const frameId = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(frameId);
  }, [quoteSeed]);

  const canPublish = content.trim().length > 0 && !isPublishing;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPublish) {
      return;
    }
    const published = await onPublish(kind, content.trim());
    if (published) {
      setContent("");
    }
  }

  return (
    <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
      <div className="composer-meta">
        <div className="kind-selector" aria-label="选择消息类型">
          {composerKinds.map((candidate) => (
            <button
              className={`kind-option kind-${candidate} ${kind === candidate ? "active" : ""}`}
              type="button"
              key={candidate}
              aria-pressed={kind === candidate}
              onClick={() => setKind(candidate)}
            >
              {messageKindLabels[candidate]}
            </button>
          ))}
        </div>
        <span className="shared-notice">
          <Link2 size={13} />
          {sync.label}
        </span>
      </div>

      <label>
        <span className="sr-only">公开回复内容</span>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="写下公开结论、证据或回应…"
          rows={4}
        />
      </label>

      <div className="composer-toolbar">
        <span className="composer-hint">⌘ Enter 快速发布</span>
        <button className="publish-button" type="submit" disabled={!canPublish}>
          <span>{isPublishing ? "发布中…" : `发布 ${messageKindLabels[kind]}`}</span>
          <Send size={16} />
        </button>
      </div>
    </form>
  );
}
