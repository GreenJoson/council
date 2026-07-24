/**
 * @input  依赖：Council orchestration REST/SSE API 的未知 JSON data
 * @output 导出：含动态 actorId 的 Capabilities、Run、分页与 Agent 增量事件严格解析函数
 * @pos    自动轮次仓储唯一 REST/SSE 协议校验入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  OrchestrationAdapter,
  OrchestrationAgentOutput,
  OrchestrationCapabilities,
  OrchestrationDefaultPolicy,
  OrchestrationFailure,
  OrchestrationMessageKind,
  OrchestrationRoundPlan,
  OrchestrationRun,
  OrchestrationStatus,
} from "../types/orchestration";

export type AgentOutputOperation =
  | "snapshot"
  | "reset"
  | "append"
  | "replace"
  | "complete";

export interface ApiAgentOutputEvent extends Omit<OrchestrationAgentOutput, "content"> {
  operation: AgentOutputOperation;
  content?: string;
}

export interface ApiOrchestrationRunPage {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  runs: OrchestrationRun[];
}

export interface ApiOrchestrationApprovalResult {
  run: OrchestrationRun;
  applied: boolean;
}

const STATUSES: readonly OrchestrationStatus[] = [
  "idle", "running", "waiting_agent", "waiting_user", "completed", "failed", "cancelled",
];
const MESSAGE_KINDS: readonly OrchestrationMessageKind[] = [
  "brief", "proposal", "critique", "rebuttal", "synthesis", "note",
];
const AGENT_OUTPUT_OPERATIONS: readonly AgentOutputOperation[] = [
  "snapshot", "reset", "append", "replace", "complete",
];

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown>, key: string, path = key): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} 必须是非空字符串`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value;
}

function integerValue(record: Record<string, unknown>, key: string, minimum = 0): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${key} 必须是不小于 ${String(minimum)} 的安全整数`);
  }
  return value;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} 必须是布尔值`);
  }
  return value;
}

function enumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = stringValue(record, key);
  if (!allowed.includes(value as T)) {
    throw new Error(`${key} 包含不支持的值`);
  }
  return value as T;
}

function arrayValue<T>(
  record: Record<string, unknown>,
  key: string,
  parser: (value: unknown, index: number) => T,
): T[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} 必须是数组`);
  }
  return value.map(parser);
}

function parseAdapter(value: unknown): OrchestrationAdapter {
  const record = recordValue(value, "adapter");
  const limitation = optionalString(record, "limitation");
  return {
    id: stringValue(record, "id"),
    actorId: stringValue(record, "actorId"),
    label: stringValue(record, "label"),
    available: booleanValue(record, "available"),
    ...(limitation ? { limitation } : {}),
  };
}

function parsePolicy(value: unknown): OrchestrationDefaultPolicy {
  const record = recordValue(value, "defaultPolicy");
  const confirmation = recordValue(record.confirmation, "defaultPolicy.confirmation");
  return {
    maxRounds: integerValue(record, "maxRounds", 1),
    agentTimeoutMs: integerValue(record, "agentTimeoutMs", 1),
    maxAttemptsPerRound: integerValue(record, "maxAttemptsPerRound", 1),
    maxManualRecoveries: integerValue(record, "maxManualRecoveries"),
    confirmation: {
      beforeRounds: arrayValue(confirmation, "beforeRounds", (item, index) => {
        if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1) {
          throw new Error(`beforeRounds[${String(index)}] 必须是正安全整数`);
        }
        return item;
      }),
      beforeCompletion: booleanValue(confirmation, "beforeCompletion"),
    },
  };
}

function parseRound(value: unknown): OrchestrationRoundPlan {
  const record = recordValue(value, "round");
  return {
    adapterId: stringValue(record, "adapterId"),
    actorId: stringValue(record, "actorId"),
    messageKind: enumValue(record, "messageKind", MESSAGE_KINDS),
    instruction: stringValue(record, "instruction"),
  };
}

function parseFailure(value: unknown): OrchestrationFailure {
  const record = recordValue(value, "failure");
  return {
    code: stringValue(record, "code"),
    message: stringValue(record, "message"),
    retryable: booleanValue(record, "retryable"),
  };
}

export function parseOrchestrationCapabilities(value: unknown): OrchestrationCapabilities {
  const record = recordValue(value, "capabilities");
  return {
    adapters: arrayValue(record, "adapters", (item) => parseAdapter(item)),
    defaultPolicy: parsePolicy(record.defaultPolicy),
  };
}

export function parseOrchestrationRun(value: unknown): OrchestrationRun {
  const record = recordValue(value, "run");
  const pendingGateId = optionalString(record, "pendingGateId");
  const activeAgentId = optionalString(record, "activeAgentId");
  const stopReason = optionalString(record, "stopReason");
  const failure = record.failure === undefined ? undefined : parseFailure(record.failure);
  return {
    id: stringValue(record, "id"),
    topicId: stringValue(record, "topicId"),
    status: enumValue(record, "status", STATUSES),
    plan: arrayValue(record, "plan", (item) => parseRound(item)),
    policy: parsePolicy(record.policy),
    nextRoundIndex: integerValue(record, "nextRoundIndex"),
    currentAttempt: integerValue(record, "currentAttempt"),
    manualRecoveriesUsed: integerValue(record, "manualRecoveriesUsed"),
    confirmedGates: arrayValue(record, "confirmedGates", (item, index) => {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`confirmedGates[${String(index)}] 必须是非空字符串`);
      }
      return item;
    }),
    ...(pendingGateId ? { pendingGateId } : {}),
    ...(activeAgentId ? { activeAgentId } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(failure ? { failure } : {}),
    version: integerValue(record, "version", 1),
    createdAt: stringValue(record, "createdAt"),
    updatedAt: stringValue(record, "updatedAt"),
  };
}

export function parseOrchestrationRunPage(value: unknown): ApiOrchestrationRunPage {
  const record = recordValue(value, "runs page");
  const nextOffset = record.nextOffset === undefined
    ? undefined
    : integerValue(record, "nextOffset");
  return {
    total: integerValue(record, "total"),
    count: integerValue(record, "count"),
    offset: integerValue(record, "offset"),
    hasMore: booleanValue(record, "hasMore"),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    runs: arrayValue(record, "runs", (item) => parseOrchestrationRun(item)),
  };
}

export function parseOrchestrationApprovalResult(
  value: unknown,
): ApiOrchestrationApprovalResult {
  const record = recordValue(value, "approval result");
  return {
    run: parseOrchestrationRun(record.run),
    applied: booleanValue(record, "applied"),
  };
}

export function parseAgentOutputEvent(event: Event): ApiAgentOutputEvent | undefined {
  const data = (event as unknown as { data?: unknown }).data;
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(data);
    const record = recordValue(value, "agent.output");
    const operation = enumValue(record, "operation", AGENT_OUTPUT_OPERATIONS);
    const content = record.content;
    if (
      operation !== "complete"
      && operation !== "reset"
      && typeof content !== "string"
    ) {
      return undefined;
    }
    if (content !== undefined && typeof content !== "string") {
      return undefined;
    }
    return {
      runId: stringValue(record, "runId"),
      topicId: stringValue(record, "topicId"),
      adapterId: stringValue(record, "adapterId"),
      sequence: integerValue(record, "sequence", 1),
      operation,
      ...(typeof content === "string" ? { content } : {}),
    };
  } catch {
    return undefined;
  }
}
