/**
 * @input  依赖：localStorage（键 council.cycle.roundBudget）与 React useSyncExternalStore
 * @output 导出：DEFAULT/MIN/MAX_CYCLE_ROUND_BUDGET、readCycleRoundBudget、writeCycleRoundBudget、
 *         subscribeCycleRoundBudget、useCycleRoundBudget
 * @pos    圆桌轮次上限的唯一读写边界：偏好对话框写、圆桌开局读并随请求送给服务端；
 *         服务端仍以自己的硬上限兜底，这里只负责前端偏好的夹取与跨组件同步
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useSyncExternalStore } from "react";

export const DEFAULT_CYCLE_ROUND_BUDGET = 3;
export const MIN_CYCLE_ROUND_BUDGET = 1;
export const MAX_CYCLE_ROUND_BUDGET = 10;

const STORAGE_KEY = "council.cycle.roundBudget";
const listeners = new Set<() => void>();

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CYCLE_ROUND_BUDGET;
  }
  return Math.min(MAX_CYCLE_ROUND_BUDGET, Math.max(MIN_CYCLE_ROUND_BUDGET, Math.round(value)));
}

/** 读取当前轮次上限；存储不可用或值非法时回落默认值，不抛错。 */
export function readCycleRoundBudget(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_CYCLE_ROUND_BUDGET : clampBudget(Number(raw));
  } catch {
    return DEFAULT_CYCLE_ROUND_BUDGET;
  }
}

/** 夹取到 [MIN, MAX] 后持久化，并通知所有订阅者；存储不可用时只在会话内生效。 */
export function writeCycleRoundBudget(value: number): number {
  const next = clampBudget(value);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // 本地存储不可用时静默降级：订阅者仍会收到通知并重新读取（读取同样回落默认值）
  }
  listeners.forEach((listener) => listener());
  return next;
}

export function subscribeCycleRoundBudget(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 组件侧读取轮次上限；服务端渲染（测试）时返回默认值。 */
export function useCycleRoundBudget(): number {
  return useSyncExternalStore(
    subscribeCycleRoundBudget,
    readCycleRoundBudget,
    () => DEFAULT_CYCLE_ROUND_BUDGET,
  );
}
