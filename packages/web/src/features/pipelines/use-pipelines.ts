/**
 * @input  依赖：PipelineRepository（由 PipelinesView 创建并注入）、内容 revision 与编排 revision
 * @output 导出：usePipelines —— 流水线列表、离线限制提示、加载/错误态与手动重读
 * @pos    流水线列表的状态与副作用层；真实仓储没有 subscribe，靠两路 revision 变化触发重读；
 *         仓储若提供 watchLocalChanges（仅 mock），本地状态机推进时同样重读
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../data/error-message";
import type { PipelineRepository } from "../../data/pipelines/pipeline-repository";
import type { PipelineSummary } from "../../types/pipelines";

export interface PipelinesState {
  pipelines: PipelineSummary[];
  limitation: string | null;
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

/** 订阅 mock 仓储的本地推进信号；真实仓储不提供该方法时什么也不做。 */
export function useLocalChangeTick(repository: PipelineRepository): number {
  const [tick, setTick] = useState(0);
  useEffect(() => repository.watchLocalChanges?.(() => setTick((value) => value + 1)), [repository]);
  return tick;
}

export function usePipelines(
  repository: PipelineRepository,
  revision: unknown,
  executionRevision: unknown,
): PipelinesState {
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [limitation, setLimitation] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const localTick = useLocalChangeTick(repository);

  useEffect(() => {
    // active 标志：revision 快速变化时只让最后一次请求落地，避免旧结果覆盖新结果。
    let active = true;
    setIsLoading(true);
    repository.listPipelines()
      .then((result) => {
        if (!active) return;
        setPipelines(result.items);
        setLimitation(result.limitation ?? null);
        setError(null);
      })
      .catch((reason: unknown) => { if (active) setError(getErrorMessage(reason)); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [repository, revision, executionRevision, localTick, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  return { pipelines, limitation, isLoading, error, reload };
}
