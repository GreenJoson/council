/**
 * @input  依赖：Express Response 与 Zod 校验结果
 * @output 导出：统一 JSON 响应、二进制内联出站（sendInlineBytes）和 HTTP 错误类型
 * @pos    REST 契约与内部错误之间的安全隔离层；资产原图/缩略图与项目图片共用同一套出站响应头
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Response } from "express";
import type { ZodIssue } from "zod/v4";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  readonly issues?: ValidationIssue[];

  constructor(status: number, publicMessage: string, issues?: ValidationIssue[]) {
    super(publicMessage);
    this.name = "HttpError";
    this.status = status;
    this.publicMessage = publicMessage;
    this.issues = issues;
  }
}

export function validationIssues(issues: ZodIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function sendSuccess<T>(
  response: Response,
  data: T,
  message = "success",
  status = 200,
): void {
  response.status(status).json({ code: 0, message, data, timestamp: Date.now() });
}

export interface InlineBytesPayload {
  mime: string;
  filename: string;
  bytes: Uint8Array;
}

/** 字节只经这里出站：固定 no-store/nosniff；SVG 可内嵌脚本，沙箱化并禁止脚本，即使被直接打开也不会在同源执行。 */
export function sendInlineBytes(response: Response, payload: InlineBytesPayload): void {
  response.setHeader("Content-Type", payload.mime);
  response.setHeader("Content-Disposition", `inline; filename="${payload.filename.replace(/["\\\r\n]/gu, "_")}"`);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (payload.mime === "image/svg+xml") {
    response.setHeader("Content-Security-Policy", "sandbox; script-src 'none'");
  }
  response.status(200).end(payload.bytes);
}

export function sendError(
  response: Response,
  status: number,
  message: string,
  issues?: ValidationIssue[],
): void {
  response.status(status).json({
    code: status,
    message,
    ...(issues ? { data: { issues } } : {}),
    timestamp: Date.now(),
  });
}
