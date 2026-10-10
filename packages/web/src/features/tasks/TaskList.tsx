/**
 * @input  依赖：界面语言、TaskRepository、两路 revision、新建入口回调；use-tasks、状态/kind/source 文案表、
 *         components 的 delegationStatusLabel/isDelegationPaused
 * @output 导出：TaskList —— #/tasks 列表：kind/source 筛选、按状态分组的任务行（含最近委派摘要），行链接到 #/tasks/<id>
 * @pos    任务视图的列表态；筛选走仓储 listTasks(filter)，分组在前端完成，行内顺序沿用仓储的 priority/updatedAt 排序
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Bot, Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { buildHash } from "../../app/routes";
import { delegationStatusLabel, isDelegationPaused } from "../../components/DelegationExecutionProgress";
import { WORK_ITEM_STATUS_LABELS } from "../../components/ImplementationProgress";
import type { TaskRepository } from "../../data/tasks/task-repository";
import { useI18n } from "../../i18n/I18nProvider";
import {
  WORK_ITEM_KINDS,
  WORK_ITEM_SOURCES,
  type WorkItemKind,
  type WorkItemSource,
  type WorkItemStatus,
} from "../../types/council";
import { KIND_LABELS, SOURCE_LABELS } from "./task-labels";
import { useTasks } from "./use-tasks";

/** 分组顺序：先看正在推进和卡住的，再看排队的，已完成垫底。 */
const STATUS_GROUP_ORDER: readonly WorkItemStatus[] = ["in_progress", "blocked", "pending", "completed"];

export interface TaskListProps {
  repository: TaskRepository;
  revision: unknown;
  executionRevision: unknown;
  onCreate: () => void;
}

export function TaskList({ repository, revision, executionRevision, onCreate }: TaskListProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<WorkItemKind | "">("");
  const [source, setSource] = useState<WorkItemSource | "">("");
  const filter = useMemo(() => ({
    ...(kind ? { kind } : {}),
    ...(source ? { source } : {}),
  }), [kind, source]);
  const { tasks, latestDelegations, isLoading, error, reload } = useTasks(repository, filter, revision, executionRevision);
  const groups = STATUS_GROUP_ORDER
    .map((status) => ({ status, rows: tasks.filter((task) => task.status === status) }))
    .filter((group) => group.rows.length > 0);
  const filtered = Boolean(kind || source);

  return (
    <main className="tasks-view" id="main-content">
      <header className="tasks-view-header">
        <h1>{t("任务")}</h1>
        <div className="tasks-view-actions">
          <button type="button" disabled={isLoading} onClick={reload}><RefreshCw size={13} />{t("刷新")}</button>
          <button className="primary-button" type="button" onClick={onCreate}><Plus size={15} />{t("新建任务")}</button>
        </div>
      </header>
      <div className="tasks-filters">
        <label>
          <span>{t("任务类型")}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as WorkItemKind | "")}>
            <option value="">{t("全部")}</option>
            {WORK_ITEM_KINDS.map((value) => <option key={value} value={value}>{t(KIND_LABELS[value])}</option>)}
          </select>
        </label>
        <label>
          <span>{t("任务来源")}</span>
          <select value={source} onChange={(event) => setSource(event.target.value as WorkItemSource | "")}>
            <option value="">{t("全部")}</option>
            {WORK_ITEM_SOURCES.map((value) => <option key={value} value={value}>{t(SOURCE_LABELS[value])}</option>)}
          </select>
        </label>
      </div>

      {error ? (
        <p className="task-notice is-danger" role="alert">{t(error)}</p>
      ) : isLoading && tasks.length === 0 ? (
        <p className="tasks-placeholder" role="status">{t("加载中…")}</p>
      ) : tasks.length === 0 ? (
        <p className="tasks-placeholder">{filtered ? t("没有符合筛选条件的任务。") : t("还没有任务。可以直接新建，或在议题中拆分实施项。")}</p>
      ) : null}

      {!error ? groups.map(({ status, rows }) => (
        <section className="tasks-group" key={status} aria-labelledby={`tasks-group-${status}`}>
          <h2 id={`tasks-group-${status}`}>
            {t(WORK_ITEM_STATUS_LABELS[status])}
            <span>{rows.length}</span>
          </h2>
          <ul>
            {rows.map((task) => {
              const delegation = latestDelegations.get(task.id);
              return (
                <li key={task.id}>
                  <a className={`tasks-row is-${task.status}`} href={buildHash({ view: "tasks", taskId: task.id })}>
                    <strong>{task.title}</strong>
                    <span className="tasks-row-meta">
                      {t(KIND_LABELS[task.kind])} · {t(SOURCE_LABELS[task.source])} · {t("优先级 {priority}", { priority: task.priority })}
                    </span>
                    {delegation ? (
                      <span className={`tasks-row-delegation is-${isDelegationPaused(delegation) ? "paused" : delegation.status}`}>
                        <Bot size={12} />{t(delegationStatusLabel(delegation))}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )) : null}
    </main>
  );
}
