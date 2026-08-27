/**
 * @input  依赖：议题实施项树、动态 Actor 展示、添加/状态更新/认领回调与写入忙碌状态
 * @output 导出：父子两层的实施进度卡片；父任务状态只读派生，叶子可认领
 * @pos    Accepted 决策与外部 Codex/Claude 实际交付之间的可审计执行账本
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  AlertTriangle,
  Check,
  CircleDot,
  GitCommitHorizontal,
  Hand,
  ListTodo,
  Plus,
  ShieldAlert,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import {
  buildWorkItemTree,
  flattenWorkItemTree,
  summarizeWorkItemProgress,
} from "../data/work-item-tree";
import type {
  CouncilWorkItem,
  Participant,
  TopicDetail,
  WorkItemStatus,
} from "../types/council";
import { participantFromActorSnapshot } from "./presentation";

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  blocked: "受阻",
  completed: "已完成",
};

/** 父任务不接受手动改状态，鼠标悬停要说清为什么，否则只会被当成 bug。 */
const DERIVED_STATUS_HINT = "父任务状态由子任务派生，请更新它的子任务";

export interface ImplementationProgressProps {
  topic: TopicDetail;
  participants: Map<string, Participant>;
  busyAction: string | null;
  onAdd: (title: string, details: string, parentId?: string) => Promise<boolean>;
  onUpdate: (item: CouncilWorkItem, status: WorkItemStatus) => Promise<void>;
  onClaim: (item: CouncilWorkItem) => Promise<void>;
}

export function ImplementationProgress({
  topic,
  participants,
  busyAction,
  onAdd,
  onUpdate,
  onClaim,
}: ImplementationProgressProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");

  const nodes = flattenWorkItemTree(buildWorkItemTree(topic.workItems));
  // 服务端已经按叶子口径算过一次；本地汇总只是 mock 与离线渲染的兜底，公式必须一致。
  const summary = topic.workItemProgress ?? summarizeWorkItemProgress(topic.workItems);
  const total = summary?.total ?? 0;
  const completed = summary?.completed ?? 0;
  const blocked = summary?.blocked ?? 0;
  const openFindings = summary?.openBlockingFindings ?? 0;
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100);
  const canAdd = topic.decision?.status === "accepted";
  const parentTitle = parentId
    ? topic.workItems.find((item) => item.id === parentId)?.title
    : undefined;

  function openForm(nextParentId?: string): void {
    setParentId(nextParentId);
    setTitle("");
    setDetails("");
    setIsAdding(true);
  }

  async function submit(): Promise<void> {
    if (!title.trim() || busyAction) {
      return;
    }
    if (await onAdd(title.trim(), details.trim(), parentId)) {
      setTitle("");
      setDetails("");
      setParentId(undefined);
      setIsAdding(false);
    }
  }

  return (
    <section className="implementation-card" aria-labelledby="implementation-heading">
      <header className="implementation-heading">
        <div>
          <span className="implementation-kicker"><ListTodo size={14} /> 实施进度</span>
          <strong id="implementation-heading">
            {total > 0 ? `${completed} / ${total}` : "尚未拆分"}
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

      {openFindings > 0 ? (
        <p className="implementation-alert">
          <ShieldAlert size={13} /> {openFindings} 条阻断级审核发现未关闭，本轮审核不能收敛
        </p>
      ) : null}

      {blocked > 0 ? (
        <p className="implementation-alert"><AlertTriangle size={13} /> {blocked} 项受阻，需先解除依赖</p>
      ) : null}

      {nodes.length > 0 ? (
        <ol className="work-item-list">
          {nodes.map(({ item, depth, children }) => {
            const isParent = children.length > 0;
            const updater = participantFromActorSnapshot(
              item.updatedBySnapshot,
              participants.get(item.updatedBy),
            );
            const assignee = item.assignee
              ? participants.get(item.assignee)?.name ?? item.assignee
              : undefined;
            const updating = busyAction === `update:${item.id}`;
            const claiming = busyAction === `claim:${item.id}`;
            const canClaim = !isParent && !item.assignee && item.status !== "completed";
            return (
              <li
                className={[
                  "work-item",
                  `work-item-${item.status}`,
                  isParent ? "work-item-parent" : "",
                  depth > 0 ? "work-item-child" : "",
                ].filter(Boolean).join(" ")}
                key={item.id}
                style={{ "--work-item-depth": depth } as CSSProperties}
              >
                <span className="work-item-marker" aria-hidden="true">
                  {item.status === "completed" ? <Check size={13} /> : <CircleDot size={12} />}
                </span>
                <div className="work-item-copy">
                  <strong>
                    {item.title}
                    {item.origin === "review_finding" ? (
                      <span className={`work-item-tag work-item-tag-${item.severity ?? "non_blocking"}`}>
                        {item.severity === "blocking" ? "阻断" : "非阻断"}
                        {item.reviewRound ? ` · R${String(item.reviewRound)}` : ""}
                      </span>
                    ) : null}
                    {isParent ? <span className="work-item-tag work-item-tag-derived">派生</span> : null}
                  </strong>
                  {item.details ? <p>{item.details}</p> : null}
                  {item.statusNote ? <blockquote>{item.statusNote}</blockquote> : null}
                  <small>
                    {updater?.name ?? item.updatedBy} · {item.updatedLabel} · v{item.version}
                    {assignee ? ` · 认领：${assignee}` : ""}
                  </small>
                  {item.fixCommit ? (
                    <small className="work-item-commit">
                      <GitCommitHorizontal size={12} /> {item.fixCommit}
                    </small>
                  ) : null}
                </div>
                <div className="work-item-actions">
                  <select
                    aria-label={`更新“${item.title}”的状态`}
                    className="work-item-status-select"
                    disabled={Boolean(busyAction) || isParent}
                    title={isParent ? DERIVED_STATUS_HINT : undefined}
                    value={item.status}
                    onChange={(event) => void onUpdate(item, event.target.value as WorkItemStatus)}
                  >
                    {Object.entries(STATUS_LABELS).map(([status, label]) => (
                      <option key={status} value={status}>{label}</option>
                    ))}
                  </select>
                  <div className="work-item-buttons">
                    {canClaim ? (
                      <button
                        className="work-item-mini-button"
                        type="button"
                        disabled={Boolean(busyAction)}
                        onClick={() => void onClaim(item)}
                      >
                        <Hand size={12} /> {claiming ? "认领中…" : "认领"}
                      </button>
                    ) : null}
                    <button
                      className="work-item-mini-button"
                      type="button"
                      aria-label={`在“${item.title}”下新增子任务`}
                      disabled={Boolean(busyAction)}
                      onClick={() => openForm(item.id)}
                    >
                      <Plus size={12} /> 子任务
                    </button>
                  </div>
                  {updating ? <span className="work-item-saving">保存中…</span> : null}
                </div>
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
            <strong>{parentTitle ? `在“${parentTitle}”下新增子任务` : "新增实施项"}</strong>
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
        <button className="work-item-add" type="button" disabled={Boolean(busyAction)} onClick={() => openForm(undefined)}>
          <Plus size={14} /> 添加实施项
        </button>
      ) : null}
    </section>
  );
}
