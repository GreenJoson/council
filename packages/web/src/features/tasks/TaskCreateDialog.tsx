/**
 * @input  依赖：界面语言、打开状态、TaskRepository.createTask、kind 文案与可建 kind 列表、BriefEditor 与 brief-form
 * @output 导出：TaskCreateDialog —— 原生 <dialog> 新建任务表单（标题必填、说明、kind、优先级；
 *         image 任务可勾选「附带简报」用 BriefEditor 编写 council-brief，本地校验通过才提交）
 * @pos    任务列表的直接任务入口，也由 App 壳从讨论编辑器「派任务」打开并以 initialTitle 带入草稿首行；
 *         创建成功把新行交给调用方（负责导航到 #/tasks/<id>），失败（含同项目重名 409）留在表单内显示
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getErrorMessage } from "../../data/error-message";
import type { TaskRepository } from "../../data/tasks/task-repository";
import { useI18n } from "../../i18n/I18nProvider";
import { WORK_ITEM_KINDS, type CouncilWorkItem, type WorkItemKind } from "../../types/council";
import { BriefEditor } from "./BriefEditor";
import { createBriefDraft, resolveBriefDraft, type BriefDraft } from "./brief-form";
import type { BriefIssue } from "../../data/tasks/council-brief";
import { CREATABLE_KINDS, KIND_LABELS } from "./task-labels";

export interface TaskCreateDialogProps {
  isOpen: boolean;
  repository: TaskRepository;
  /** 打开瞬间预填的标题（讨论编辑器草稿首行）；只在从关到开时应用，不覆盖用户已改的输入 */
  initialTitle?: string;
  onClose: () => void;
  onCreated: (task: CouncilWorkItem) => void;
}

export function TaskCreateDialog({ isOpen, repository, initialTitle, onClose, onCreated }: TaskCreateDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [kind, setKind] = useState<WorkItemKind>("code");
  const [priority, setPriority] = useState("0");
  // 简报只对 image 任务开放；草稿在切走 kind 时保留，提交时只在 image + 勾选时带上。
  const [withBrief, setWithBrief] = useState(false);
  const [briefDraft, setBriefDraft] = useState<BriefDraft>(() => createBriefDraft());
  const [briefIssues, setBriefIssues] = useState<BriefIssue[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      setError(null);
      if (initialTitle) setTitle(initialTitle);
      dialog.showModal();
    }
    if (!isOpen && dialog.open) {
      dialog.close();
    }
    // initialTitle 只在打开瞬间读一次，刻意不作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const parsedPriority = Number(priority);
  const priorityValid = priority.trim() !== "" && Number.isInteger(parsedPriority);
  const canCreate = title.trim().length > 0 && priorityValid && !isCreating;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    let brief: Record<string, unknown> | undefined;
    if (kind === "image" && withBrief) {
      const resolved = resolveBriefDraft(briefDraft);
      setBriefIssues(resolved.issues);
      if (!resolved.brief) return;
      brief = resolved.brief as unknown as Record<string, unknown>;
    }
    setIsCreating(true);
    setError(null);
    try {
      const created = await repository.createTask({
        title: title.trim(),
        ...(details.trim() ? { details: details.trim() } : {}),
        kind,
        priority: parsedPriority,
        ...(brief ? { brief } : {}),
      });
      setTitle("");
      setDetails("");
      setKind("code");
      setPriority("0");
      setWithBrief(false);
      setBriefDraft(createBriefDraft());
      setBriefIssues([]);
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
                <option key={value} value={value} disabled={!CREATABLE_KINDS.includes(value)}>
                  {t(KIND_LABELS[value])}
                </option>
              ))}
            </select>
            <small>{t("当前支持代码与图像任务；原型、调研与流水线将在后续阶段接入。")}</small>
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
        {kind === "image" ? (
          <label className="brief-checkbox">
            <input type="checkbox" checked={withBrief} onChange={(event) => setWithBrief(event.target.checked)} />
            <span>{t("附带简报")} <small>{t("可选，也可创建后在详情页编写")}</small></span>
          </label>
        ) : null}
        {kind === "image" && withBrief ? (
          <BriefEditor draft={briefDraft} onChange={setBriefDraft} issues={briefIssues} disabled={isCreating} />
        ) : null}
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
