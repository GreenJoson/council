/**
 * @input  依赖：AssetRepository、网格筛选（kind / 只看未引用）、页偏移与内容 revision
 * @output 导出：useAssetPage（资产分页列表读取，revision 前进或手动 reload 时重读）、
 *         useAssetDetail（单个资产读取 + 设为/取消 final、删除写操作与忙碌/错误态）、
 *         useUnlinkedCleanup（「清理未引用」：先数未挂任何目标的资产，经调用方确认后逐个软删除，返回清理数量）、
 *         useImageSequence（详情页大图翻页用的图像序列：打开 Lightbox 才按页读完，与网格同序）
 * @pos    资产功能的状态与副作用层；组件只拿结果渲染。写操作返回的最新资产就地合并，
 *         随后仍以 revision 驱动的重读为准（与任务页 use-task-detail 同一约定）；
 *         清理不新增服务端批量接口，复用列表 + 单条软删除，三种数据模式行为一致
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

export interface AssetGridQuery {
  kind: AssetKind | "";
  /** 只看未挂任何目标的资产。 */
  unlinked: boolean;
}

export function useAssetPage(
  repository: AssetRepository,
  query: AssetGridQuery,
  offset: number,
  revision: unknown,
): AssetPageState {
  const { kind, unlinked } = query;
  const [page, setPage] = useState<AssetPage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    repository.listAssets({
      ...(kind ? { kind } : {}),
      ...(unlinked ? { unlinked: true } : {}),
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
  }, [repository, kind, unlinked, offset, revision, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  return { page, isLoading, error, reload };
}

export interface UnlinkedCleanupState {
  isCleaning: boolean;
  /** 上一次清理结果：deleted 为 0 表示没有未引用资产；null 表示尚未清理或已被新错误覆盖。 */
  result: { deleted: number } | null;
  error: string | null;
  /** confirm 收到待清理数量，返回 false 则中止；完成（含部分失败）后调用 onDone 让列表重读。 */
  cleanup: (confirm: (count: number) => boolean) => Promise<void>;
}

export function useUnlinkedCleanup(
  repository: AssetRepository,
  onDone: () => void,
): UnlinkedCleanupState {
  const [isCleaning, setIsCleaning] = useState(false);
  const [result, setResult] = useState<{ deleted: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cleanup = useCallback(async (confirm: (count: number) => boolean): Promise<void> => {
    setIsCleaning(true);
    setError(null);
    setResult(null);
    let deleted = 0;
    try {
      const probe = await repository.listAssets({ unlinked: true, limit: 1, offset: 0 });
      if (probe.total === 0) {
        setResult({ deleted: 0 });
        return;
      }
      if (!confirm(probe.total)) {
        return;
      }
      // 每轮都从第一页取：删掉的资产会从列表消失，offset 不前进；轮数封顶防止删除未生效时空转
      const maxRounds = Math.ceil(probe.total / repository.pageSize) + 1;
      for (let round = 0; round < maxRounds; round += 1) {
        const page = await repository.listAssets({ unlinked: true, limit: repository.pageSize, offset: 0 });
        if (page.items.length === 0) {
          break;
        }
        for (const asset of page.items) {
          await repository.deleteAsset(asset.id);
          deleted += 1;
        }
      }
      setResult({ deleted });
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
      if (deleted > 0) {
        setResult({ deleted });
      }
    } finally {
      setIsCleaning(false);
      if (deleted > 0) {
        onDone();
      }
    }
  }, [repository, onDone]);

  return { isCleaning, result, error, cleanup };
}

/** 大图翻页序列的读取上限：资产库再大也只取最新这些张，避免一次打开大图读完整个库。 */
const IMAGE_SEQUENCE_LIMIT = 500;

/**
 * 当前项目的图像资产序列（与网格「全部」同序：入库时间倒序），供详情页 Lightbox 上一张/下一张。
 * enabled 为 true（打开大图）才开始读，读到后在本次详情页内复用；读失败只是没有翻页，不影响看当前图，
 * 下次打开大图再试。
 */
export function useImageSequence(repository: AssetRepository, enabled: boolean): Asset[] | null {
  const [sequence, setSequence] = useState<Asset[] | null>(null);

  useEffect(() => {
    if (!enabled || sequence !== null) return undefined;
    let active = true;
    void (async () => {
      const items: Asset[] = [];
      while (items.length < IMAGE_SEQUENCE_LIMIT) {
        const page = await repository.listAssets({ kind: "image", limit: repository.pageSize, offset: items.length });
        items.push(...page.items);
        if (!page.hasMore || page.items.length === 0) break;
      }
      if (active) setSequence(items.slice(0, IMAGE_SEQUENCE_LIMIT));
    })().catch(() => undefined);
    return () => { active = false; };
  }, [repository, enabled, sequence]);

  return sequence;
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
