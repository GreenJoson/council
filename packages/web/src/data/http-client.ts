/**
 * @input  依赖：Fetch API、Council canonical JSON 响应与运行时解析器
 * @output 导出：统一 HTTP 请求函数、URL 构造器和可识别请求错误
 * @pos    REST 传输层，集中处理响应协议与安全错误信息
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { parseApiEnvelope } from "./api-types";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CouncilApiError extends Error {
  readonly httpStatus: number;
  readonly code?: number;

  constructor(message: string, httpStatus: number, code?: number) {
    super(message);
    this.name = "CouncilApiError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export function createApiUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string | number | undefined>> = {},
): URL {
  let url: URL;
  try {
    url = new URL(path, baseUrl);
  } catch {
    throw new Error("VITE_COUNCIL_API_URL 必须是有效的绝对 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("VITE_COUNCIL_API_URL 只允许 http 或 https 协议");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function requestApiData<T>(
  fetcher: Fetcher,
  url: URL,
  parser: (value: unknown) => T,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "网络连接失败";
    throw new CouncilApiError(`无法连接 Council API：${detail}`, 0);
  }

  let raw: unknown;
  try {
    raw = await response.json() as unknown;
  } catch {
    throw new CouncilApiError("Council API 返回了无法解析的 JSON", response.status);
  }

  let envelope;
  try {
    envelope = parseApiEnvelope(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "响应结构无效";
    throw new CouncilApiError(`Council API 响应协议无效：${detail}`, response.status);
  }

  if (!response.ok || envelope.code !== 0) {
    throw new CouncilApiError(envelope.message, response.status, envelope.code);
  }
  if (envelope.data === undefined) {
    throw new CouncilApiError("Council API 成功响应缺少 data", response.status, envelope.code);
  }

  try {
    return parser(envelope.data);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "data 结构无效";
    throw new CouncilApiError(`Council API 数据协议无效：${detail}`, response.status, envelope.code);
  }
}

export function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
