/**
 * @input  依赖：TaskRepository（由 TasksView 创建并注入）、列表筛选、内容 revision 与编排 revision
 * @output 导出：useTasks —— 任务行、未完成任务的最近委派映射、加载/错误态与手动重读
 * @pos    任务列表的状态与副作用层；仓储没有 subscribe，靠两路 revision 变化触发重读
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../data/error-message";
import type { TaskRepository } from "../../data/tasks/task-repository";
import type { CouncilWorkItem } from "../../types/council";
import type { WorkItemDelegation } from "../../types/orchestration";
import type { TaskListFilter } from "../../types/tasks";

export interface TasksState {
  tasks: CouncilWorkItem[];
  /** 任务 id → 最近一次委派；只为未完成任务读取，读取失败的条目直接缺省。 */
  latestDelegations: ReadonlyMap<string, WorkItemDelegation>;
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

export function useTasks(
  repository: TaskRepository,
  filter: TaskListFilter,
  revision: unknown,
  executionRevision: unknown,
): TasksState {
  const [tasks, setTasks] = useState<CouncilWorkItem[]>([]);
  const [latestDelegations, setLatestDelegations] = useState<ReadonlyMap<string, WorkItemDelegation>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const { kind, source, status } = filter;

  useEffect(() => {
    // active 标志：筛选或 revision 快速变化时，只让最后一次请求落地，避免旧结果覆盖新结果。
    let active = true;
    setIsLoading(true);
    void (async () => {
      try {
        const rows = await repository.listTasks({ kind, source, status });
        if (!active) return;
        setTasks(rows);
        setError(null);
        // 列表接口不带委派；逐个读取只覆盖未完成任务，已完成任务的委派摘要价值低且会放大请求数。
        // allSettled：编排服务离线（http 503 / 桌面本地服务未启动）时摘要缺省，不拖垮列表。
        const pending = rows.filter((row) => row.status !== "completed");
        const results = await Promise.allSettled(
          pending.map((row) => repository.listTaskDelegations(row.id)),
        );
        if (!active) return;
        const next = new Map<string, WorkItemDelegation>();
        pending.forEach((row, index) => {
          const result = results[index];
          const latest = result?.status === "fulfilled"
            ? [...result.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
            : undefined;
          if (latest) next.set(row.id, latest);
        });
        setLatestDelegations(next);
      } catch (reason: unknown) {
        if (active) setError(getErrorMessage(reason));
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => { active = false; };
  }, [repository, kind, source, status, revision, executionRevision, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  return { tasks, latestDelegations, isLoading, error, reload };
}
