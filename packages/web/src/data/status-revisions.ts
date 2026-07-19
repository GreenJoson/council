/**
 * @input  依赖：GET /api/v1/status 的未知 data
 * @output 导出：总 revision、内容 revision 与编排 revision 严格解析器
 * @pos    内容仓储和编排仓储进行 SSE 分流的共享协议边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export interface CouncilStatusRevisions {
  revision: number;
  content: number;
  orchestration: number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} 必须是非负安全整数`);
  }
  return value;
}

export function parseCouncilStatusRevisions(data: unknown): CouncilStatusRevisions {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("status 必须是对象");
  }
  const record = data as Record<string, unknown>;
  const revisions = record.revisions;
  if (typeof revisions !== "object" || revisions === null || Array.isArray(revisions)) {
    throw new Error("status.revisions 必须是对象");
  }
  const revisionRecord = revisions as Record<string, unknown>;
  return {
    revision: nonNegativeInteger(record.revision, "status.revision"),
    content: nonNegativeInteger(revisionRecord.content, "status.revisions.content"),
    orchestration: nonNegativeInteger(
      revisionRecord.orchestration,
      "status.revisions.orchestration",
    ),
  };
}
