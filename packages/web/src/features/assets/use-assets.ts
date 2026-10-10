/**
 * @input  依赖：AssetRepository、kind 筛选、页偏移与内容 revision
 * @output 导出：useAssetPage（资产分页列表读取，revision 前进或手动 reload 时重读）、
 *         useAssetDetail（单个资产读取 + 设为/取消 final、删除写操作与忙碌/错误态）
 * @pos    资产功能的状态与副作用层；组件只拿结果渲染。写操作返回的最新资产就地合并，
 *         随后仍以 revision 驱动的重读为准（与任务页 use-task-detail 同一约定）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { getErrorMessage } from "../../data/error-message";
import type { Asset, AssetKind, AssetPage } from "../../types/assets";
import { finalTargets } from "./asset-labels";

export interface AssetPageState {
  page: AssetPage | null;
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAssetPage(
  repository: AssetRepository,
  kind: AssetKind | "",
  offset: number,
  revision: unknown,
): AssetPageState {
  const [page, setPage] = useState<AssetPage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    repository.listAssets({
      ...(kind ? { kind } : {}),
      limit: repository.pageSize,
      offset,
    })
      .then((next) => {
        if (!active) return;
        setPage(next);
        setError(null);
      })
      .catch((reason: unknown) => { if (active) setError(getErrorMessage(reason)); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [repository, kind, offset, revision, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  return { page, isLoading, error, reload };
}

export interface AssetDetailState {
  asset: Asset | null;
  isLoading: boolean;
  loadError: string | null;
  actionError: string | null;
  /** final | delete，与按钮禁用联动。 */
  busyAction: "final" | "delete" | null;
  reload: () => void;
  /** 有待设的 output 挂接时设为 final，否则取消现有 final。 */
  toggleFinal: () => Promise<void>;
  remove: () => Promise<boolean>;
}

export function useAssetDetail(
  repository: AssetRepository,
  assetId: string,
  revision: unknown,
): AssetDetailState {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<AssetDetailState["busyAction"]>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    repository.getAsset(assetId)
      .then((next) => {
        if (!active) return;
        setAsset(next);
        setLoadError(null);
      })
      .catch((reason: unknown) => { if (active) setLoadError(getErrorMessage(reason)); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [repository, assetId, revision, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);

  async function toggleFinal(): Promise<void> {
    if (!asset) return;
    const { pending, current } = finalTargets(asset);
    setBusyAction("final");
    setActionError(null);
    try {
      let latest = asset;
      if (pending.length > 0) {
        for (const taskId of pending) {
          latest = await repository.addLink(asset.id, { targetKind: "work_item", targetId: taskId, role: "final" });
        }
      } else {
        for (const taskId of current) {
          latest = await repository.removeLink(asset.id, { targetKind: "work_item", targetId: taskId, role: "final" });
        }
      }
      setAsset(latest);
    } catch (reason: unknown) {
      setActionError(getErrorMessage(reason));
      reload();
    } finally {
      setBusyAction(null);
    }
  }

  async function remove(): Promise<boolean> {
    if (!asset) return false;
    setBusyAction("delete");
    setActionError(null);
    try {
      await repository.deleteAsset(asset.id);
      return true;
    } catch (reason: unknown) {
      setActionError(getErrorMessage(reason));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  return { asset, isLoading, loadError, actionError, busyAction, reload, toggleFinal, remove };
}
