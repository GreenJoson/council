/**
 * @input  依赖：界面语言上下文、当前议题标题、保存状态与人工 Accepted 回调
 * @output 导出：不调用 Agent、直接结束议题的 Human Decision 对话框
 * @pos    决策页和右栏共用的人工签署入口；只收集公开结论与验证说明
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { CheckCircle2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";

export interface ManualDecisionDraft {
  title: string;
  summary: string;
  rationale: string;
}

export interface ManualDecisionDialogProps {
  isOpen: boolean;
  isRecording: boolean;
  topicTitle: string;
  onClose: () => void;
  onRecord: (draft: ManualDecisionDraft) => Promise<boolean>;
}

const DEFAULT_RATIONALE = "用户确认已在 Council 外完成实现、验证或部署，并手动结束此议题。";

export function ManualDecisionDialog({
  isOpen,
  isRecording,
  topicTitle,
  onClose,
  onRecord,
}: ManualDecisionDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(topicTitle);
  const [summary, setSummary] = useState("");
  const [rationale, setRationale] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (isOpen && !dialog.open) {
      setTitle(topicTitle);
      setSummary("");
      setRationale("");
      dialog.showModal();
    }
    if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen, topicTitle]);

  const canRecord =
    title.trim().length > 0
    && summary.trim().length > 0
    && !isRecording;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canRecord) {
      return;
    }
    const recorded = await onRecord({
      title: title.trim(),
      summary: summary.trim(),
      rationale: rationale.trim() || t(DEFAULT_RATIONALE),
    });
    if (recorded) {
      onClose();
    }
  }

  return (
    <dialog
      className="create-topic-dialog manual-decision-dialog"
      ref={dialogRef}
      aria-labelledby="manual-decision-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!isRecording) {
          onClose();
        }
      }}
      onClose={onClose}
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <header>
          <div>
            <span className="dialog-kicker">Human Decision</span>
            <h2 id="manual-decision-title">{t("记录结论并结束议题")}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={t("关闭")}
            disabled={isRecording}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="manual-decision-notice">
          <ShieldCheck size={18} />
          <div>
            <strong>{t("不会调用任何 Agent")}</strong>
            <span>{t("保存后直接写入 Accepted，并关闭该议题的圆桌、运行会话和继续回复入口。")}</span>
          </div>
        </div>

        <label>
          <span>{t("决策标题")}</span>
          <input
            value={title}
            disabled={isRecording}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("例如：修复已上线并完成验证")}
          />
        </label>
        <label>
          <span>{t("最终结论")}</span>
          <textarea
            autoFocus
            value={summary}
            disabled={isRecording}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={t("例如：问题已修复并部署，线上验证通过，本议题结束。")}
            rows={4}
          />
        </label>
        <label>
          <span>{t("验证 / 部署说明")} <small>{t("可选")}</small></span>
          <textarea
            value={rationale}
            disabled={isRecording}
            onChange={(event) => setRationale(event.target.value)}
            placeholder={t("记录版本、验证方式、回滚点或其他需要保留的证据。")}
            rows={3}
          />
        </label>

        <footer>
          <button
            className="secondary-button"
            type="button"
            disabled={isRecording}
            onClick={onClose}
          >
            {t("取消")}
          </button>
          <button className="primary-button" type="submit" disabled={!canRecord}>
            <CheckCircle2 size={17} />
            {isRecording ? t("正在结束议题…") : t("记录并结束议题")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
