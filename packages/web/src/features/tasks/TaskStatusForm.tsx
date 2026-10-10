/**
 * @input  依赖：界面语言、当前任务行、最近一次委派（决定是否预填说明）、忙碌态与提交回调、WORK_ITEM_STATUS_LABELS
 * @output 导出：TaskStatusForm —— 任务状态 + 说明 + 可选修复提交的更新表单
 * @pos    沿用讨论页 ImplementationProgress “保存进度”交互：受阻/完成必须填写证据；乐观版本由 use-task-detail 补齐
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useState } from "react";
import { WORK_ITEM_STATUS_LABELS } from "../../components/ImplementationProgress";
import { useI18n } from "../../i18n/I18nProvider";
import type { CouncilWorkItem, WorkItemStatus } from "../../types/council";
import type { WorkItemDelegation } from "../../types/orchestration";

export interface TaskStatusFormProps {
  task: CouncilWorkItem;
  latestDelegation?: WorkItemDelegation;
  isSaving: boolean;
  disabled: boolean;
  onSubmit: (input: { status: WorkItemStatus; statusNote?: string; fixCommit?: string }) => Promise<boolean>;
}

/** 调用方以 task.version 作 key：任务被别处更新后表单回到最新状态，避免基于旧值提交。 */
export function TaskStatusForm({ task, latestDelegation, isSaving, disabled, onSubmit }: TaskStatusFormProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<WorkItemStatus>(task.status);
  // 人工验收需要新填写的证据，不能把 Agent 摘要或旧说明预填成用户已确认的结果（与讨论页同一规则）。
  const [statusNote, setStatusNote] = useState(
    latestDelegation?.completionPolicy === "human" && task.status !== "completed" ? "" : task.statusNote ?? "",
  );
  const [fixCommit, setFixCommit] = useState(task.fixCommit ?? "");
  const evidenceRequired = status === "blocked" || status === "completed";
  const canSubmit = !disabled && !isSaving && (!evidenceRequired || statusNote.trim().length > 0);

  return (
    <form
      className="task-status-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        void onSubmit({
          status,
          ...(statusNote.trim() ? { statusNote: statusNote.trim() } : {}),
          ...(fixCommit.trim() ? { fixCommit: fixCommit.trim() } : {}),
        });
      }}
    >
      <label>
        <span>{t("任务状态")}</span>
        <select value={status} disabled={disabled || isSaving} onChange={(event) => setStatus(event.target.value as WorkItemStatus)}>
          {Object.entries(WORK_ITEM_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{t(label)}</option>
          ))}
        </select>
      </label>
      <label className="task-status-note">
        <span>{t("说明")}</span>
        <textarea
          maxLength={4000}
          rows={3}
          disabled={disabled || isSaving}
          placeholder={evidenceRequired ? t("填写完成证据或受阻原因（必填）") : t("补充当前进展（可选）")}
          value={statusNote}
          onChange={(event) => setStatusNote(event.target.value)}
        />
      </label>
      <label>
        <span>{t("修复提交（可选）")}</span>
        <input
          maxLength={200}
          disabled={disabled || isSaving}
          value={fixCommit}
          onChange={(event) => setFixCommit(event.target.value)}
        />
      </label>
      <div className="task-status-actions">
        <button className="primary-button" type="submit" disabled={!canSubmit}>
          {isSaving ? t("保存中…") : t("保存进度")}
        </button>
      </div>
    </form>
  );
}
