/**
 * @input  依赖：types/assets 的 kind/targetKind/role 联合类型
 * @output 导出：ASSET_KIND_LABELS、ASSET_ROLE_LABELS、ASSET_TARGET_LABELS 中文文案表（经 t() 翻译）、
 *         formatByteSize 字节数格式化、workItemLinks/finalTargets 两个 links 查询纯函数
 * @pos    资产库与任务产物区共用的展示文案与派生逻辑；不含任何 UI 组件
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  Asset,
  AssetKind,
  AssetLinkRole,
  AssetLinkTargetKind,
} from "../../types/assets";

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  image: "图像",
  model3d: "3D 模型",
  document: "文档",
  archive: "归档包",
};

export const ASSET_ROLE_LABELS: Record<AssetLinkRole, string> = {
  reference: "参考",
  output: "产物",
  final: "最终稿",
  brief: "简报附件",
};

export const ASSET_TARGET_LABELS: Record<AssetLinkTargetKind, string> = {
  work_item: "任务",
  message: "消息",
  decision: "决策",
};

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatByteSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(value)} B` : `${value.toFixed(value >= 10 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** 资产挂到的任务 id（去重），按 role 过滤。 */
export function workItemLinks(asset: Asset, role: AssetLinkRole): string[] {
  return [...new Set(asset.links
    .filter((link) => link.targetKind === "work_item" && link.role === role)
    .map((link) => link.targetId))];
}

/**
 * 「设为 final」的目标任务：资产作为 output 挂接、但还不是 final 的任务。
 * final 只对产物有意义（契约里 final 由人从 output 中挑选），因此不对 reference 挂接设 final。
 */
export function finalTargets(asset: Asset): { pending: string[]; current: string[] } {
  const current = workItemLinks(asset, "final");
  const pending = workItemLinks(asset, "output").filter((taskId) => !current.includes(taskId));
  return { pending, current };
}
