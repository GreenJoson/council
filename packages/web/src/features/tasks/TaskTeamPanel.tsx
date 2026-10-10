/**
 * @input  依赖：界面语言、TaskTeam（含 Worker）、Lead 委派（可缺）、use-task-team 的忙碌键/错误与动作回调；
 *         components 的 DelegationExecutionProgress、delegationStatusLabel
 * @output 导出：TaskTeamPanel —— 任务详情右栏「团队」：团队状态（活动/已结束）、Lead 委派跳转、并行上限与运行数、
 *         Worker 列表（名称、角色、状态徽章、分支短名、已合并提交、范围目录）与行内动作（聚焦单选、打断、归档）、
 *         被聚焦 Worker 的委派进度与失败分类、已归档折叠、结束团队
 * @pos    TaskDetail 的右栏；只在任务有团队时渲染。打断与结束团队都要内联二次确认；派发 Worker 是 Lead 经 MCP 做的事，
 *         这里不提供入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  AlertTriangle,
  Archive,
  Crosshair,
  GitBranch,
  GitMerge,
  LoaderCircle,
  OctagonX,
  Power,
  Users,
} from "lucide-react";
import { useState } from "react";
import { DelegationExecutionProgress, delegationStatusLabel } from "../../components/DelegationExecutionProgress";
import { useI18n } from "../../i18n/I18nProvider";
import type { WorkItemDelegation } from "../../types/orchestration";
import type { TaskTeam, TaskTeamStatus, TaskWorker, TaskWorkerStatus } from "../../types/team";

const TEAM_STATUS_LABELS: Record<TaskTeamStatus, string> = { active: "活动中", ended: "已结束" };
const WORKER_STATUS_LABELS: Record<TaskWorkerStatus, string> = {
  idle: "待命",
  running: "运行中",
  done: "已完成",
  error: "出错",
  archived: "已归档",
};
/** 委派区标题的 id（TaskDelegationSection 渲染），「查看 Lead 委派」滚动到这里。 */
const DELEGATION_HEADING_ID = "task-delegation-heading";

export interface TaskTeamPanelProps {
  team: TaskTeam;
  leadDelegation?: WorkItemDelegation;
  busyAction: string | null;
  actionError: string | null;
  loadError: string | null;
  onFocus: (workerId: string, focused: boolean) => Promise<void>;
  onInterrupt: (workerId: string) => Promise<void>;
  onArchive: (workerId: string) => Promise<void>;
  onEndTeam: () => Promise<void>;
}

/** 分支名只显示最后一段，完整名放 title。 */
function shortBranch(branchName: string): string {
  const segments = branchName.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? branchName;
}

export function TaskTeamPanel({
  team,
  leadDelegation,
  busyAction,
  actionError,
  loadError,
  onFocus,
  onInterrupt,
  onArchive,
  onEndTeam,
}: TaskTeamPanelProps) {
  const { t } = useI18n();
  const [showArchived, setShowArchived] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const busy = busyAction !== null;
  const archived = team.workers.filter((worker) => worker.status === "archived");
  const visible = showArchived ? team.workers : team.workers.filter((worker) => worker.status !== "archived");
  const running = team.workers.filter((worker) => worker.status === "running").length;
  const isActive = team.status === "active";

  return (
    <aside
      className="task-team-panel"
      aria-labelledby="task-team-heading"
      data-team-id={team.id}
      data-team-status={team.status}
    >
      <header className="task-team-header">
        <h2 id="task-team-heading"><Users size={14} />{t("团队")}</h2>
        <span className={`task-team-status is-${team.status}`}>{t(TEAM_STATUS_LABELS[team.status])}</span>
      </header>

      <dl className="task-team-meta">
        <div>
          <dt>{t("Lead 委派")}</dt>
          <dd>
            <button
              type="button"
              className="task-team-link"
              onClick={() => document.getElementById(DELEGATION_HEADING_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              {leadDelegation ? t(delegationStatusLabel(leadDelegation)) : t("查看委派")}
            </button>
          </dd>
        </div>
        <div>
          <dt>{t("并行上限")}</dt>
          <dd>{t("运行中 {running} / 上限 {limit}", { running, limit: team.maxParallel })}</dd>
        </div>
      </dl>

      {loadError ? (
        <p className="task-notice is-warning" role="alert"><AlertTriangle size={13} />{t(loadError)}</p>
      ) : null}
      {actionError ? (
        <p className="task-notice is-danger" role="alert">
          <AlertTriangle size={13} />
          {t("团队操作失败：{message}", { message: t(actionError) })}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="task-muted">
          {team.workers.length === 0 ? t("Lead 还没有派发 Worker。") : t("没有未归档的 Worker。")}
        </p>
      ) : (
        <ul className="task-team-workers" aria-label={t("Worker 列表")}>
          {visible.map((worker) => (
            <WorkerRow
              key={worker.id}
              worker={worker}
              teamActive={isActive}
              busy={busy}
              busyAction={busyAction}
              onFocus={onFocus}
              onInterrupt={onInterrupt}
              onArchive={onArchive}
            />
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <button
          type="button"
          className="task-team-archived-toggle"
          aria-expanded={showArchived}
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived
            ? t("隐藏已归档（{count}）", { count: archived.length })
            : t("显示已归档（{count}）", { count: archived.length })}
        </button>
      ) : null}

      {isActive ? (
        <div className="task-team-end">
          {confirmingEnd ? (
            <>
              <p>{t("结束团队会打断仍在运行的 Worker，已合并的提交保留。")}</p>
              <div className="task-team-confirm">
                <button
                  type="button"
                  className="is-danger"
                  disabled={busy}
                  onClick={() => void onEndTeam().then(() => setConfirmingEnd(false))}
                >
                  {busyAction === "team-end" ? <LoaderCircle className="spinner" size={12} /> : <Power size={12} />}
                  {t("确认结束团队")}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmingEnd(false)}>{t("取消")}</button>
              </div>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmingEnd(true)}>
              <Power size={12} />{t("结束团队")}
            </button>
          )}
        </div>
      ) : null}
    </aside>
  );
}

interface WorkerRowProps {
  worker: TaskWorker;
  teamActive: boolean;
  busy: boolean;
  busyAction: string | null;
  onFocus: (workerId: string, focused: boolean) => Promise<void>;
  onInterrupt: (workerId: string) => Promise<void>;
  onArchive: (workerId: string) => Promise<void>;
}

function WorkerRow({ worker, teamActive, busy, busyAction, onFocus, onInterrupt, onArchive }: WorkerRowProps) {
  const { t } = useI18n();
  const [confirmingInterrupt, setConfirmingInterrupt] = useState(false);
  const canInterrupt = teamActive && (worker.status === "idle" || worker.status === "running");
  const canArchive = worker.status === "done" || worker.status === "error";
  const delegation = worker.delegation;
  const spinner = (key: string) => busyAction === `${key}:${worker.id}` ? <LoaderCircle className="spinner" size={12} /> : null;

  return (
    <li
      className={`task-worker${worker.focused ? " is-focused" : ""}`}
      data-worker-id={worker.id}
      data-worker-status={worker.status}
    >
      <div className="task-worker-head">
        <strong>{worker.label}</strong>
        {worker.role ? <small>{worker.role}</small> : null}
        <span className={`task-worker-status is-${worker.status}`}>{t(WORKER_STATUS_LABELS[worker.status])}</span>
      </div>

      {worker.branchName || worker.mergedCommit ? (
        <div className="task-worker-git">
          {worker.branchName ? (
            <code title={worker.branchName}><GitBranch size={11} />{shortBranch(worker.branchName)}</code>
          ) : null}
          {worker.mergedCommit ? (
            <code title={t("已合并提交 {commit}", { commit: worker.mergedCommit })}>
              <GitMerge size={11} />{worker.mergedCommit.slice(0, 7)}
            </code>
          ) : null}
        </div>
      ) : null}

      {worker.scopePaths.length > 0 ? (
        <ul className="task-worker-scope" aria-label={t("范围目录")}>
          {worker.scopePaths.map((scope) => <li key={scope}>{scope}</li>)}
        </ul>
      ) : null}

      <div className="task-worker-actions">
        {worker.status !== "archived" ? (
          <button
            type="button"
            aria-pressed={worker.focused}
            aria-label={t("聚焦 Worker：{label}", { label: worker.label })}
            disabled={busy}
            onClick={() => void onFocus(worker.id, !worker.focused)}
          >
            {spinner("worker-focus") ?? <Crosshair size={12} />}{t(worker.focused ? "已聚焦" : "聚焦")}
          </button>
        ) : null}
        {canInterrupt && !confirmingInterrupt ? (
          <button
            type="button"
            aria-label={t("打断 Worker：{label}", { label: worker.label })}
            disabled={busy}
            onClick={() => setConfirmingInterrupt(true)}
          >
            <OctagonX size={12} />{t("打断")}
          </button>
        ) : null}
        {canArchive ? (
          <button
            type="button"
            aria-label={t("归档 Worker：{label}", { label: worker.label })}
            disabled={busy}
            onClick={() => void onArchive(worker.id)}
          >
            {spinner("worker-archive") ?? <Archive size={12} />}{t("归档")}
          </button>
        ) : null}
      </div>

      {canInterrupt && confirmingInterrupt ? (
        <div className="task-team-confirm" role="group" aria-label={t("确认打断")}>
          <span>{t("打断后该 Worker 停止执行，其余 Worker 不受影响。")}</span>
          <button
            type="button"
            className="is-danger"
            disabled={busy}
            onClick={() => void onInterrupt(worker.id).then(() => setConfirmingInterrupt(false))}
          >
            {spinner("worker-interrupt") ?? <OctagonX size={12} />}{t("确认打断")}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmingInterrupt(false)}>{t("取消")}</button>
        </div>
      ) : null}

      {worker.focused ? (
        <div className="task-worker-focus" aria-label={t("Worker 委派进度")}>
          {delegation?.execution ? <DelegationExecutionProgress delegation={delegation} /> : (
            <p className="task-muted">{t("暂无执行进度。")}</p>
          )}
          {delegation?.failureCode ? (
            <p><AlertTriangle size={12} />{t("失败分类：{code}", { code: delegation.failureCode })}</p>
          ) : null}
          {delegation?.error ? <p>{t(delegation.error)}</p> : null}
          {delegation?.headCommit ? (
            <code><GitBranch size={11} />{delegation.headCommit.slice(0, 12)}</code>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
