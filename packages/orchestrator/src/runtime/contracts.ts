/**
 * @input  依赖：RuntimeBinding 与冻结的 Runtime 能力词表
 * @output 导出：RuntimeSessionRef 投影、统一 RuntimeEvent、事件 Sink 与工具所有权校验
 * @pos    Agent / Runtime / Provider 三层之间的最小稳定协议；不持久化第二份 session 状态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { OrchestrationConfigError } from "../errors.js";
import type { RuntimeCapabilityKey } from "../cycle/runtime-capabilities.js";
import type { RuntimeBinding, RuntimeBindingCursor } from "../types.js";

export type RuntimeExecutionKind = "delegated" | "tool-loop";
export type RuntimeToolOwner = "council" | "runtime";
export type RuntimeTextOperation = "reset" | "append" | "replace";

/**
 * RuntimeBinding 的只读投影。它只用于跨层传递，不得独立写库或成为第二份 session 真源。
 */
export interface RuntimeSessionRef {
  schemaVersion: 1;
  bindingId: string;
  topicId: string;
  agentId: string;
  providerId: string;
  transportKind: RuntimeBinding["transportKind"];
  bindingRevision: string;
  epoch: number;
  sessionId?: string;
  cursor?: RuntimeBindingCursor;
}

interface RuntimeEventBase {
  schemaVersion: 1;
  occurredAt: string;
  runId: string;
  topicId: string;
  adapterId: string;
  runtimeBindingId: string;
}

export interface RuntimeTurnStartedEvent extends RuntimeEventBase {
  type: "turn.started";
}

export interface RuntimeTextUpdatedEvent extends RuntimeEventBase {
  type: "text.updated";
  operation: RuntimeTextOperation;
  content?: string;
}

export interface RuntimeToolEvent extends RuntimeEventBase {
  type:
    | "tool.requested"
    | "approval.required"
    | "tool.started"
    | "tool.completed";
  callId: string;
  toolName: string;
  owner: RuntimeToolOwner;
}

export interface RuntimeUsageUpdatedEvent extends RuntimeEventBase {
  type: "usage.updated";
  inputTokens?: number;
  outputTokens?: number;
}

export interface RuntimeTurnFinishedEvent extends RuntimeEventBase {
  type: "turn.completed" | "turn.failed" | "turn.aborted";
}

export type RuntimeEvent =
  | RuntimeTurnStartedEvent
  | RuntimeTextUpdatedEvent
  | RuntimeToolEvent
  | RuntimeUsageUpdatedEvent
  | RuntimeTurnFinishedEvent;

export interface RuntimeEventSink {
  emit(event: RuntimeEvent): void;
}

const COUNCIL_TOOL_LOOP_CAPABILITIES = new Set<RuntimeCapabilityKey>([
  "repository_read",
]);

export function runtimeSessionRefFromBinding(
  binding: RuntimeBinding,
): RuntimeSessionRef {
  return {
    schemaVersion: 1,
    bindingId: binding.id,
    topicId: binding.topicId,
    agentId: binding.agentId,
    providerId: binding.providerId,
    transportKind: binding.transportKind,
    bindingRevision: binding.bindingRevision,
    epoch: binding.epoch,
    ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
    ...(binding.cursor ? { cursor: { ...binding.cursor } } : {}),
  };
}

/**
 * 工具执行默认拒绝：delegated Runtime 自己拥有工具；Council ToolLoop 只拥有只读工具。
 * 原始工具参数不属于 RuntimeEvent，避免进入公开 SSE 或日志。
 */
export function assertRuntimeToolEventAllowed(
  event: RuntimeToolEvent,
  context: Readonly<{
    executionKind: RuntimeExecutionKind;
    grantedCapabilities: readonly RuntimeCapabilityKey[];
    /** 必须来自本地 ToolHost/Runtime Adapter 注册表，不能来自模型事件。 */
    registeredCapability?: RuntimeCapabilityKey;
  }>,
): void {
  const expectedOwner: RuntimeToolOwner = context.executionKind === "delegated"
    ? "runtime"
    : "council";
  if (event.owner !== expectedOwner) {
    throw new OrchestrationConfigError(
      `Runtime 工具所有权冲突：${context.executionKind} 必须由 ${expectedOwner} 执行。`,
    );
  }
  if (context.registeredCapability === undefined) {
    throw new OrchestrationConfigError(
      `Runtime 请求了未注册工具：${event.toolName}。`,
    );
  }
  if (!context.grantedCapabilities.includes(context.registeredCapability)) {
    throw new OrchestrationConfigError(
      `Runtime 未获授权能力：${context.registeredCapability}。`,
    );
  }
  if (
    context.executionKind === "tool-loop"
    && !COUNCIL_TOOL_LOOP_CAPABILITIES.has(context.registeredCapability)
  ) {
    throw new OrchestrationConfigError(
      `Council ToolLoop 禁止执行非只读能力：${context.registeredCapability}。`,
    );
  }
}
