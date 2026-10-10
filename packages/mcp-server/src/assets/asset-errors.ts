/**
 * @input  依赖：errors.ts 的 CouncilValidationError
 * @output 导出：AssetRejectedError（带拒绝原因码）、AssetRejectReason、assetRejectHttpStatus（原因码 → HTTP 状态码）
 * @pos    资产入库/导入失败的统一错误语义：继承校验错误，MCP 与通用 HTTP 映射为 400，
 *         资产路由再按原因码细化为 403/404/413/415/507；文案不含任何绝对路径
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { CouncilValidationError } from "../errors.js";

export type AssetRejectReason =
  | "outside_project"
  | "protected_path"
  | "symlink"
  | "not_found"
  | "not_file"
  | "too_large"
  | "quota_exceeded"
  | "unsupported_type";

export class AssetRejectedError extends CouncilValidationError {
  constructor(readonly reason: AssetRejectReason, message: string) {
    super(message);
    this.name = "AssetRejectedError";
  }
}

const HTTP_STATUS: Record<AssetRejectReason, number> = {
  outside_project: 403,
  protected_path: 403,
  symlink: 403,
  not_found: 404,
  not_file: 415,
  too_large: 413,
  quota_exceeded: 507,
  unsupported_type: 415,
};

export function assetRejectHttpStatus(reason: AssetRejectReason): number {
  return HTTP_STATUS[reason];
}
