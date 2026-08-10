/**
 * @input  依赖：界面语言上下文、议题实施项、AI 任务规划能力、动态 Actor、手动补充与带证据的状态更新回调
 * @output 导出：右栏实施进度摘要，以及主区 AI 拆分、人工补充和证据化任务清单
 * @pos    Accepted 架构决策与外部 Codex/Claude 实际交付之间的可审计执行账本
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  AlertTriangle,
  Check,
  CircleDot,
  ListTodo,
  LoaderCircle,
  MessageSquarePlus,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { CouncilWorkItem, Participant, TopicDetail, WorkItemStatus } from "../types/council";
import { participantFromActorSnapshot } from "./presentation";

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  blocked: "受阻",
  completed: "已完成",
};

export interface ImplementationProgressProps {
  topic: TopicDetail;
  participants: Map<string, Participant>;
  busyAction: string | null;
  planningAgentLabel?: string;
  onGenerate: () => Promise<void>;
  onAdd: (title: string, details: string) => Promise<boolean>;
  onUpdate: (
    item: CouncilWorkItem,
    status: WorkItemStatus,
    statusNote: string,
  ) => Promise<void>;
}

export interface ImplementationSummaryProps {
  topic: TopicDetail;
}

function getImplementationStats(topic: TopicDetail) {
  const completed = topic.workItems.filter((item) => item.status === "completed").length;
  const blocked = topic.workItems.filter((item) => item.status === "blocked").length;
  const progress = topic.workItems.length === 0
    ? 0
    : Math.round((completed / topic.workItems.length) * 100);
  return { completed, blocked, progress };
}

export function ImplementationSummary({ topic }: ImplementationSummaryProps) {
  const { t } = useI18n();
  const { completed, blocked, progress } = getImplementationStats(topic);

  return (
    <section className="implementation-card" aria-labelledby="implementation-summary-heading">
      <header className="implementation-heading">
        <div>
          <span className="implementation-kicker"><ListTodo size={14} /> {t("实施进度")}</span>
          <strong id="implementation-summary-heading">
            {topic.workItems.length > 0 ? `${completed} / ${topic.workItems.length}` : t("尚无任务")}
          </strong>
        </div>
        <span className="implementation-percent">{progress}%</span>
      </header>

      <div
        className="implementation-progress-track"
        role="progressbar"
        aria-label={t("实施完成度")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      {blocked > 0 ? (
        <p className="implementation-alert"><AlertTriangle size={13} /> {t("{count} 项受阻，需先解除依赖", { count: blocked })}</p>
      ) : null}
      {topic.workItems.length === 0 ? (
        <p className="implementation-empty">{t("接受架构决策后，即可生成和跟踪实施计划。")}</p>
      ) : null}
    </section>
  );
}

export function ImplementationProgress({
  topic,
  participants,
  busyAction,
  planningAgentLabel,
  onGenerate,
  onAdd,
  onUpdate,
}: ImplementationProgressProps) {
  const { t } = useI18n();
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [nextStatus, setNextStatus] = useState<WorkItemStatus>("pending");
  const [statusNote, setStatusNote] = useState("");
  const { blocked } = getImplementationStats(topic);
  const canEdit = topic.decision?.status === "accepted";
  const isGenerating = busyAction === "generate";

  async function submit(): Promise<void> {
    if (!title.trim() || busyAction) {
      return;
    }
    if (await onAdd(title.trim(), details.trim())) {
      setTitle("");
      setDetails("");
      setIsAdding(false);
    }
  }

  function beginProgressUpdate(item: CouncilWorkItem): void {
    setEditingItemId(item.id);
    setNextStatus(item.status);
    setStatusNote(item.statusNote ?? "");
  }

  async function submitProgress(item: CouncilWorkItem): Promise<void> {
    const requiresEvidence = nextStatus === "blocked" || nextStatus === "completed";
    if (busyAction || (requiresEvidence && !statusNote.trim())) {
      return;
    }
    await onUpdate(item, nextStatus, statusNote.trim());
    setEditingItemId(null);
  }

  return (
    <section className="implementation-task-card" aria-labelledby="implementation-tasks-heading">
      <header className="implementation-task-heading">
        <div>
          <span className="implementation-kicker"><ListTodo size={14} /> {t("任务拆分")}</span>
          <strong id="implementation-tasks-heading">
            {topic.workItems.length > 0
              ? t("{count} 项可执行任务", { count: topic.workItems.length })
              : t("尚无任务")}
          </strong>
        </div>
      </header>

      {blocked > 0 ? (
        <p className="implementation-alert"><AlertTriangle size={13} /> {t("{count} 项受阻，需先解除依赖", { count: blocked })}</p>
      ) : null}

      {topic.workItems.length > 0 ? (
        <ol className="work-item-list">
          {topic.workItems.map((item) => {
            const updater = participantFromActorSnapshot(
              item.updatedBySnapshot,
              participants.get(item.updatedBy),
            );
            const updating = busyAction === `update:${item.id}`;
            const editing = editingItemId === item.id;
            const evidenceRequired = nextStatus === "blocked" || nextStatus === "completed";
            return (
              <li className={`work-item work-item-${item.status}`} key={item.id}>
                <div className="work-item-main">
                  <span className="work-item-marker" aria-hidden="true">
                    {item.status === "completed" ? <Check size={13} /> : <CircleDot size={12} />}
                  </span>
                  <div className="work-item-copy">
                    <strong>{item.title}</strong>
                    {item.details ? <p>{item.details}</p> : null}
                    {item.statusNote ? <blockquote>{item.statusNote}</blockquote> : null}
                    <small>{updater?.name ?? item.updatedBy} · {item.updatedLabel} · v{item.version}</small>
                  </div>
                  <button
                    type="button"
                    className="work-item-update-toggle"
                    disabled={Boolean(busyAction)}
                    aria-expanded={editing}
                    onClick={() => editing ? setEditingItemId(null) : beginProgressUpdate(item)}
                  >
                    <MessageSquarePlus size={12} /> {t(STATUS_LABELS[item.status])}
                  </button>
                </div>

                {editing ? (
                  <div className="work-item-update-form">
                    <select
                      aria-label={t("更新“{title}”的状态", { title: item.title })}
                      disabled={Boolean(busyAction)}
                      value={nextStatus}
                      onChange={(event) => setNextStatus(event.target.value as WorkItemStatus)}
                    >
                      {Object.entries(STATUS_LABELS).map(([status, label]) => (
                        <option key={status} value={status}>{t(label)}</option>
                      ))}
                    </select>
                    <textarea
                      maxLength={4000}
                      rows={2}
                      placeholder={evidenceRequired
                        ? t("填写完成证据或受阻原因（必填）")
                        : t("补充当前进展（可选）")}
                      value={statusNote}
                      onChange={(event) => setStatusNote(event.target.value)}
                    />
                    <div className="work-item-update-actions">
                      <button type="button" onClick={() => setEditingItemId(null)}>{t("取消")}</button>
                      <button
                        type="button"
                        disabled={Boolean(busyAction) || (evidenceRequired && !statusNote.trim())}
                        onClick={() => void submitProgress(item)}
                      >
                        {updating ? t("保存中…") : t("保存进度")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="implementation-empty">
          {canEdit
            ? t("让 AI 先把架构决策拆成可验证任务，也可以直接手动添加。")
            : t("接受架构决策后，即可生成和跟踪实施计划。")}
        </p>
      )}

      {isAdding ? (
        <div className="work-item-form">
          <div className="work-item-form-heading">
            <strong>{t("补充实施任务")}</strong>
            <button type="button" aria-label={t("取消新增实施任务")} onClick={() => setIsAdding(false)}><X size={14} /></button>
          </div>
          <input
            autoFocus
            maxLength={200}
            placeholder={t("可独立执行的任务")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            maxLength={8000}
            placeholder={t("实现范围、验收标准和前置依赖")}
            rows={3}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
          />
          <button className="work-item-submit" type="button" disabled={!title.trim() || Boolean(busyAction)} onClick={() => void submit()}>
            {busyAction === "add" ? t("添加中…") : t("添加到实施计划")}
          </button>
        </div>
      ) : canEdit ? (
        <div className="work-item-plan-actions">
          {planningAgentLabel ? (
            <button className="work-item-generate" type="button" disabled={Boolean(busyAction)} onClick={() => void onGenerate()}>
              {isGenerating ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />}
              {isGenerating
                ? t("{agent} 正在拆分…", { agent: planningAgentLabel })
                : topic.workItems.length > 0 ? t("AI 补充遗漏任务") : t("AI 拆分任务")}
            </button>
          ) : (
            <small className="work-item-agent-hint">{t("没有可用的规划 Agent，可先手动添加。")}</small>
          )}
          <button className="work-item-add" type="button" disabled={Boolean(busyAction)} onClick={() => setIsAdding(true)}>
            <Plus size={14} /> {t("手动添加任务")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
