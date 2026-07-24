/**
 * @input  依赖：编排协议枚举与未知 JSON 快照
 * @output 导出：v1/v2 运行快照严格解码、动态 Actor 编码与历史身份映射
 * @pos    阻止损坏或非规范持久化数据进入编排核心
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  LEGACY_AGENT_CLEANUP_TIMEOUT_MS,
  LEGACY_PUBLIC_AUTHORS,
  FAILURE_CODES,
  MAX_AGENT_ID_CHARS,
  MAX_TIMER_DELAY_MS,
  MESSAGE_KINDS,
  RUN_STATUSES,
  STOP_REASONS,
} from "../constants.js";
import { InvalidRunStateError } from "../errors.js";
import type {
  FailureCode,
  MessageKind,
  OrchestrationRun,
  RunStatus,
  StopReason,
} from "../types.js";

const RUN_STATUS_SET = new Set<string>(RUN_STATUSES);
const MESSAGE_KIND_SET = new Set<string>(MESSAGE_KINDS);
const LEGACY_PUBLIC_AUTHOR_SET = new Set<string>(LEGACY_PUBLIC_AUTHORS);
const STOP_REASON_SET = new Set<string>(STOP_REASONS);
const FAILURE_CODE_SET = new Set<string>(FAILURE_CODES);
const REQUIRED_RUN_KEYS = [
  "id",
  "topicId",
  "status",
  "plan",
  "policy",
  "nextRoundIndex",
  "currentAttempt",
  "manualRecoveriesUsed",
  "confirmedGates",
  "version",
  "createdAt",
  "updatedAt",
] as const;
const OPTIONAL_RUN_KEYS = [
  "pendingGateId",
  "activeAgentId",
  "stopReason",
  "failure",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InvalidRunStateError(`SQLite 运行快照损坏：${message}`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  path = "snapshot",
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${path}.${key} 缺失。`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    fail(`${path}.${unexpected} 是未知字段。`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    fail(`${path} 必须是非空字符串。`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${path} 必须是布尔值。`);
  }
  return value;
}

function integerValue(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${path} 必须是不小于 ${String(minimum)} 的安全整数。`);
  }
  return value;
}

function timestampValue(value: unknown, path: string): string {
  const timestamp = stringValue(value, path);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      fail(`${path} 必须是规范 ISO 时间。`);
    }
  } catch {
    fail(`${path} 必须是有效 ISO 时间。`);
  }
  return timestamp;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${path} 必须是字符串数组。`);
  }
  return value.map((item, index) => stringValue(item, `${path}[${String(index)}]`));
}

function numberArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) {
    fail(`${path} 必须是整数数组。`);
  }
  return value.map((item, index) => integerValue(item, `${path}[${String(index)}]`, 1));
}

export function assertActorId(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_AGENT_ID_CHARS ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    fail(`${path} 必须是规范 Actor 标识。`);
  }
}

export function assertMessageKind(value: unknown, path: string): asserts value is MessageKind {
  if (typeof value !== "string" || !MESSAGE_KIND_SET.has(value)) {
    fail(`${path} 必须是规范消息类型。`);
  }
}

function runStatus(value: unknown): RunStatus {
  if (typeof value !== "string" || !RUN_STATUS_SET.has(value)) {
    fail("snapshot.status 无效。");
  }
  return value as RunStatus;
}

function stopReason(value: unknown): StopReason {
  if (typeof value !== "string" || !STOP_REASON_SET.has(value)) {
    fail("snapshot.stopReason 无效。");
  }
  return value as StopReason;
}

function failureCode(value: unknown): FailureCode {
  if (typeof value !== "string" || !FAILURE_CODE_SET.has(value)) {
    fail("snapshot.failure.code 无效。");
  }
  return value as FailureCode;
}

const LEGACY_OTHER_ADAPTER_ACTOR_IDS: ReadonlyMap<string, string> = new Map([
  ["deepseek", "deepseek"],
  ["kimi", "kimi"],
]);

function legacyAuthorActorId(
  value: unknown,
  adapterId: string,
  path: string,
): string {
  if (typeof value !== "string" || !LEGACY_PUBLIC_AUTHOR_SET.has(value)) {
    fail(`${path} 必须是可识别的 V1 公开作者。`);
  }
  if (value === "chair") {
    return "council";
  }
  if (value === "other") {
    return LEGACY_OTHER_ADAPTER_ACTOR_IDS.get(adapterId) ?? "legacy-unknown";
  }
  return value;
}

export function decodeRunSnapshot(
  snapshotJson: string,
  snapshotSchemaVersion = 2,
): OrchestrationRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson) as unknown;
  } catch {
    fail("snapshot_json 不是有效 JSON。");
  }
  return validateRunSnapshot(parsed, snapshotSchemaVersion);
}

export function validateRunSnapshot(
  value: unknown,
  snapshotSchemaVersion = 2,
): OrchestrationRun {
  if (!isRecord(value)) {
    fail("根节点必须是对象。");
  }
  assertExactKeys(value, REQUIRED_RUN_KEYS, OPTIONAL_RUN_KEYS);

  if (!Array.isArray(value.plan) || value.plan.length === 0) {
    fail("snapshot.plan 必须是非空数组。");
  }
  const plan = value.plan.map((item, index) => {
    if (!isRecord(item)) {
      fail(`snapshot.plan[${String(index)}] 必须是对象。`);
    }
    const planPath = `snapshot.plan[${String(index)}]`;
    if (snapshotSchemaVersion === 1) {
      assertExactKeys(
        item,
        ["adapterId", "publicAuthor", "messageKind", "instruction"],
        [],
        planPath,
      );
    } else if (snapshotSchemaVersion === 2) {
      assertExactKeys(
        item,
        ["adapterId", "actorId", "messageKind", "instruction"],
        [],
        planPath,
      );
    } else {
      fail("snapshot_schema_version 不受支持。");
    }
    assertMessageKind(item.messageKind, `snapshot.plan[${String(index)}].messageKind`);
    const adapterId = stringValue(item.adapterId, `${planPath}.adapterId`);
    const actorId = snapshotSchemaVersion === 1
      ? legacyAuthorActorId(item.publicAuthor, adapterId, `${planPath}.publicAuthor`)
      : stringValue(item.actorId, `${planPath}.actorId`);
    assertActorId(actorId, `${planPath}.actorId`);
    return {
      adapterId,
      actorId,
      messageKind: item.messageKind,
      instruction: stringValue(item.instruction, `snapshot.plan[${String(index)}].instruction`),
    };
  });

  if (!isRecord(value.policy)) {
    fail("snapshot.policy 必须是对象。");
  }
  assertExactKeys(
    value.policy,
    [
      "maxRounds",
      "allowedAgents",
      "agentTimeoutMs",
      "maxAttemptsPerRound",
      "maxManualRecoveries",
      "confirmation",
    ],
    ["agentCleanupTimeoutMs"],
    "snapshot.policy",
  );
  if (!isRecord(value.policy.confirmation)) {
    fail("snapshot.policy.confirmation 必须是对象。");
  }
  assertExactKeys(
    value.policy.confirmation,
    ["beforeRounds", "beforeCompletion"],
    [],
    "snapshot.policy.confirmation",
  );
  const status = runStatus(value.status);
  const run: OrchestrationRun = {
    id: stringValue(value.id, "snapshot.id"),
    topicId: stringValue(value.topicId, "snapshot.topicId"),
    status,
    plan,
    policy: {
      maxRounds: integerValue(value.policy.maxRounds, "snapshot.policy.maxRounds", 1),
      allowedAgents: stringArray(value.policy.allowedAgents, "snapshot.policy.allowedAgents"),
      agentTimeoutMs: integerValue(value.policy.agentTimeoutMs, "snapshot.policy.agentTimeoutMs", 1),
      agentCleanupTimeoutMs: integerValue(
        value.policy.agentCleanupTimeoutMs ?? LEGACY_AGENT_CLEANUP_TIMEOUT_MS,
        "snapshot.policy.agentCleanupTimeoutMs",
        1,
      ),
      maxAttemptsPerRound: integerValue(
        value.policy.maxAttemptsPerRound,
        "snapshot.policy.maxAttemptsPerRound",
        1,
      ),
      maxManualRecoveries: integerValue(
        value.policy.maxManualRecoveries,
        "snapshot.policy.maxManualRecoveries",
        0,
      ),
      confirmation: {
        beforeRounds: numberArray(
          value.policy.confirmation.beforeRounds,
          "snapshot.policy.confirmation.beforeRounds",
        ),
        beforeCompletion: booleanValue(
          value.policy.confirmation.beforeCompletion,
          "snapshot.policy.confirmation.beforeCompletion",
        ),
      },
    },
    nextRoundIndex: integerValue(value.nextRoundIndex, "snapshot.nextRoundIndex", 0),
    currentAttempt: integerValue(value.currentAttempt, "snapshot.currentAttempt", 0),
    manualRecoveriesUsed: integerValue(
      value.manualRecoveriesUsed,
      "snapshot.manualRecoveriesUsed",
      0,
    ),
    confirmedGates: stringArray(value.confirmedGates, "snapshot.confirmedGates"),
    version: integerValue(value.version, "snapshot.version", 1),
    createdAt: timestampValue(value.createdAt, "snapshot.createdAt"),
    updatedAt: timestampValue(value.updatedAt, "snapshot.updatedAt"),
    ...(value.pendingGateId === undefined
      ? {}
      : { pendingGateId: stringValue(value.pendingGateId, "snapshot.pendingGateId") }),
    ...(value.activeAgentId === undefined
      ? {}
      : { activeAgentId: stringValue(value.activeAgentId, "snapshot.activeAgentId") }),
    ...(value.stopReason === undefined ? {} : { stopReason: stopReason(value.stopReason) }),
  };

  if (value.failure !== undefined) {
    if (!isRecord(value.failure)) {
      fail("snapshot.failure 必须是对象。 ");
    }
    assertExactKeys(value.failure, ["code", "message", "retryable"], [], "snapshot.failure");
    run.failure = {
      code: failureCode(value.failure.code),
      message: stringValue(value.failure.message, "snapshot.failure.message"),
      retryable: booleanValue(value.failure.retryable, "snapshot.failure.retryable"),
    };
  }

  if (new Set(run.policy.allowedAgents).size !== run.policy.allowedAgents.length) {
    fail("snapshot.policy.allowedAgents 包含重复项。");
  }
  if (run.policy.allowedAgents.length === 0) {
    fail("snapshot.policy.allowedAgents 不能为空。");
  }
  if (run.plan.some((round) => !run.policy.allowedAgents.includes(round.adapterId))) {
    fail("snapshot.plan 包含未允许的 adapterId。");
  }
  if (
    run.policy.allowedAgents.some(
      (adapterId) =>
        adapterId.length > MAX_AGENT_ID_CHARS ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(adapterId),
    ) ||
    run.plan.some(
      (round) =>
        round.adapterId.length > MAX_AGENT_ID_CHARS ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(round.adapterId),
    )
  ) {
    fail("snapshot 包含无效的 adapterId。");
  }
  if (run.policy.agentTimeoutMs > MAX_TIMER_DELAY_MS) {
    fail("snapshot.policy.agentTimeoutMs 超过安全计时器上限。");
  }
  if (
    new Set(run.policy.confirmation.beforeRounds).size !==
      run.policy.confirmation.beforeRounds.length ||
    run.policy.confirmation.beforeRounds.some(
      (round, index, rounds) => index > 0 && (rounds[index - 1] ?? 0) >= round,
    )
  ) {
    fail("snapshot.policy.confirmation.beforeRounds 必须严格递增且不重复。");
  }
  const effectiveRoundCount = Math.min(run.policy.maxRounds, run.plan.length);
  if (
    run.policy.confirmation.beforeRounds.some((round) => round > effectiveRoundCount)
  ) {
    fail("snapshot.policy.confirmation.beforeRounds 超出实际轮次范围。");
  }
  if (run.nextRoundIndex > effectiveRoundCount) {
    fail("snapshot.nextRoundIndex 超出实际轮次范围。");
  }
  if (run.currentAttempt > run.policy.maxAttemptsPerRound) {
    fail("snapshot.currentAttempt 超出单轮尝试上限。");
  }
  if (run.manualRecoveriesUsed > run.policy.maxManualRecoveries) {
    fail("snapshot.manualRecoveriesUsed 超出人工恢复上限。");
  }
  if (new Set(run.confirmedGates).size !== run.confirmedGates.length) {
    fail("snapshot.confirmedGates 包含重复项。");
  }
  const knownGates = new Set(
    run.policy.confirmation.beforeRounds.map((round) => `before_round:${String(round)}`),
  );
  if (run.policy.confirmation.beforeCompletion) {
    knownGates.add("before_completion");
  }
  if (run.confirmedGates.some((gate) => !knownGates.has(gate))) {
    fail("snapshot.confirmedGates 包含未配置的确认门。");
  }
  for (const gate of run.confirmedGates) {
    if (gate === "before_completion") {
      if (run.nextRoundIndex !== effectiveRoundCount) {
        fail("完成确认门出现在计划执行完毕之前。");
      }
      continue;
    }
    const roundNumber = Number(gate.slice("before_round:".length));
    if (roundNumber > run.nextRoundIndex + 1) {
      fail("快照提前确认了尚未到达的轮次门。");
    }
  }
  const requiredCompletedGates = run.policy.confirmation.beforeRounds
    .filter((round) => round <= run.nextRoundIndex)
    .map((round) => `before_round:${String(round)}`);
  if (requiredCompletedGates.some((gate) => !run.confirmedGates.includes(gate))) {
    fail("snapshot 越过了尚未确认的轮次门。");
  }
  if (
    (run.status === "waiting_agent" || run.status === "failed") &&
    run.policy.confirmation.beforeRounds.includes(run.nextRoundIndex + 1) &&
    !run.confirmedGates.includes(`before_round:${String(run.nextRoundIndex + 1)}`)
  ) {
    fail("活动或失败轮次缺少进入本轮所需的确认记录。");
  }
  if (run.status === "waiting_user") {
    const roundNumber = run.nextRoundIndex + 1;
    const expectedGate = run.nextRoundIndex < effectiveRoundCount
      ? `before_round:${String(roundNumber)}`
      : "before_completion";
    const gateIsConfigured = run.nextRoundIndex < effectiveRoundCount
      ? run.policy.confirmation.beforeRounds.includes(roundNumber)
      : run.policy.confirmation.beforeCompletion;
    if (
      !gateIsConfigured ||
      run.pendingGateId !== expectedGate ||
      run.confirmedGates.includes(expectedGate) ||
      run.currentAttempt !== 0
    ) {
      fail("waiting_user 快照与当前确认门不一致。");
    }
  } else if (run.pendingGateId !== undefined) {
    fail("非 waiting_user 快照不能包含 pendingGateId。");
  }
  if (run.status === "waiting_agent") {
    const round = run.plan[run.nextRoundIndex];
    if (!round || run.activeAgentId !== round.adapterId || run.currentAttempt < 1) {
      fail("waiting_agent 快照与当前轮次不一致。");
    }
  } else if (run.activeAgentId !== undefined) {
    fail("非 waiting_agent 快照不能包含 activeAgentId。");
  }
  if (
    run.status === "idle" &&
    (run.nextRoundIndex !== 0 || run.currentAttempt !== 0 || run.confirmedGates.length !== 0)
  ) {
    fail("idle 快照包含已执行轮次信息。");
  }
  if (
    run.status === "running" &&
    run.currentAttempt >= run.policy.maxAttemptsPerRound &&
    run.currentAttempt !== 0
  ) {
    fail("running 快照不能保留已经耗尽的尝试次数。");
  }
  if (
    (run.status === "waiting_user" || run.status === "completed") &&
    run.currentAttempt !== 0
  ) {
    fail("等待用户或已完成快照不能保留尝试次数。");
  }
  if (status === "failed" && !run.failure) {
    fail("failed 运行缺少 failure。");
  }
  if (status !== "failed" && run.failure) {
    fail("非 failed 运行不能包含 failure。");
  }
  if (run.status === "completed") {
    const expectedStopReason = run.plan.length > run.policy.maxRounds
      ? "max_rounds_reached"
      : "plan_completed";
    if (
      run.nextRoundIndex !== effectiveRoundCount ||
      run.stopReason !== expectedStopReason ||
      (run.policy.confirmation.beforeCompletion &&
        !run.confirmedGates.includes("before_completion"))
    ) {
      fail("completed 快照与停止条件不一致。");
    }
  } else if (run.stopReason !== undefined) {
    fail("非 completed 快照不能包含 stopReason。");
  }
  if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) {
    fail("snapshot.updatedAt 不能早于 createdAt。");
  }
  return run;
}

export function encodeRunSnapshot(run: OrchestrationRun): string {
  return JSON.stringify(validateRunSnapshot(run, 2));
}
