/**
 * @input  依赖：Council orchestration REST/SSE API 的未知 JSON data
 * @output 导出：含动态 actorId 的 Capabilities、Run、持久会话与 Agent 增量事件严格解析函数
 * @pos    自动轮次仓储唯一 REST/SSE 协议校验入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  CycleMetrics,
  CycleStage,
  CycleTurn,
  DiscussionCycle,
  DiscussionCycleView,
  OrchestrationAdapter,
  OrchestrationAgentOutput,
  OrchestrationCapabilities,
  OrchestrationDefaultPolicy,
  OrchestrationFailure,
  OrchestrationMessageKind,
  OrchestrationRoundPlan,
  OrchestrationRun,
  OrchestrationStatus,
  RuntimeBinding,
  RuntimeBindingStatus,
  RuntimeCapabilityKey,
  RuntimeTransportKind,
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
const DEBATE_STAGES: readonly CycleTurn["stage"][] = [
  "proposal", "critique", "rebuttal", "synthesis",
];
const CYCLE_STAGES: readonly CycleStage[] = [
  ...DEBATE_STAGES, "awaiting_user", "completed",
];
const CYCLE_STATUSES: readonly DiscussionCycle["status"][] = [
  "active", "completed", "abandoned",
];
const VERDICT_STANCES: readonly CycleTurn["stance"][] = [
  "agree", "non_blocking", "blocking",
];
const AGENT_OUTPUT_OPERATIONS: readonly AgentOutputOperation[] = [
  "snapshot", "reset", "append", "replace", "complete",
];
const RUNTIME_BINDING_STATUSES: readonly RuntimeBindingStatus[] = [
  "starting", "ready", "thinking", "streaming", "idle", "interrupted", "closing", "closed",
];
const RUNTIME_TRANSPORT_KINDS: readonly RuntimeTransportKind[] = [
  "claude-resume", "codex-resume", "acp",
  "openai-tool-loop", "openai-sessionless",
];
const RUNTIME_CAPABILITY_KEYS: readonly RuntimeCapabilityKey[] = [
  "text",
  "repository_read",
  "repository_write",
  "shell_read",
  "shell_write",
  "tests",
  "git_diff",
  "git_commit",
  "media_read",
  "vision",
  "session_resume",
];
const CYCLE_KINDS: readonly DiscussionCycle["kind"][] = [
  "discussion",
  "fix_review",
];
const CYCLE_STOP_REASONS = [
  "converged",
  "round_budget_exhausted",
  "decision_accepted",
  "cancelled",
] as const;

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

function schemaVersionOne(record: Record<string, unknown>, path: string): 1 {
  if (record.schemaVersion !== 1) {
    throw new Error(`${path}.schemaVersion 必须是受支持的版本 1`);
  }
  return 1;
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} 必须是非负有限数`);
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

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} 必须是布尔值`);
  }
  return value;
}

function parseCapabilityArray(
  record: Record<string, unknown>,
  key: string,
): RuntimeCapabilityKey[] {
  return arrayValue(record, key, (item, index) => {
    if (
      typeof item !== "string"
      || !RUNTIME_CAPABILITY_KEYS.includes(item as RuntimeCapabilityKey)
    ) {
      throw new Error(`${key}[${String(index)}] 包含不支持的能力`);
    }
    return item as RuntimeCapabilityKey;
  });
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
  const mentionAlias = optionalString(record, "mentionAlias");
  const providerId = optionalString(record, "providerId");
  const providerName = optionalString(record, "providerName");
  const brandRecord = record.brand === undefined
    ? undefined
    : recordValue(record.brand, "adapter.brand");
  return {
    id: stringValue(record, "id"),
    actorId: stringValue(record, "actorId"),
    label: stringValue(record, "label"),
    ...(mentionAlias ? { mentionAlias } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerName ? { providerName } : {}),
    ...(brandRecord ? {
      brand: {
        glyphId: stringValue(brandRecord, "glyphId"),
        colorToken: stringValue(brandRecord, "colorToken"),
        displayName: stringValue(brandRecord, "displayName"),
      },
    } : {}),
    available: booleanValue(record, "available"),
    runtimeCapabilities: parseCapabilityArray(record, "runtimeCapabilities"),
    ...(limitation ? { limitation } : {}),
  };
}

function parsePolicy(value: unknown): OrchestrationDefaultPolicy {
  const record = recordValue(value, "defaultPolicy");
  const confirmation = recordValue(record.confirmation, "defaultPolicy.confirmation");
  return {
    maxRounds: integerValue(record, "maxRounds", 1),
    agentIdleTimeoutMs: integerValue(record, "agentIdleTimeoutMs", 1),
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

export function parseDiscussionCycleView(value: unknown): DiscussionCycleView | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = recordValue(value, "cycle view");
  const cycleRecord = recordValue(record.cycle, "cycle");
  const proposedDecisionId = optionalString(cycleRecord, "proposedDecisionId");
  const stopReason = cycleRecord.stopReason === undefined
    ? undefined
    : enumValue(cycleRecord, "stopReason", CYCLE_STOP_REASONS);
  const outcomeRecord = cycleRecord.outcome === undefined
    ? undefined
    : recordValue(cycleRecord.outcome, "cycle.outcome");
  const kind = enumValue(cycleRecord, "kind", CYCLE_KINDS);
  const requirementsRecord = recordValue(cycleRecord.requirements, "cycle.requirements");
  const taskRecord = recordValue(requirementsRecord.task, "cycle.requirements.task");
  const byParticipantRecord = recordValue(
    requirementsRecord.byParticipant,
    "cycle.requirements.byParticipant",
  );
  const runtimeCapabilities = arrayValue(
    cycleRecord,
    "runtimeCapabilities",
    (item) => {
      const snapshot = recordValue(item, "runtime capability snapshot");
      return {
        schemaVersion: schemaVersionOne(snapshot, "runtime capability snapshot"),
        adapterId: stringValue(snapshot, "adapterId"),
        actorId: stringValue(snapshot, "actorId"),
        agentConfigRevision: integerValue(snapshot, "agentConfigRevision"),
        providerId: stringValue(snapshot, "providerId"),
        providerConfigRevision: integerValue(snapshot, "providerConfigRevision"),
        bindingRevision: stringValue(snapshot, "bindingRevision"),
        transportKind: stringValue(snapshot, "transportKind"),
        declared: parseCapabilityArray(snapshot, "declared"),
        granted: parseCapabilityArray(snapshot, "granted"),
      };
    },
  );
  const byParticipant = Object.fromEntries(
    Object.entries(byParticipantRecord).map(([adapterId, capabilities]) => {
      const holder = { capabilities };
      return [adapterId, parseCapabilityArray(holder, "capabilities")];
    }),
  );
  const cycle: DiscussionCycle = {
    id: stringValue(cycleRecord, "id"),
    topicId: stringValue(cycleRecord, "topicId"),
    stage: enumValue(cycleRecord, "stage", CYCLE_STAGES),
    status: enumValue(cycleRecord, "status", CYCLE_STATUSES),
    participants: arrayValue(cycleRecord, "participants", (item, index) => {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`participants[${String(index)}] 必须是非空字符串`);
      }
      return item;
    }),
    kind,
    requirements: {
      schemaVersion: schemaVersionOne(requirementsRecord, "cycle.requirements"),
      cycleKind: enumValue(requirementsRecord, "cycleKind", CYCLE_KINDS),
      task: {
        all: parseCapabilityArray(taskRecord, "all"),
        proposer: parseCapabilityArray(taskRecord, "proposer"),
        reviewers: parseCapabilityArray(taskRecord, "reviewers"),
      },
      byParticipant,
    },
    runtimeCapabilities,
    turns: arrayValue(cycleRecord, "turns", (item) => {
      const turn = recordValue(item, "turn");
      const commitRef = optionalString(turn, "commitRef");
      const verdictDeclared = optionalBoolean(turn, "verdictDeclared");
      return {
        agentId: stringValue(turn, "agentId"),
        stage: enumValue(turn, "stage", DEBATE_STAGES),
        round: integerValue(turn, "round"),
        stance: enumValue(turn, "stance", VERDICT_STANCES),
        messageId: stringValue(turn, "messageId"),
        ...(commitRef ? { commitRef } : {}),
        ...(verdictDeclared === undefined ? {} : { verdictDeclared }),
      };
    }),
    roundBudget: integerValue(cycleRecord, "roundBudget", 1),
    currentRound: integerValue(cycleRecord, "currentRound", 1),
    ...(proposedDecisionId ? { proposedDecisionId } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(outcomeRecord ? {
      outcome: {
        kind: enumValue(
          outcomeRecord,
          "kind",
          ["blocking_disagreements"] as const,
        ),
        items: arrayValue(outcomeRecord, "items", (item) => {
          const entry = recordValue(item, "cycle.outcome.item");
          return {
            agentId: stringValue(entry, "agentId"),
            round: integerValue(entry, "round", 1),
            messageId: stringValue(entry, "messageId"),
          };
        }),
      },
    } : {}),
  };
  const participantSet = new Set(cycle.participants);
  const snapshotIds = cycle.runtimeCapabilities.map((snapshot) => snapshot.adapterId);
  const requirementIds = Object.keys(cycle.requirements.byParticipant);
  if (
    participantSet.size !== cycle.participants.length
    || cycle.requirements.cycleKind !== cycle.kind
    || snapshotIds.length !== cycle.participants.length
    || new Set(snapshotIds).size !== snapshotIds.length
    || cycle.participants.some((participant) => !snapshotIds.includes(participant))
    || requirementIds.length !== cycle.participants.length
    || cycle.participants.some((participant) => !requirementIds.includes(participant))
    || cycle.runtimeCapabilities.some((snapshot) => {
      const declared = new Set(snapshot.declared);
      return snapshot.granted.some((capability) => !declared.has(capability));
    })
    || cycle.turns.some(
      (turn) =>
        !participantSet.has(turn.agentId)
        || turn.round < 1
        || turn.round > cycle.currentRound,
    )
  ) {
    throw new Error("cycle 冻结名册、需求或 Runtime 能力快照不一致");
  }
  if (
    cycle.outcome
    && (
      cycle.status !== "abandoned"
      || cycle.stopReason !== "round_budget_exhausted"
      || cycle.outcome.items.some(
        (item) =>
          !participantSet.has(item.agentId)
          || item.round > cycle.currentRound
          || !cycle.turns.some((turn) => turn.messageId === item.messageId),
      )
    )
  ) {
    throw new Error("cycle 终局详情与持久化状态不一致");
  }
  if (record.openQuestion === undefined || record.openQuestion === null) {
    return { cycle };
  }
  const questionRecord = recordValue(record.openQuestion, "openQuestion");
  return {
    cycle,
    openQuestion: {
      id: stringValue(questionRecord, "id"),
      askedByActorId: stringValue(questionRecord, "askedByActorId"),
      question: stringValue(questionRecord, "question"),
      rationale: stringValue(questionRecord, "rationale"),
      options: arrayValue(questionRecord, "options", (item, index) => {
        if (typeof item !== "string") {
          throw new Error(`options[${String(index)}] 必须是字符串`);
        }
        return item;
      }),
      questionMessageId: stringValue(questionRecord, "questionMessageId"),
    },
  };
}

function parseDistribution(value: unknown, path: string): CycleMetrics["rounds"] {
  const record = recordValue(value, path);
  return {
    count: integerValue(record, "count"),
    mean: integerValue(record, "mean"),
    median: integerValue(record, "median"),
    max: integerValue(record, "max"),
  };
}

export function parseCycleMetrics(value: unknown): CycleMetrics {
  const record = recordValue(value, "cycle metrics");
  const cycles = recordValue(record.cycles, "cycles");
  const questions = recordValue(record.questions, "questions");
  const verdicts = recordValue(record.verdicts, "verdicts");
  const consistency = recordValue(record.decisionConsistency, "decisionConsistency");
  return {
    cycles: {
      total: integerValue(cycles, "total"),
      converged: integerValue(cycles, "converged"),
      abandoned: integerValue(cycles, "abandoned"),
      active: integerValue(cycles, "active"),
      awaitingUser: integerValue(cycles, "awaitingUser"),
    },
    rounds: parseDistribution(record.rounds, "rounds"),
    wallClockMs: parseDistribution(record.wallClockMs, "wallClockMs"),
    questions: {
      total: integerValue(questions, "total"),
      open: integerValue(questions, "open"),
      perCycle: numberValue(questions, "perCycle"),
    },
    verdicts: {
      checked: integerValue(verdicts, "checked"),
      missing: integerValue(verdicts, "missing"),
      missingCycleIds: arrayValue(verdicts, "missingCycleIds", (item, index) => {
        if (typeof item !== "string" || item.length === 0) {
          throw new Error(`missingCycleIds[${String(index)}] 必须是非空字符串`);
        }
        return item;
      }),
    },
    decisionConsistency: {
      checked: integerValue(consistency, "checked"),
      divergedCycleIds: arrayValue(consistency, "divergedCycleIds", (item, index) => {
        if (typeof item !== "string" || item.length === 0) {
          throw new Error(`divergedCycleIds[${String(index)}] 必须是非空字符串`);
        }
        return item;
      }),
    },
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

export function parseRuntimeBinding(value: unknown): RuntimeBinding {
  const record = recordValue(value, "runtime binding");
  const closeReason = optionalString(record, "closeReason");
  const closedAt = optionalString(record, "closedAt");
  return {
    id: stringValue(record, "id"),
    topicId: stringValue(record, "topicId"),
    agentId: stringValue(record, "agentId"),
    actorId: stringValue(record, "actorId"),
    providerId: stringValue(record, "providerId"),
    transportKind: enumValue(record, "transportKind", RUNTIME_TRANSPORT_KINDS),
    status: enumValue(record, "status", RUNTIME_BINDING_STATUSES),
    hasSession: booleanValue(record, "hasSession"),
    stateVersion: integerValue(record, "stateVersion", 1),
    lastActivityAt: stringValue(record, "lastActivityAt"),
    ...(closeReason ? { closeReason } : {}),
    createdAt: stringValue(record, "createdAt"),
    updatedAt: stringValue(record, "updatedAt"),
    ...(closedAt ? { closedAt } : {}),
  };
}

export function parseRuntimeBindings(value: unknown): RuntimeBinding[] {
  if (!Array.isArray(value)) {
    throw new Error("runtime bindings 必须是数组");
  }
  return value.map((item) => parseRuntimeBinding(item));
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
