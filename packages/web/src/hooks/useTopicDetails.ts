/**
 * @input  依赖：目标议题 id 列表与只读议题详情加载回调（CouncilRepository.loadTopicDetail）
 * @output 导出：useTopicDetails —— 按 id 列表懒加载、缓存并可按 id 单独重试的 TopicDetail 集合
 * @pos    决策记录视图（单选、按需加载一条）与架构档案视图（一次性加载全部议题详情）共用的
 *         数据加载 hook，避免同一套"懒加载 + Map 缓存 + StrictMode 双挂载守卫"逻辑抄第三遍
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useEffect, useRef, useState } from "react";
import type { TopicDetail } from "../types/council";

export interface UseTopicDetailsResult {
  /** 已加载完成的议题详情，key 为 topicId；只增不删，切换 topicIds 后旧缓存依然保留 */
  details: Map<string, TopicDetail>;
  /** 正在加载中的 topicId 集合 */
  loadingIds: ReadonlySet<string>;
  /** 加载失败的 topicId -> 错误信息 */
  errors: ReadonlyMap<string, string>;
  /** 清除某个 topicId 的错误并重新发起加载 */
  retry: (topicId: string) => void;
}

/**
 * 懒加载给定 topicIds 对应的完整 TopicDetail：命中缓存的 id 跳过请求，未命中的并行加载。
 *
 * - `topicIds` 变化（内容而非引用变化——用 join 出的 key 判等）或调用 `retry` 才会重新扫描
 *   需要加载的 id，避免父组件重渲染时 `topicIds` 数组引用变化导致的请求风暴。
 * - 每次 effect 运行共享同一个 `active` 闭包标志（与 DecisionRecordsView/App.tsx 现有范式
 *   一致），组件卸载或 topicIds/retry 触发新一轮扫描时，上一轮尚未返回的响应会被丢弃，
 *   不会写入过期数据；StrictMode 开发期的双挂载因此也不会产生脏状态。
 * - `onLoadDetail` 走 ref：父组件每次渲染都可能创建新的函数引用，不应因此触发多余请求。
 */
export function useTopicDetails(
  topicIds: readonly string[],
  onLoadDetail: (topicId: string) => Promise<TopicDetail>,
): UseTopicDetailsResult {
  const [details, setDetails] = useState<Map<string, TopicDetail>>(() => new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [retryTicks, setRetryTicks] = useState<Map<string, number>>(() => new Map());

  const onLoadDetailRef = useRef(onLoadDetail);
  onLoadDetailRef.current = onLoadDetail;

  const idsKey = topicIds.join("\u0000");
  const retryKey = [...retryTicks.entries()].map(([id, tick]) => `${id}:${String(tick)}`).join("\u0000");

  useEffect(() => {
    const ids = idsKey.length > 0 ? idsKey.split("\u0000") : [];
    const idsToLoad = ids.filter((id) => !details.has(id));
    if (idsToLoad.length === 0) {
      return;
    }

    let active = true;
    setLoadingIds((current) => {
      const next = new Set(current);
      idsToLoad.forEach((id) => next.add(id));
      return next;
    });
    setErrors((current) => {
      if (idsToLoad.every((id) => !current.has(id))) {
        return current;
      }
      const next = new Map(current);
      idsToLoad.forEach((id) => next.delete(id));
      return next;
    });

    idsToLoad.forEach((id) => {
      void onLoadDetailRef.current(id)
        .then((detail) => {
          if (!active) {
            return; // 本轮已被新一轮扫描取代：过期响应，丢弃
          }
          setDetails((current) => new Map(current).set(id, detail));
        })
        .catch((error: unknown) => {
          if (!active) {
            return;
          }
          setErrors((current) =>
            new Map(current).set(id, error instanceof Error ? error.message : "加载议题详情失败"));
        })
        .finally(() => {
          if (!active) {
            return;
          }
          setLoadingIds((current) => {
            if (!current.has(id)) {
              return current;
            }
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        });
    });

    return () => {
      active = false;
    };
    // details 只用于判断本轮是否命中缓存，不放入依赖数组：写入缓存会立刻重触发本 effect，
    // 造成"加载一条、扫描一次"的连锁重渲染；idsKey/retryKey 才是真正应该触发重新扫描的信号。
  }, [idsKey, retryKey]);

  function retry(topicId: string): void {
    setErrors((current) => {
      if (!current.has(topicId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(topicId);
      return next;
    });
    setRetryTicks((current) => {
      const next = new Map(current);
      next.set(topicId, (next.get(topicId) ?? 0) + 1);
      return next;
    });
  }

  return { details, loadingIds, errors, retry };
}
