/**
 * @input  依赖：PipelineRepository（由 PipelinesView 注入）、路由中的 pipelineId、内容 revision 与编排 revision、
 *         http-client 的 CouncilApiError（识别 409）
 * @output 导出：usePipelineDetail —— 流水线详情读取、加载/错误态、手动重读，以及确认 brief、选定 final、恢复、取消、删除写操作与忙碌标记
 * @pos    流水线详情的状态与副作用层；调用方按 pipelineId 作 key 重挂载。写操作统一带当前父任务 version，
 *         返回的最新详情就地替换；409（版本冲突/阶段已变化）时标记 conflict 并主动重读
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../data/error-message";
import { CouncilApiError } from "../../data/http-client";
import type { PipelineRepository } from "../../data/pipelines/pipeline-repository";
import type { PipelineDetail } from "../../types/pipelines";
import { useLocalChangeTick } from "./use-pipelines";

export type PipelineAction = "brief" | "final" | "resume" | "cancel" | "delete";

export interface PipelineActionError {
  action: PipelineAction;
  /** 服务端 409：流水线已被推进或别处改过，视图提示「流水线已更新，请重试」。 */
  conflict: boolean;
  message: string;
}

export interface PipelineDetailState {
  detail: PipelineDetail | null;
  isLoading: boolean;
  loadError: string | null;
  actionError: PipelineActionError | null;
  busyAction: PipelineAction | null;
  reload: () => void;
  confirmBrief: (brief: Record<string, unknown>) => Promise<boolean>;
  selectFinal: (assetIds: string[]) => Promise<boolean>;
  resume: () => Promise<boolean>;
  cancel: () => Promise<boolean>;
  /** 物理删除；成功后由调用方离开详情页（之后重读会 404）。 */
  remove: () => Promise<boolean>;
}

export function usePipelineDetail(
  repository: PipelineRepository,
  pipelineId: string,
  revision: unknown,
  executionRevision: unknown,
): PipelineDetailState {
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<PipelineActionError | null>(null);
  const [busyAction, setBusyAction] = useState<PipelineAction | null>(null);
  const [retry, setRetry] = useState(0);
  const localTick = useLocalChangeTick(repository);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    repository.getPipeline(pipelineId)
      .then((next) => {
        if (!active) return;
        setDetail(next);
        setLoadError(null);
      })
      .catch((reason: unknown) => { if (active) setLoadError(getErrorMessage(reason)); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [repository, pipelineId, revision, executionRevision, localTick, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  const version = detail?.task.version;

  async function run(
    action: PipelineAction,
    write: (expectedVersion: number) => Promise<PipelineDetail | undefined>,
  ): Promise<boolean> {
    if (version === undefined) return false;
    setBusyAction(action);
    setActionError(null);
    try {
      const next = await write(version);
      if (next) setDetail(next);
      return true;
    } catch (reason: unknown) {
      const conflict = reason instanceof CouncilApiError && reason.httpStatus === 409;
      setActionError({ action, conflict, message: getErrorMessage(reason) });
      // 冲突说明本地版本已过期：重读让用户基于最新阶段再操作。
      if (conflict) reload();
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  return {
    detail,
    isLoading,
    loadError,
    actionError,
    busyAction,
    reload,
    confirmBrief: (brief) => run("brief", (expected) => repository.confirmBrief(pipelineId, brief, expected)),
    selectFinal: (assetIds) => run("final", (expected) => repository.selectFinal(pipelineId, assetIds, expected)),
    resume: () => run("resume", (expected) => repository.resumePipeline(pipelineId, expected)),
    cancel: () => run("cancel", (expected) => repository.cancelPipeline(pipelineId, expected)),
    remove: () => run("delete", async (expected) => {
      await repository.deletePipeline(pipelineId, expected);
      return undefined;
    }),
  };
}
