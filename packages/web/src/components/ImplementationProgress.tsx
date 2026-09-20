/**
 * @input  依赖：界面语言、议题/实施项树、AI 规划、动态 Actor、跨 Agent 委派、认领与证据化更新回调
 * @output 导出：右栏进度摘要，以及主区显式选 Agent 拆分、人工补充、Agent 协作执行和任务清单
 * @pos    Accepted 架构决策与外部 Codex/Claude 实际交付之间的可审计执行账本；
 *         接受决策不会自动生成任务；父任务状态只读派生，完成度只数叶子，审核发现在这里以子任务形式关闭
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
  LoaderCircle,
  MessageSquarePlus,
  Plus,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import {
  buildWorkItemTree,
  flattenWorkItemTree,
  summarizeWorkItemProgress,
} from "../data/work-item-tree";
import { useI18n } from "../i18n/I18nProvider";
import type { CouncilWorkItem, Participant, TopicDetail, WorkItemStatus } from "../types/council";
import type { OrchestrationAdapter, WorkItemDelegation } from "../types/orchestration";
import { participantFromActorSnapshot } from "./presentation";
import { RuntimeAuditDetails } from "./RuntimeAuditDetails";
import { WorkItemDelegationPanel } from "./WorkItemDelegationPanel";
import {
  BatchWorkItemDelegationPanel,
  type BatchDelegationOptions,
} from "./BatchWorkItemDelegationPanel";

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
  onGenerate: (adapterId: string) => Promise<void>;
  onAdd: (title: string, details: string, parentId?: string) => Promise<boolean>;
  onUpdate: (
    item: CouncilWorkItem,
    status: WorkItemStatus,
    statusNote: string,
  ) => Promise<void>;
  onClaim: (item: CouncilWorkItem) => Promise<void>;
  delegationAgents?: OrchestrationAdapter[];
  delegations?: WorkItemDelegation[];
  delegationBusyAction?: string | null;
  onDelegate?: (
    item: CouncilWorkItem,
    input: {
      supervisorAgentId: string;
      executorAgentId: string;
      requestedPermission: "workspace_write" | "danger_full_access";
      completionPolicy?: "review" | "human";
      acceptanceCriteria?: string;
      createInitialBaseline?: boolean;
    },
  ) => Promise<void>;
  onDelegateBatch?: (
    items: CouncilWorkItem[],
    input: BatchDelegationOptions,
  ) => Promise<void>;
  onCancelDelegation?: (delegationId: string) => Promise<void>;
}

export interface ImplementationSummaryProps {
  topic: TopicDetail;
}

/**
 * 服务端已经按叶子口径算过一次；本地汇总只是 mock 与离线渲染的兜底，公式必须一致。
 * 父任务不进分母——它的状态本来就是子任务算出来的，再数一遍等于把同一件事记两次。
 */
function getImplementationStats(topic: TopicDetail) {
  const summary = topic.workItemProgress ?? summarizeWorkItemProgress(topic.workItems);
  const total = summary?.total ?? 0;
  const completed = summary?.completed ?? 0;
  return {
    total,
    completed,
    blocked: summary?.blocked ?? 0,
    openFindings: summary?.openBlockingFindings ?? 0,
    progress: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

export function ImplementationSummary({ topic }: ImplementationSummaryProps) {
  const { t } = useI18n();
  const { total, completed, blocked, progress } = getImplementationStats(topic);

  return (
    <section className="implementation-card" aria-labelledby="implementation-summary-heading">
      <header className="implementation-heading">
        <div>
          <span className="implementation-kicker"><ListTodo size={14} /> {t("实施进度")}</span>
          <strong id="implementation-summary-heading">
            {total > 0 ? `${completed} / ${total}` : t("尚无任务")}
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
      {total === 0 ? (
        <p className="implementation-empty">{t("接受架构决策后，即可生成和跟踪实施计划。")}</p>
      ) : null}
    </section>
  );
}

export function ImplementationProgress({
  topic,
  participants,
  busyAction,
  onGenerate,
  onAdd,
  onUpdate,
  onClaim,
  delegationAgents = [],
  delegations = [],
  delegationBusyAction = null,
  onDelegate = async () => undefined,
  onDelegateBatch = async () => undefined,
  onCancelDelegation = async () => undefined,
}: ImplementationProgressProps) {
  const { t } = useI18n();
  const [isAdding, setIsAdding] = useState(false);
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [nextStatus, setNextStatus] = useState<WorkItemStatus>("pending");
  const [statusNote, setStatusNote] = useState("");
  const [planningAgentId, setPlanningAgentId] = useState("");

  const nodes = flattenWorkItemTree(buildWorkItemTree(topic.workItems));
  const planningAgents = delegationAgents.filter((adapter) => adapter.available);
  const planningAgent = planningAgents.find((adapter) => adapter.id === planningAgentId)
    ?? planningAgents[0];
  const activeDelegationItems = new Set(delegations.filter((delegation) => (
    ["queued", "executing", "reviewing", "changes_requested"].includes(delegation.status)
  )).map((delegation) => delegation.workItemId));
  const batchItems = nodes.filter(({ item, children }) => (
    children.length === 0
      && item.status !== "completed"
      && !activeDelegationItems.has(item.id)
  )).map(({ item }) => item);
  const { total, blocked, openFindings } = getImplementationStats(topic);
  const canEdit = topic.decisions.some((decision) => decision.status === "accepted");
  const isGenerating = busyAction === "generate";
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

  function beginProgressUpdate(item: CouncilWorkItem): void {
    setEditingItemId(item.id);
    setNextStatus(item.status);
    const latest = delegations.find((entry) => entry.workItemId === item.id);
    // 人工验收需要新填写的证据，不能把 Agent 摘要预填成用户已确认的结果。
    setStatusNote(latest?.completionPolicy === "human" && item.status !== "completed" ? "" : item.statusNote ?? "");
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
            {total > 0
              ? t("{count} 项可执行任务", { count: total })
              : t("尚无任务")}
          </strong>
        </div>
      </header>

      {openFindings > 0 ? (
        <p className="implementation-alert">
          <ShieldAlert size={13} />
          {" "}
          {t("{count} 条阻断级审核发现未关闭，本轮审核不能收敛", { count: openFindings })}
        </p>
      ) : null}

      {blocked > 0 ? (
        <p className="implementation-alert"><AlertTriangle size={13} /> {t("{count} 项受阻，需先解除依赖", { count: blocked })}</p>
      ) : null}

      {nodes.length > 0 ? (
        <BatchWorkItemDelegationPanel
          items={batchItems}
          adapters={delegationAgents}
          delegations={delegations}
          busyAction={delegationBusyAction}
          onStart={(input) => onDelegateBatch(batchItems, input)}
        />
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
            const editing = editingItemId === item.id;
            const evidenceRequired = nextStatus === "blocked" || nextStatus === "completed";
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
                <div className="work-item-main">
                  <span className="work-item-marker" aria-hidden="true">
                    {item.status === "completed" ? <Check size={13} /> : <CircleDot size={12} />}
                  </span>
                  <div className="work-item-copy">
                    <strong>
                      {item.title}
                      {item.origin === "review_finding" ? (
                        <span className={`work-item-tag work-item-tag-${item.severity ?? "non_blocking"}`}>
                          {item.severity === "blocking" ? t("阻断") : t("非阻断")}
                          {item.reviewRound ? ` · R${String(item.reviewRound)}` : ""}
                        </span>
                      ) : null}
                      {isParent ? <span className="work-item-tag work-item-tag-derived">{t("派生")}</span> : null}
                    </strong>
                    {item.details ? <p>{item.details}</p> : null}
                    {item.statusNote ? <blockquote>{item.statusNote}</blockquote> : null}
                    <small>
                      {updater?.name ?? item.updatedBy} · {item.updatedLabel} · v{item.version}
                      {assignee ? ` · ${t("认领：{name}", { name: assignee })}` : ""}
                    </small>
                    {item.fixCommit ? (
                      <small className="work-item-commit">
                        <GitCommitHorizontal size={12} /> {item.fixCommit}
                      </small>
                    ) : null}
                  </div>
                  <div className="work-item-actions">
                    <button
                      type="button"
                      className="work-item-update-toggle"
                      disabled={Boolean(busyAction) || isParent}
                      title={isParent ? t(DERIVED_STATUS_HINT) : undefined}
                      aria-expanded={editing}
                      onClick={() => editing ? setEditingItemId(null) : beginProgressUpdate(item)}
                    >
                      <MessageSquarePlus size={12} /> {t(STATUS_LABELS[item.status])}
                    </button>
                    <div className="work-item-buttons">
                      {canClaim ? (
                        <button
                          className="work-item-mini-button"
                          type="button"
                          disabled={Boolean(busyAction)}
                          onClick={() => void onClaim(item)}
                        >
                          <Hand size={12} /> {claiming ? t("认领中…") : t("认领")}
                        </button>
                      ) : null}
                      <button
                        className="work-item-mini-button"
                        type="button"
                        aria-label={t("在“{title}”下新增子任务", { title: item.title })}
                        disabled={Boolean(busyAction)}
                        onClick={() => openForm(item.id)}
                      >
                        <Plus size={12} /> {t("子任务")}
                      </button>
                    </div>
                  </div>
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
                {!isParent && (item.status !== "completed" || delegations.some((entry) => entry.workItemId === item.id)) ? (
                  <div>
                  <WorkItemDelegationPanel
                    item={item}
                    adapters={delegationAgents}
                    delegation={delegations.find((candidate) => candidate.workItemId === item.id)}
                    busyAction={delegationBusyAction}
                    onStart={(input) => onDelegate(item, input)}
                    onCancel={onCancelDelegation}
                  />
                  {delegations.filter((entry) => entry.workItemId === item.id).slice(1).map((entry) => (
                    <div key={entry.id}><small>{t("历史委派")} · {entry.createdAt}</small>
                      <RuntimeAuditDetails topicId={entry.topicId} sourceKind="delegation" sourceId={entry.id} />
                    </div>
                  ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="implementation-empty">
          {canEdit
            ? t("任务不会自动生成。请选择 Agent 手动分拆，也可以直接添加。")
            : t("接受架构决策后，即可生成和跟踪实施计划。")}
        </p>
      )}

      {isAdding ? (
        <div className="work-item-form">
          <div className="work-item-form-heading">
            <strong>
              {parentTitle
                ? t("在“{title}”下新增子任务", { title: parentTitle })
                : t("补充实施任务")}
            </strong>
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
          {planningAgent ? (
            <>
              <label className="work-item-planner-select">
                <span>{t("选择任务拆分 Agent")}</span>
                <select
                  aria-label={t("选择任务拆分 Agent")}
                  disabled={Boolean(busyAction)}
                  value={planningAgent.id}
                  onChange={(event) => setPlanningAgentId(event.target.value)}
                >
                  {planningAgents.map((adapter) => (
                    <option key={adapter.id} value={adapter.id}>{adapter.label}</option>
                  ))}
                </select>
              </label>
              <button
                className="work-item-generate"
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() => void onGenerate(planningAgent.id)}
              >
                {isGenerating ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />}
                {isGenerating
                  ? t("{agent} 正在拆分…", { agent: planningAgent.label })
                  : total > 0
                    ? t("让 {agent} 补充遗漏任务", { agent: planningAgent.label })
                    : t("让 {agent} 拆分任务", { agent: planningAgent.label })}
              </button>
            </>
          ) : (
            <small className="work-item-agent-hint">{t("没有可用的规划 Agent，可先手动添加。")}</small>
          )}
          <button className="work-item-add" type="button" disabled={Boolean(busyAction)} onClick={() => openForm(undefined)}>
            <Plus size={14} /> {t("手动添加任务")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
