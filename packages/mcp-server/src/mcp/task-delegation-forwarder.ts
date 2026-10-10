/**
 * @input  依赖：McpCouncilConfig（数据库路径、回环 HTTP 基址与转发超时）、WorkItemDelegationStore 只读查询、全局 fetch
 * @output 导出：createMcpTaskDelegationPort —— MCP 进程使用的 TaskDelegationPort
 * @pos    stdio MCP 进程不持有委派管理器：读委派走本地账本，发起委派转发到同机 HTTP 服务，避免两个进程各自驱动/中断同一批委派
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { CouncilValidationError } from "../errors.js";
import { WorkItemDelegationStore, type WorkItemDelegation } from "../orchestration/work-item-delegation-store.js";
import type { TaskDelegationPort } from "../tasks/task-service.js";
import type { McpCouncilConfig } from "../types.js";

type ForwarderConfig = Pick<McpCouncilConfig, "databasePath" | "sqliteBusyTimeoutMs" | "httpServiceUrl" | "httpForwardTimeoutMs">;

interface Envelope {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

export function createMcpTaskDelegationPort(config: ForwarderConfig): TaskDelegationPort {
  return {
    listForWorkItem(workItemId) {
      // 只读查询按次打开，避免 MCP 长连接持有额外 SQLite 句柄。
      const store = new WorkItemDelegationStore(config.databasePath, config.sqliteBusyTimeoutMs);
      try {
        return store.listForWorkItem(workItemId);
      } finally {
        store.close();
      }
    },
    async start(workItemId, input) {
      const url = `${config.httpServiceUrl}/api/v1/tasks/${encodeURIComponent(workItemId)}/delegations`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(config.httpForwardTimeoutMs),
        });
      } catch {
        throw new CouncilValidationError(
          "任务委派需要本机 Council HTTP 服务（桌面 app 或 start:http）在运行；当前无法连接，请启动后重试。",
        );
      }
      let envelope: Envelope = {};
      try {
        envelope = await response.json() as Envelope;
      } catch {
        // 非 JSON 响应按状态码给出通用说明。
      }
      if (!response.ok) {
        const message = typeof envelope.message === "string" ? envelope.message : "";
        // 4xx 文案来自 HTTP 服务的公开错误，可原样返回；5xx 不透传内部细节。
        if (response.status < 500 && message) throw new CouncilValidationError(message);
        throw new CouncilValidationError(
          response.status === 503 && message ? message : `任务委派服务返回错误（HTTP ${String(response.status)}），请查看本地服务日志。`,
        );
      }
      return envelope.data as WorkItemDelegation;
    },
  };
}
