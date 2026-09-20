/**
 * @input  依赖：运行审计 REST 响应
 * @output 导出：审计分页类型与严格解析
 * @pos    只接受公开摘要；不把任意服务端对象直接渲染为日志
 */
export interface RuntimeAuditEvent {
  id: number;
  attempt: number;
  kind: string;
  data: Record<string, string | number>;
  createdAt: string;
}
export interface RuntimeAuditPage {
  events: RuntimeAuditEvent[];
  hasMore: boolean;
  nextCursor: number;
}
export interface RuntimeAuditQuery {
  topicId: string;
  sourceKind: "run" | "delegation";
  sourceId: string;
  after?: number;
}

export function parseRuntimeAuditPage(value: unknown): RuntimeAuditPage {
  if (typeof value !== "object" || value === null) throw new Error("运行记录格式无效");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.events) || typeof page.hasMore !== "boolean"
    || !Number.isSafeInteger(page.nextCursor) || Number(page.nextCursor) < 0) throw new Error("运行记录分页无效");
  const events = page.events.map((value): RuntimeAuditEvent => {
    if (typeof value !== "object" || value === null) throw new Error("运行事件无效");
    const event = value as Record<string, unknown>;
    if (!Number.isSafeInteger(event.id) || Number(event.id) < 1 || !Number.isSafeInteger(event.attempt)
      || Number(event.attempt) < 0 || typeof event.kind !== "string" || typeof event.createdAt !== "string"
      || !event.data || typeof event.data !== "object" || Array.isArray(event.data)
      || Object.values(event.data).some((entry) => typeof entry !== "string" && (typeof entry !== "number" || !Number.isFinite(entry)))) {
      throw new Error("运行事件字段无效");
    }
    return event as unknown as RuntimeAuditEvent;
  });
  return { events, hasMore: page.hasMore, nextCursor: Number(page.nextCursor) };
}
