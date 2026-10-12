/**
 * @input  依赖：Asset 类型、components/Lightbox 的 LightboxNavigation
 * @output 导出：buildAssetLightboxNavigation —— 把一组可预览资产变成 Lightbox 的上一张/下一张导航；
 *         findAssetNeighbors —— 详情页在资产库序列里的位置与前后两个资产
 * @pos    资产详情、任务产物区、流水线并排对比共用的翻页适配；序列由调用方决定（资产库顺序 / 任务产物 / 候选图），
 *         这里只做「当前项定位 + 按位置回调」，不读数据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { LightboxNavigation } from "../../components/Lightbox";
import type { Asset } from "../../types/assets";

export interface AssetNeighbors {
  index: number;
  total: number;
  previous?: Asset;
  next?: Asset;
}

/** 当前资产不在序列里（已删除、超出读取上限或序列尚未读到）时返回 undefined，详情页不显示翻页。 */
export function findAssetNeighbors(sequence: readonly Asset[] | null, currentId: string): AssetNeighbors | undefined {
  const index = sequence ? sequence.findIndex((asset) => asset.id === currentId) : -1;
  if (!sequence || index < 0) {
    return undefined;
  }
  return { index, total: sequence.length, previous: sequence[index - 1], next: sequence[index + 1] };
}

/** 当前项不在序列里（如已删除、超出读取上限）或序列不足两张时不提供导航，Lightbox 退回单张浏览。 */
export function buildAssetLightboxNavigation(
  sequence: readonly Asset[],
  currentId: string,
  onSelect: (asset: Asset) => void,
): LightboxNavigation | undefined {
  const index = sequence.findIndex((asset) => asset.id === currentId);
  if (index < 0 || sequence.length < 2) {
    return undefined;
  }
  return {
    index,
    total: sequence.length,
    onNavigate: (next) => {
      const target = sequence[next];
      if (target) onSelect(target);
    },
  };
}
