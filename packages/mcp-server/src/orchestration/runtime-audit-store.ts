/**
 * @input  依赖：统一 RuntimeEvent、运行阶段公开摘要与 SQLite
 * @output 导出：只追加的运行审计记录和游标分页查询
 * @pos    审计只收录明确允许的字段，不保存草稿、原始工具参数或私有会话
 */
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent, RuntimeEventSink } from "council-orchestrator";

export interface AuditEvent {
  id: number;
  topicId: string;
  sourceKind: "run" | "delegation";
  sourceId: string;
  attempt: number;
  kind: string;
  data: Record<string, string | number>;
  createdAt: string;
}

/** 审计摘要会展示给客户端；常见地址、用户路径与凭据必须先剔除。 */
export function redactAuditText(value: string): string {
  return value
    .replace(/(["'])(?:\/|[A-Z]:\\)[^"'\r\n]+\1/giu, "<path>")
    .replace(/https?:\/\/[^\s<>"']+/giu, "<url>")
    .replace(/(?:\d{1,3}\.){3}\d{1,3}/gu, "<address>")
    .replace(/(?:\/[^\s/<>"'`]+){2,}/gu, "<path>")
    .replace(/(?:[A-Z]:\\)(?:[^\s\\]+\\)*[^\s\\]*/giu, "<path>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<email>")
    .replace(/(?:bearer\s+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*)\S+/giu, "<credential>")
    .slice(0, 8_000);
}

export class RuntimeAuditStore implements RuntimeEventSink {
  readonly #database: DatabaseSync;

  constructor(databasePath: string, busyTimeoutMs: number) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
  }

  append(input: Omit<AuditEvent, "id" | "createdAt">): void {
    const data = Object.fromEntries(Object.entries(input.data).map(([key, value]) => [
      key, typeof value === "string" ? redactAuditText(value) : value,
    ]));
    this.#database.prepare(`
      INSERT INTO runtime_audit_events (topic_id, source_kind, source_id, attempt, kind, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.topicId, input.sourceKind, input.sourceId, input.attempt, input.kind, JSON.stringify(data), new Date().toISOString());
  }

  emit(event: RuntimeEvent): void {
    // 文本草稿只经 SSE 展示。ACP used 是上下文占用，不能冒充计费用量。
    if (event.type === "text.updated" || event.type === "usage.updated") return;
    const data: AuditEvent["data"] = { agentId: event.adapterId, bindingId: event.runtimeBindingId };
    if ("toolName" in event) {
      data.toolName = event.toolName;
      data.callId = event.callId;
      data.owner = event.owner;
    }
    this.append({ topicId: event.topicId, sourceKind: "run", sourceId: event.runId, attempt: 0, kind: event.type, data });
  }

  list(topicId: string, sourceKind: AuditEvent["sourceKind"], sourceId: string, after = 0) {
    const rows = this.#database.prepare(`
      SELECT * FROM runtime_audit_events WHERE topic_id = ? AND source_kind = ? AND source_id = ? AND id > ?
      ORDER BY id LIMIT 101
    `).all(topicId, sourceKind, sourceId, after) as unknown as Array<{
      id: number; topic_id: string; source_kind: AuditEvent["sourceKind"]; source_id: string;
      attempt: number; kind: string; data_json: string; created_at: string;
    }>;
    const events = rows.slice(0, 100).map((row): AuditEvent => ({
      id: row.id, topicId: row.topic_id, sourceKind: row.source_kind, sourceId: row.source_id,
      attempt: row.attempt, kind: row.kind, data: JSON.parse(row.data_json) as AuditEvent["data"], createdAt: row.created_at,
    }));
    return { events, hasMore: rows.length > 100, nextCursor: events.at(-1)?.id ?? after };
  }

  close(): void { this.#database.close(); }
}
