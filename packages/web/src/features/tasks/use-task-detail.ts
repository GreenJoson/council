/**
 * @input  依赖：TaskRepository（由 TasksView 注入）、路由中的 taskId、内容 revision 与编排 revision
 * @output 导出：useTaskDetail —— 任务详情读取、加载/错误态、手动重读，以及状态更新、简报保存、发起（代码/图像）/取消委派写操作与忙碌标记
 * @pos    任务详情的状态与副作用层；调用方按 taskId 作 key 重挂载，切换任务不残留旧详情；
 *         写操作返回的最新行就地合并，随后仍以 revision 驱动的重读为准
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../data/error-message";
import type { TaskRepository } from "../../data/tasks/task-repository";
import type { StartTaskDelegationInput, WorkItemDelegation } from "../../types/orchestration";
import type { TaskDetail, UpdateTaskInput } from "../../types/tasks";

/** 委派面板（代码 / 图像）发起时提交的字段；expectedVersion 由 hook 用当前任务版本补齐。 */
export type TaskDelegationStartInput = Omit<StartTaskDelegationInput, "expectedVersion">;

export interface TaskDetailState {
  detail: TaskDetail | null;
  isLoading: boolean;
  /** 读取失败（含任务不存在）；视图据此显示占位与返回列表入口。 */
  loadError: string | null;
  /** 写操作失败；与读取错误分开，避免一次保存失败把整页换成占位。kind=update 时已自动重读最新版本。 */
  actionError: { kind: "update" | "brief" | "delegate" | "cancel"; message: string } | null;
  /** 与 WorkItemDelegationPanel 约定的忙碌键：update、brief、delegate:<id>、cancel-delegation:<id>。 */
  busyAction: string | null;
  reload: () => void;
  updateStatus: (input: Omit<UpdateTaskInput, "taskId" | "expectedVersion">) => Promise<boolean>;
  /** 经 PUT 保存简报：status 原样带上，只改 brief。 */
  saveBrief: (brief: Record<string, unknown>) => Promise<boolean>;
  startDelegation: (input: TaskDelegationStartInput) => Promise<void>;
  cancelDelegation: (delegationId: string) => Promise<void>;
}

function byCreatedAtDesc(left: WorkItemDelegation, right: WorkItemDelegation): number {
  return right.createdAt.localeCompare(left.createdAt);
}

export function useTaskDetail(
  repository: TaskRepository,
  taskId: string,
  revision: unknown,
  executionRevision: unknown,
): TaskDetailState {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<TaskDetailState["actionError"]>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    repository.getTask(taskId)
      .then((next) => {
        if (!active) return;
        setDetail({ ...next, delegations: [...next.delegations].sort(byCreatedAtDesc) });
        setLoadError(null);
      })
      .catch((reason: unknown) => { if (active) setLoadError(getErrorMessage(reason)); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [repository, taskId, revision, executionRevision, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  const task = detail?.task;

  async function updateStatus(input: Omit<UpdateTaskInput, "taskId" | "expectedVersion">): Promise<boolean> {
    if (!task) return false;
    setBusyAction("update");
    setActionError(null);
    try {
      const updated = await repository.updateTask({ ...input, taskId: task.id, expectedVersion: task.version });
      setDetail((current) => current && current.task.id === updated.id ? { ...current, task: updated } : current);
      return true;
    } catch (reason: unknown) {
      // 最常见的是乐观版本冲突（别处已改过这条任务）：提示后重读，让用户基于最新版本再提交。
      setActionError({ kind: "update", message: getErrorMessage(reason) });
      reload();
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function saveBrief(brief: Record<string, unknown>): Promise<boolean> {
    if (!task) return false;
    setBusyAction("brief");
    setActionError(null);
    try {
      const updated = await repository.updateTask({
        taskId: task.id,
        status: task.status,
        expectedVersion: task.version,
        brief,
      });
      setDetail((current) => current && current.task.id === updated.id ? { ...current, task: updated } : current);
      return true;
    } catch (reason: unknown) {
      setActionError({ kind: "brief", message: getErrorMessage(reason) });
      reload();
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function startDelegation(input: TaskDelegationStartInput): Promise<void> {
    if (!task) return;
    setBusyAction(`delegate:${task.id}`);
    setActionError(null);
    try {
      const created = await repository.startTaskDelegation(task.id, { ...input, expectedVersion: task.version });
      setDetail((current) => current && current.task.id === created.workItemId
        ? { ...current, delegations: [created, ...current.delegations.filter((entry) => entry.id !== created.id)] }
        : current);
      // 发起委派会推进任务行版本；主动重读一次拿到新版本，不必等 revision 信号。
      reload();
    } catch (reason: unknown) {
      // 与讨论页既有委派入口一致：失败只写错误文案、不向面板抛出（面板用 void 调用，抛出会成为未处理 rejection）。
      setActionError({ kind: "delegate", message: getErrorMessage(reason) });
    } finally {
      setBusyAction(null);
    }
  }

  async function cancelDelegation(delegationId: string): Promise<void> {
    setBusyAction(`cancel-delegation:${delegationId}`);
    setActionError(null);
    try {
      const cancelled = await repository.cancelTaskDelegation(delegationId);
      setDetail((current) => current
        ? { ...current, delegations: current.delegations.map((entry) => entry.id === cancelled.id ? cancelled : entry) }
        : current);
    } catch (reason: unknown) {
      setActionError({ kind: "cancel", message: getErrorMessage(reason) });
    } finally {
      setBusyAction(null);
    }
  }

  return { detail, isLoading, loadError, actionError, busyAction, reload, updateStatus, saveBrief, startDelegation, cancelDelegation };
}
