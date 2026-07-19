/**
 * @input  依赖：Express Response 与 Zod 校验结果
 * @output 导出：统一 JSON 响应和 HTTP 错误类型
 * @pos    REST 契约与内部错误之间的安全隔离层
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
