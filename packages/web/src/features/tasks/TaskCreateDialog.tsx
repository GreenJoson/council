/**
 * @input  依赖：界面语言、打开状态、TaskRepository.createTask、kind 文案与 P1 可建 kind 列表
 * @output 导出：TaskCreateDialog —— 原生 <dialog> 新建任务表单（标题必填、说明、kind、优先级）
 * @pos    任务列表的直接任务入口；创建成功把新行交给调用方（负责导航到 #/tasks/<id>），失败（含同项目重名 409）留在表单内显示
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getErrorMessage } from "../../data/error-message";
import type { TaskRepository } from "../../data/tasks/task-repository";
import { useI18n } from "../../i18n/I18nProvider";
import { WORK_ITEM_KINDS, type CouncilWorkItem, type WorkItemKind } from "../../types/council";
import { KIND_LABELS, P1_CREATABLE_KINDS } from "./task-labels";

export interface TaskCreateDialogProps {
  isOpen: boolean;
  repository: TaskRepository;
  onClose: () => void;
  onCreated: (task: CouncilWorkItem) => void;
}

export function TaskCreateDialog({ isOpen, repository, onClose, onCreated }: TaskCreateDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [kind, setKind] = useState<WorkItemKind>("code");
  const [priority, setPriority] = useState("0");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      setError(null);
      dialog.showModal();
    }
    if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const parsedPriority = Number(priority);
  const priorityValid = priority.trim() !== "" && Number.isInteger(parsedPriority);
  const canCreate = title.trim().length > 0 && priorityValid && !isCreating;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    setIsCreating(true);
    setError(null);
    try {
      const created = await repository.createTask({
        title: title.trim(),
        ...(details.trim() ? { details: details.trim() } : {}),
        kind,
        priority: parsedPriority,
      });
      setTitle("");
      setDetails("");
      setKind("code");
      setPriority("0");
      onCreated(created);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <dialog
      // 复用新建议题对话框的视觉（同一套表单骨架），task-create-dialog 只补充差异样式
      className="create-topic-dialog task-create-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-labelledby="task-create-title"
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <header>
          <div>
            <span className="dialog-kicker">{t("新建任务")}</span>
            <h2 id="task-create-title">{t("创建一条可委派的任务")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t("关闭")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <label>
          <span>{t("任务标题")}</span>
          <input
            autoFocus
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("例如：退款回调补齐签名校验")}
          />
        </label>
        <label>
          <span>{t("任务说明")} <small>{t("可选")}</small></span>
          <textarea
            maxLength={8000}
            rows={4}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder={t("实现范围、验收标准和前置依赖")}
          />
        </label>
        <div className="task-create-row">
          <label>
            <span>{t("任务类型")}</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as WorkItemKind)}>
              {WORK_ITEM_KINDS.map((value) => (
                <option key={value} value={value} disabled={!P1_CREATABLE_KINDS.includes(value)}>
                  {t(KIND_LABELS[value])}
                </option>
              ))}
            </select>
            <small>{t("当前仅支持代码任务；图片、原型、调研与流水线将在 P2 接入。")}</small>
          </label>
          <label>
            <span>{t("优先级")} <small>{t("越大越靠前")}</small></span>
            <input
              type="number"
              step={1}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </label>
        </div>
        {error ? <p className="task-notice is-danger" role="alert">{t(error)}</p> : null}
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>{t("取消")}</button>
          <button className="primary-button" type="submit" disabled={!canCreate}>
            <Plus size={17} />
            {isCreating ? t("创建中…") : t("创建任务")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
