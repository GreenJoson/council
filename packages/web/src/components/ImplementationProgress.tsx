/**
 * @input  依赖：议题实施项、动态 Actor 展示、添加/状态更新回调与写入忙碌状态
 * @output 导出：由离散任务状态自动汇总的实施进度卡片
 * @pos    Accepted 决策与外部 Codex/Claude 实际交付之间的可审计执行账本
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, Check, CircleDot, ListTodo, Plus, X } from "lucide-react";
import { useState } from "react";
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
  onAdd: (title: string, details: string) => Promise<boolean>;
  onUpdate: (item: CouncilWorkItem, status: WorkItemStatus) => Promise<void>;
}

export function ImplementationProgress({
  topic,
  participants,
  busyAction,
  onAdd,
  onUpdate,
}: ImplementationProgressProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const completed = topic.workItems.filter((item) => item.status === "completed").length;
  const blocked = topic.workItems.filter((item) => item.status === "blocked").length;
  const progress = topic.workItems.length === 0
    ? 0
    : Math.round((completed / topic.workItems.length) * 100);
  const canAdd = topic.decision?.status === "accepted";

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

  return (
    <section className="implementation-card" aria-labelledby="implementation-heading">
      <header className="implementation-heading">
        <div>
          <span className="implementation-kicker"><ListTodo size={14} /> 实施进度</span>
          <strong id="implementation-heading">
            {topic.workItems.length > 0 ? `${completed} / ${topic.workItems.length}` : "尚未拆分"}
          </strong>
        </div>
        <span className="implementation-percent">{progress}%</span>
      </header>

      <div
        className="implementation-progress-track"
        role="progressbar"
        aria-label="实施完成度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      {blocked > 0 ? (
        <p className="implementation-alert"><AlertTriangle size={13} /> {blocked} 项受阻，需先解除依赖</p>
      ) : null}

      {topic.workItems.length > 0 ? (
        <ol className="work-item-list">
          {topic.workItems.map((item) => {
            const updater = participantFromActorSnapshot(
              item.updatedBySnapshot,
              participants.get(item.updatedBy),
            );
            const updating = busyAction === `update:${item.id}`;
            return (
              <li className={`work-item work-item-${item.status}`} key={item.id}>
                <span className="work-item-marker" aria-hidden="true">
                  {item.status === "completed" ? <Check size={13} /> : <CircleDot size={12} />}
                </span>
                <div className="work-item-copy">
                  <strong>{item.title}</strong>
                  {item.details ? <p>{item.details}</p> : null}
                  {item.statusNote ? <blockquote>{item.statusNote}</blockquote> : null}
                  <small>{updater?.name ?? item.updatedBy} · {item.updatedLabel} · v{item.version}</small>
                </div>
                <select
                  aria-label={`更新“${item.title}”的状态`}
                  className="work-item-status-select"
                  disabled={Boolean(busyAction)}
                  value={item.status}
                  onChange={(event) => void onUpdate(item, event.target.value as WorkItemStatus)}
                >
                  {Object.entries(STATUS_LABELS).map(([status, label]) => (
                    <option key={status} value={status}>{label}</option>
                  ))}
                </select>
                {updating ? <span className="work-item-saving">保存中…</span> : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="implementation-empty">
          {canAdd ? "把已接受的架构决策拆成可验证的交付项。" : "接受架构决策后，即可拆分和跟踪实施项。"}
        </p>
      )}

      {isAdding ? (
        <div className="work-item-form">
          <div className="work-item-form-heading">
            <strong>新增实施项</strong>
            <button type="button" aria-label="取消新增实施项" onClick={() => setIsAdding(false)}><X size={14} /></button>
          </div>
          <input
            autoFocus
            maxLength={200}
            placeholder="可验证的功能或交付结果"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            maxLength={8000}
            placeholder="验收口径或实现范围（可选）"
            rows={3}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
          />
          <button className="work-item-submit" type="button" disabled={!title.trim() || Boolean(busyAction)} onClick={() => void submit()}>
            {busyAction === "add" ? "添加中…" : "添加到执行账本"}
          </button>
        </div>
      ) : canAdd ? (
        <button className="work-item-add" type="button" disabled={Boolean(busyAction)} onClick={() => setIsAdding(true)}>
          <Plus size={14} /> 添加实施项
        </button>
      ) : null}
    </section>
  );
}
