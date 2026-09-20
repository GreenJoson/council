/**
 * @input  依赖：OrchestrationRepository、当前议题与 revision 驱动的刷新信号
 * @output 导出：实施项委派列表、单项/批量启动、取消动作与忙碌状态
 * @pos    App 与任务卡之间的跨 Agent 委派状态控制器；后台进展由既有 SSE revision 触发重读
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import type {
  StartWorkItemDelegationInput,
  StartWorkItemDelegationBatchInput,
  WorkItemDelegation,
} from "../types/orchestration";

export function useWorkItemDelegations(
  repository: OrchestrationRepository,
  topicId: string,
  refreshSignal: unknown,
) {
  const [delegations, setDelegations] = useState<WorkItemDelegation[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!topicId) {
      setDelegations([]);
      return;
    }
    setDelegations(await repository.listWorkItemDelegations(topicId));
  }, [repository, topicId]);

  useEffect(() => {
    if (!topicId) {
      setDelegations([]);
      return;
    }
    let current = true;
    void repository.listWorkItemDelegations(topicId)
      .then((items) => {
        if (current) setDelegations(items);
      })
      .catch(() => {
        if (current) setDelegations([]);
      });
    return () => { current = false; };
  }, [repository, topicId, refreshSignal]);

  const start = useCallback(async (input: StartWorkItemDelegationInput) => {
    setBusyAction(`delegate:${input.workItemId}`);
    try {
      const created = await repository.startWorkItemDelegation(input);
      setDelegations((current) => [created, ...current]);
      return created;
    } finally {
      setBusyAction(null);
    }
  }, [repository]);

  const cancel = useCallback(async (delegationId: string) => {
    setBusyAction(`cancel-delegation:${delegationId}`);
    try {
      const updated = await repository.cancelWorkItemDelegation(delegationId);
      setDelegations((current) => current.map((item) => item.id === updated.id ? updated : item));
      return updated;
    } finally {
      setBusyAction(null);
    }
  }, [repository]);

  const startBatch = useCallback(async (input: StartWorkItemDelegationBatchInput) => {
    setBusyAction("delegate-batch");
    try {
      const created = await repository.startWorkItemDelegationBatch(input);
      setDelegations((current) => [...created, ...current]);
      return created;
    } finally {
      setBusyAction(null);
    }
  }, [repository]);

  return { delegations, busyAction, reload, start, startBatch, cancel };
}
