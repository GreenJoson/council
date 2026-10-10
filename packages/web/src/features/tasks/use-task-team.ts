/**
 * @input  依赖：TaskRepository（团队读取与 Worker/团队动作）、taskId、两路 revision
 * @output 导出：useTaskTeam —— 任务团队读取（随两路 revision 重读）、聚焦/打断/归档/结束团队动作、忙碌键与错误；
 *         applyTeam 供「团队模式发起」成功后就地放入新团队
 * @pos    任务详情右栏「团队」的状态与副作用层；与 use-task-detail 并列，由 TaskDetail 组合，
 *         团队读失败只影响右栏，不把整页换成占位
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../data/error-message";
import type { TaskRepository } from "../../data/tasks/task-repository";
import type { TaskTeam, TaskWorker } from "../../types/team";

export type TaskWorkerAction = "focus" | "interrupt" | "archive";

export interface TaskTeamState {
  /** null = 没有团队（或桌面离线时未知，详情 limitation 已说明）。 */
  team: TaskTeam | null;
  loadError: string | null;
  actionError: string | null;
  /** 忙碌键：worker-focus:<id>、worker-interrupt:<id>、worker-archive:<id>、team-end。 */
  busyAction: string | null;
  focusWorker: (workerId: string, focused: boolean) => Promise<void>;
  interruptWorker: (workerId: string) => Promise<void>;
  archiveWorker: (workerId: string) => Promise<void>;
  endTeam: () => Promise<void>;
  applyTeam: (team: TaskTeam) => void;
  reload: () => void;
}

/** 写操作返回单个 Worker：就地替换；聚焦为单选，置 true 时同步清掉其他 Worker 的聚焦，随后仍以重读为准。 */
function mergeWorker(team: TaskTeam, updated: TaskWorker): TaskTeam {
  return {
    ...team,
    workers: team.workers.map((worker) => {
      if (worker.id === updated.id) return updated;
      return updated.focused && worker.focused ? { ...worker, focused: false } : worker;
    }),
  };
}

export function useTaskTeam(
  repository: TaskRepository,
  taskId: string,
  revision: unknown,
  executionRevision: unknown,
): TaskTeamState {
  const [team, setTeam] = useState<TaskTeam | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    repository.getTaskTeam(taskId)
      .then((next) => {
        if (!active) return;
        setTeam(next);
        setLoadError(null);
      })
      .catch((reason: unknown) => { if (active) setLoadError(getErrorMessage(reason)); });
    return () => { active = false; };
  }, [repository, taskId, revision, executionRevision, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);

  async function runWorkerAction(
    key: string,
    action: () => Promise<TaskWorker>,
  ): Promise<void> {
    setBusyAction(key);
    setActionError(null);
    try {
      const updated = await action();
      setTeam((current) => current && current.id === updated.teamId ? mergeWorker(current, updated) : current);
    } catch (reason: unknown) {
      // 多为状态已变（Worker 已结束、团队已结束）：提示并重读，让按钮可用性跟上服务端。
      setActionError(getErrorMessage(reason));
      reload();
    } finally {
      setBusyAction(null);
    }
  }

  const focusWorker = (workerId: string, focused: boolean) =>
    runWorkerAction(`worker-focus:${workerId}`, () => repository.focusWorker(taskId, workerId, focused));
  const interruptWorker = (workerId: string) =>
    runWorkerAction(`worker-interrupt:${workerId}`, () => repository.interruptWorker(taskId, workerId));
  const archiveWorker = (workerId: string) =>
    runWorkerAction(`worker-archive:${workerId}`, () => repository.archiveWorker(taskId, workerId));

  async function endTeam(): Promise<void> {
    setBusyAction("team-end");
    setActionError(null);
    try {
      setTeam(await repository.endTeam(taskId));
    } catch (reason: unknown) {
      setActionError(getErrorMessage(reason));
      reload();
    } finally {
      setBusyAction(null);
    }
  }

  const applyTeam = useCallback((next: TaskTeam) => {
    setTeam(next);
    setLoadError(null);
  }, []);

  return { team, loadError, actionError, busyAction, focusWorker, interruptWorker, archiveWorker, endTeam, applyTeam, reload };
}
