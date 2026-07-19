/**
 * @input  依赖：当前消息类型、发布状态和提交回调
 * @output 导出：Composer 公开回复编辑器
 * @pos    将用户可见结论发布到共享 Council 时间线
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AtSign, Link2, List, Paperclip, Send } from "lucide-react";
import { useState } from "react";
import type { MessageKind } from "../types/council";
import { messageKindLabels } from "./presentation";

const composerKinds: MessageKind[] = ["proposal", "critique", "rebuttal", "synthesis"];

export interface ComposerProps {
  isPublishing: boolean;
  onPublish: (kind: MessageKind, content: string) => Promise<void>;
}

export function Composer({ isPublishing, onPublish }: ComposerProps) {
  const [kind, setKind] = useState<MessageKind>("rebuttal");
  const [content, setContent] = useState("");

  const canPublish = content.trim().length > 0 && !isPublishing;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPublish) {
      return;
    }
    await onPublish(kind, content.trim());
    setContent("");
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
          Mock 数据 · API 接入后自动同步
        </span>
      </div>

      <label>
        <span className="sr-only">公开回复内容</span>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="写下公开结论、证据或回应…"
          rows={4}
        />
      </label>

      <div className="composer-toolbar">
        <div>
          <button className="icon-button compact" type="button" aria-label="添加附件">
            <Paperclip size={17} />
          </button>
          <button className="icon-button compact" type="button" aria-label="提及参与者">
            <AtSign size={17} />
          </button>
          <button className="icon-button compact" type="button" aria-label="添加列表">
            <List size={17} />
          </button>
        </div>
        <button className="publish-button" type="submit" disabled={!canPublish}>
          <span>{isPublishing ? "发布中…" : `发布 ${messageKindLabels[kind]}`}</span>
          <Send size={16} />
        </button>
      </div>
    </form>
  );
}
