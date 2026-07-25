/**
 * @input  依赖：CouncilStore、AgentAdapter、状态类型与可判定错误
 * @output 导出：可分离 begin/drive、适配器代次 fencing、显式安全失败消息的 CouncilOrchestrator 与重启分类
 * @pos    人工门、lease、适配器热替换、超时、重试、取消和失败恢复的唯一领域实现
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  FAILURE_CODES,
  MAX_AGENT_ID_CHARS,
  MAX_APPROVAL_ID_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_TIMER_DELAY_MS,
  MESSAGE_KINDS,
  RUN_STATUSES,
} from "./constants.js";
import {
  AgentInvocationError,
  AgentCleanupTimeoutError,
  AgentTimeoutError,
  InvalidRunStateError,
  InvocationCancelledError,
  LeaseLostError,
  OrchestrationConfigError,
  RunStateConflictError,
  RunBusyError,
} from "./errors.js";
import type { AgentAdapter, CouncilStore } from "./ports.js";
import type {
  AgentInvocation,
  ApproveGateInput,
  ApproveGateResult,
  ClaimRunLeaseInput,
  CreateRunInput,
  ExecutionLeaseRequest,
  ListRunsForTopicInput,
  ListRestartCandidatesInput,
  OrchestrationRun,
  PaginatedRuns,
  RenewRunLeaseInput,
  RestartDisposition,
  RoundPlan,
  RunLease,
  RunFailure,
  RuntimeBindingLease,
  RuntimeBinding,
} from "./types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const RUN_STATUS_SET = new Set<string>(RUN_STATUSES);
const FAILURE_CODE_SET = new Set<string>(FAILURE_CODES);
const MESSAGE_KIND_SET = new Set<string>(MESSAGE_KINDS);
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BINDING_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function waitForInvocationCleanup(
  invocation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      invocation.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function assertAgentId(agentId: string, field: string): void {
  if (agentId.length > MAX_AGENT_ID_CHARS || !AGENT_ID_PATTERN.test(agentId)) {
    throw new OrchestrationConfigError(`${field} 必须是有效的 Agent 标识。`);
  }
}

function normalizeInput(input: CreateRunInput): CreateRunInput {
  const topicId = input.topicId.trim();
  if (!topicId) {
    throw new OrchestrationConfigError("topicId 不能为空。");
  }
  if (input.plan.length === 0) {
    throw new OrchestrationConfigError("轮次计划至少需要一轮。");
  }

  const policy = input.policy;
  if (!isPositiveInteger(policy.maxRounds)) {
    throw new OrchestrationConfigError("maxRounds 必须是正整数。");
  }
  if (!isPositiveInteger(policy.agentTimeoutMs)) {
    throw new OrchestrationConfigError("agentTimeoutMs 必须是正整数。");
  }
  if (policy.agentTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new OrchestrationConfigError("agentTimeoutMs 超过 Node.js 安全计时器上限。");
  }
  if (
    !isPositiveInteger(policy.agentCleanupTimeoutMs) ||
    policy.agentCleanupTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new OrchestrationConfigError("agentCleanupTimeoutMs 必须是安全计时器正整数。");
  }
  if (!isPositiveInteger(policy.maxAttemptsPerRound)) {
    throw new OrchestrationConfigError("maxAttemptsPerRound 必须是正整数。");
  }
  if (!Number.isSafeInteger(policy.maxManualRecoveries) || policy.maxManualRecoveries < 0) {
    throw new OrchestrationConfigError("maxManualRecoveries 必须是非负整数。");
  }
  if (policy.allowedAgents.length === 0) {
    throw new OrchestrationConfigError("allowedAgents 至少需要一个 Agent。");
  }

  const allowedAgents = policy.allowedAgents.map((agentId) => agentId.trim());
  allowedAgents.forEach((agentId, index) => assertAgentId(agentId, `allowedAgents[${String(index)}]`));
  if (new Set(allowedAgents).size !== allowedAgents.length) {
    throw new OrchestrationConfigError("allowedAgents 不能包含重复项。");
  }
  const allowedAgentSet = new Set(allowedAgents);

  const plan: RoundPlan[] = input.plan.map((round, index) => {
    const adapterId = round.adapterId.trim();
    assertAgentId(adapterId, `plan[${String(index)}].adapterId`);
    if (!allowedAgentSet.has(adapterId)) {
      throw new OrchestrationConfigError(`轮次 ${String(index + 1)} 使用了未允许的 Agent。`);
    }
    const actorId = round.actorId.trim();
    assertAgentId(actorId, `plan[${String(index)}].actorId`);
    const bindingRevision = round.bindingRevision?.trim();
    if (bindingRevision && !BINDING_REVISION_PATTERN.test(bindingRevision)) {
      throw new OrchestrationConfigError(
        `plan[${String(index)}].bindingRevision 格式无效。`,
      );
    }
    const runtimeBindingId = round.runtimeBindingId?.trim();
    if (runtimeBindingId !== undefined) {
      assertAgentId(runtimeBindingId, `plan[${String(index)}].runtimeBindingId`);
    }
    const requestMessageId = round.requestMessageId?.trim();
    if (round.requestMessageId !== undefined && !requestMessageId) {
      throw new OrchestrationConfigError(
        `plan[${String(index)}].requestMessageId 不能为空。`,
      );
    }
    if (!MESSAGE_KIND_SET.has(round.messageKind)) {
      throw new OrchestrationConfigError(`轮次 ${String(index + 1)} 的消息类型无效。`);
    }
    const instruction = round.instruction.trim();
    if (!instruction) {
      throw new OrchestrationConfigError(`轮次 ${String(index + 1)} 的 instruction 不能为空。`);
    }
    return {
      adapterId,
      actorId,
      ...(bindingRevision ? { bindingRevision } : {}),
      ...(runtimeBindingId ? { runtimeBindingId } : {}),
      ...(requestMessageId ? { requestMessageId } : {}),
      messageKind: round.messageKind,
      instruction,
    };
  });

  const effectiveRoundCount = Math.min(policy.maxRounds, plan.length);
  const beforeRounds = [...policy.confirmation.beforeRounds].sort((left, right) => left - right);
  if (new Set(beforeRounds).size !== beforeRounds.length) {
    throw new OrchestrationConfigError("人工确认轮次不能重复。");
  }
  beforeRounds.forEach((roundNumber) => {
    if (!isPositiveInteger(roundNumber) || roundNumber > effectiveRoundCount) {
      throw new OrchestrationConfigError("人工确认轮次必须落在实际执行范围内。");
    }
  });

  return {
    topicId,
    plan,
    policy: {
      maxRounds: policy.maxRounds,
      allowedAgents,
      agentTimeoutMs: policy.agentTimeoutMs,
      agentCleanupTimeoutMs: policy.agentCleanupTimeoutMs,
      maxAttemptsPerRound: policy.maxAttemptsPerRound,
      maxManualRecoveries: policy.maxManualRecoveries,
      confirmation: {
        beforeRounds,
        beforeCompletion: policy.confirmation.beforeCompletion,
      },
    },
  };
}

function gateForRound(roundNumber: number): string {
  return `before_round:${String(roundNumber)}`;
}

function normalizeApprovalInput(input: ApproveGateInput): ApproveGateInput {
  const runId = input.runId.trim();
  const expectedGateId = input.expectedGateId.trim();
  const approvalId = input.approvalId.trim();
  if (!runId) {
    throw new OrchestrationConfigError("runId 不能为空。");
  }
  if (!/^before_(?:completion|round:[1-9][0-9]*)$/.test(expectedGateId)) {
    throw new OrchestrationConfigError("expectedGateId 格式无效。");
  }
  if (!isPositiveInteger(input.expectedVersion)) {
    throw new OrchestrationConfigError("expectedVersion 必须是正整数。");
  }
  if (
    approvalId.length > MAX_APPROVAL_ID_CHARS ||
    !APPROVAL_ID_PATTERN.test(approvalId)
  ) {
    throw new OrchestrationConfigError("approvalId 必须是有效的幂等标识。");
  }
  if (input.approvedByActorId !== "human") {
    throw new OrchestrationConfigError("人工确认门只能由 human 批准。");
  }
  return {
    runId,
    expectedGateId,
    expectedVersion: input.expectedVersion,
    approvalId,
    approvedByActorId: input.approvedByActorId,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPersistedRun(run: OrchestrationRun): void {
  if (!run.id.trim() || !RUN_STATUS_SET.has(run.status)) {
    throw new InvalidRunStateError("持久化运行的标识或状态无效。");
  }
  if (!isPositiveInteger(run.version)) {
    throw new InvalidRunStateError("持久化运行的版本必须是正整数。");
  }

  let normalized: CreateRunInput;
  try {
    normalized = normalizeInput({ topicId: run.topicId, plan: run.plan, policy: run.policy });
  } catch {
    throw new InvalidRunStateError("持久化运行的计划或策略无效。");
  }
  const policyMatches =
    normalized.topicId === run.topicId &&
    normalized.policy.maxRounds === run.policy.maxRounds &&
    normalized.policy.agentTimeoutMs === run.policy.agentTimeoutMs &&
    normalized.policy.agentCleanupTimeoutMs === run.policy.agentCleanupTimeoutMs &&
    normalized.policy.maxAttemptsPerRound === run.policy.maxAttemptsPerRound &&
    normalized.policy.maxManualRecoveries === run.policy.maxManualRecoveries &&
    normalized.policy.confirmation.beforeCompletion ===
      run.policy.confirmation.beforeCompletion &&
    sameStrings(normalized.policy.allowedAgents, run.policy.allowedAgents) &&
    sameStrings(
      normalized.policy.confirmation.beforeRounds.map(String),
      run.policy.confirmation.beforeRounds.map(String),
    );
  const planMatches =
    normalized.plan.length === run.plan.length &&
    normalized.plan.every((round, index) => {
      const persisted = run.plan[index];
      return Boolean(
        persisted &&
        round.adapterId === persisted.adapterId &&
        round.actorId === persisted.actorId &&
        round.bindingRevision === persisted.bindingRevision &&
        round.runtimeBindingId === persisted.runtimeBindingId &&
        round.requestMessageId === persisted.requestMessageId &&
        round.messageKind === persisted.messageKind &&
        round.instruction === persisted.instruction,
      );
    });
  if (!policyMatches || !planMatches) {
    throw new InvalidRunStateError("持久化运行没有保存规范化的计划或策略。");
  }

  const effectiveRoundCount = Math.min(run.policy.maxRounds, run.plan.length);
  if (
    !Number.isSafeInteger(run.nextRoundIndex) ||
    run.nextRoundIndex < 0 ||
    run.nextRoundIndex > effectiveRoundCount
  ) {
    throw new InvalidRunStateError("持久化运行的轮次索引越界。");
  }
  if (
    !Number.isSafeInteger(run.currentAttempt) ||
    run.currentAttempt < 0 ||
    run.currentAttempt > run.policy.maxAttemptsPerRound
  ) {
    throw new InvalidRunStateError("持久化运行的当前尝试次数无效。");
  }
  if (
    !Number.isSafeInteger(run.manualRecoveriesUsed) ||
    run.manualRecoveriesUsed < 0 ||
    run.manualRecoveriesUsed > run.policy.maxManualRecoveries
  ) {
    throw new InvalidRunStateError("持久化运行的人工恢复次数无效。");
  }

  const knownGates = new Set(
    run.policy.confirmation.beforeRounds.map((roundNumber) => gateForRound(roundNumber)),
  );
  if (run.policy.confirmation.beforeCompletion) {
    knownGates.add("before_completion");
  }
  if (
    new Set(run.confirmedGates).size !== run.confirmedGates.length ||
    run.confirmedGates.some((gateId) => !knownGates.has(gateId))
  ) {
    throw new InvalidRunStateError("持久化运行包含无效或重复的确认门记录。");
  }
  for (const gateId of run.confirmedGates) {
    if (gateId === "before_completion") {
      if (run.nextRoundIndex !== effectiveRoundCount) {
        throw new InvalidRunStateError("完成确认门出现在计划执行完毕之前。");
      }
      continue;
    }
    const roundNumber = Number(gateId.slice("before_round:".length));
    if (roundNumber > run.nextRoundIndex + 1) {
      throw new InvalidRunStateError("运行提前确认了尚未到达的轮次门。");
    }
  }
  const requiredCompletedGates = run.policy.confirmation.beforeRounds
    .filter((roundNumber) => roundNumber <= run.nextRoundIndex)
    .map(gateForRound);
  if (requiredCompletedGates.some((gateId) => !run.confirmedGates.includes(gateId))) {
    throw new InvalidRunStateError("持久化运行越过了尚未确认的轮次门。");
  }
  if (
    (run.status === "waiting_agent" || run.status === "failed") &&
    run.policy.confirmation.beforeRounds.includes(run.nextRoundIndex + 1) &&
    !run.confirmedGates.includes(gateForRound(run.nextRoundIndex + 1))
  ) {
    throw new InvalidRunStateError("活动或失败轮次缺少进入本轮所需的确认记录。");
  }

  if (run.status === "waiting_user") {
    const roundNumber = run.nextRoundIndex + 1;
    const expectedGate = run.nextRoundIndex < effectiveRoundCount
      ? gateForRound(roundNumber)
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
      throw new InvalidRunStateError("waiting_user 状态与当前人工确认门不一致。");
    }
  } else if (run.pendingGateId !== undefined) {
    throw new InvalidRunStateError("非 waiting_user 状态不能保留待确认门。");
  }

  if (run.status === "waiting_agent") {
    const round = run.plan[run.nextRoundIndex];
    if (
      !round ||
      run.activeAgentId !== round.adapterId ||
      run.currentAttempt < 1
    ) {
      throw new InvalidRunStateError("waiting_agent 状态与当前适配器或尝试次数不一致。");
    }
  } else if (run.activeAgentId !== undefined) {
    throw new InvalidRunStateError("非 waiting_agent 状态不能保留活动 Agent。");
  }

  if (run.status === "idle") {
    if (
      run.nextRoundIndex !== 0 ||
      run.currentAttempt !== 0 ||
      run.confirmedGates.length !== 0
    ) {
      throw new InvalidRunStateError("idle 状态包含已执行的轮次信息。");
    }
  }
  if (
    run.status === "running" &&
    run.currentAttempt >= run.policy.maxAttemptsPerRound &&
    run.currentAttempt !== 0
  ) {
    throw new InvalidRunStateError("running 状态不能保留已经耗尽的 Agent 尝试次数。");
  }
  if (
    (run.status === "waiting_user" || run.status === "completed") &&
    run.currentAttempt !== 0
  ) {
    throw new InvalidRunStateError("等待用户或已完成状态不能保留 Agent 尝试次数。");
  }
  if (run.status === "failed") {
    if (!run.failure || !FAILURE_CODE_SET.has(run.failure.code)) {
      throw new InvalidRunStateError("failed 状态缺少失败原因。");
    }
  } else if (run.failure !== undefined) {
    throw new InvalidRunStateError("非 failed 状态不能保留失败原因。");
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
      throw new InvalidRunStateError("completed 状态与停止条件不一致。");
    }
  } else if (run.stopReason !== undefined) {
    throw new InvalidRunStateError("非 completed 状态不能保留停止原因。");
  }
}

function isTerminal(run: OrchestrationRun): boolean {
  return TERMINAL_STATUSES.has(run.status);
}

function assertExecutionBindingsFrozen(run: OrchestrationRun): void {
  if (
    run.plan.some((round) =>
      !round.bindingRevision?.trim() || !round.runtimeBindingId?.trim()
    )
  ) {
    throw new RunStateConflictError(
      "旧运行缺少冻结的 Agent bindingRevision 或 runtimeBindingId，只允许读取或取消；请创建新运行。",
    );
  }
}

export function classifyRestartDisposition(run: OrchestrationRun): RestartDisposition {
  if (
    run.plan.some((round) =>
      !round.bindingRevision?.trim() || !round.runtimeBindingId?.trim()
    )
  ) {
    return "ignore";
  }
  if (run.status === "running") {
    return "resume_running";
  }
  if (run.status === "waiting_agent") {
    return "fail_interrupted_agent";
  }
  if (run.status === "waiting_user") {
    return "await_user";
  }
  return "ignore";
}

function invocationFailure(error: unknown): RunFailure {
  if (error instanceof AgentCleanupTimeoutError) {
    return { code: "agent_cleanup_timeout", message: error.message, retryable: false };
  }
  if (error instanceof AgentTimeoutError) {
    return { code: "agent_timeout", message: error.message, retryable: true };
  }
  if (error instanceof AgentInvocationError) {
    const publicMessage = error.publicMessage?.trim();
    return {
      code: "agent_failed",
      message: publicMessage || (error.retryable
        ? "Agent 调用暂时失败，详细原因仅保留在适配器本地日志。"
        : "Agent 调用失败且不可重试，详细原因仅保留在适配器本地日志。"),
      retryable: error.retryable,
    };
  }
  return {
    code: "agent_failed",
    message: "Agent 调用失败，适配器未提供可公开的错误分类。",
    retryable: false,
  };
}

function unavailableFailure(): RunFailure {
  return {
    code: "agent_unavailable",
    message: "计划指定的 Agent 没有已注册的主动触发适配器。",
    retryable: false,
  };
}

function storeFailure(operation: "context" | "commit"): RunFailure {
  return {
    code: "store_failed",
    message: operation === "context"
      ? "读取共享议题上下文失败，请检查 CouncilStore 实现和本地日志。"
      : "Agent 回复已生成，但共享存储提交失败；本次运行不会自动再次调用 Agent。",
    retryable: false,
  };
}

interface AdapterSlot {
  adapter: AgentAdapter;
  generation: number;
  bindingRevision: string;
}

export class CouncilOrchestrator {
  readonly #adapters = new Map<string, AdapterSlot>();
  readonly #processingRuns = new Set<string>();
  readonly #activeControllers = new Map<string, AbortController>();
  readonly #activeAdapterIds = new Map<string, string>();
  readonly #activeBindingLeases = new Map<string, RuntimeBindingLease>();
  #adapterGeneration = 0;

  constructor(
    private readonly store: CouncilStore,
    adapters: readonly AgentAdapter[],
  ) {
    for (const adapter of adapters) {
      assertAgentId(adapter.adapterId, "AgentAdapter.adapterId");
      if (this.#adapters.has(adapter.adapterId)) {
        throw new OrchestrationConfigError(`AgentAdapter ${adapter.adapterId} 重复注册。`);
      }
      this.#adapters.set(adapter.adapterId, {
        adapter,
        generation: ++this.#adapterGeneration,
        bindingRevision: `static:${adapter.adapterId}`,
      });
    }
  }

  /**
   * M2 配置面刷新使用的临时适配器入口。只替换内存调用实现，
   * 不创建 RuntimeBinding、session、进程或 lease 持久记录。
   */
  upsertAdapter(adapter: AgentAdapter, bindingRevision?: string): void {
    assertAgentId(adapter.adapterId, "AgentAdapter.adapterId");
    const generation = ++this.#adapterGeneration;
    const normalizedRevision = bindingRevision?.trim() || `runtime:${String(generation)}`;
    if (!BINDING_REVISION_PATTERN.test(normalizedRevision)) {
      throw new OrchestrationConfigError("AgentAdapter bindingRevision 格式无效。");
    }
    this.#adapters.set(adapter.adapterId, {
      adapter,
      generation,
      bindingRevision: normalizedRevision,
    });
  }

  isAdapterBindingCurrent(adapterId: string, bindingRevision?: string): boolean {
    if (!bindingRevision) {
      return false;
    }
    const slot = this.#adapters.get(adapterId);
    return Boolean(slot && slot.bindingRevision === bindingRevision);
  }

  adapterBindingRevision(adapterId: string): string | undefined {
    return this.#adapters.get(adapterId)?.bindingRevision;
  }

  /**
   * 删除动态适配器并使已捕获的旧代次立即失效。活动调用会被中止；
   * 即使适配器忽略 AbortSignal 并迟到返回，提交前代次检查也会拒绝写入。
   */
  removeAdapter(adapterId: string): boolean {
    assertAgentId(adapterId, "AgentAdapter.adapterId");
    const removed = this.#adapters.delete(adapterId);
    if (!removed) {
      return false;
    }
    this.#adapterGeneration += 1;
    for (const [runId, activeAdapterId] of this.#activeAdapterIds) {
      if (activeAdapterId !== adapterId) {
        continue;
      }
      this.abortActiveInvocation(
        runId,
        new AgentInvocationError(
          "Agent 配置已在调用期间变更。",
          false,
          "Agent 已停用或删除，本次迟到回复不会写入议题。",
        ),
      );
    }
    return true;
  }

  async createRun(input: CreateRunInput): Promise<OrchestrationRun> {
    const normalized = normalizeInput(input);
    const plan = normalized.plan.map((round) => {
      if (round.bindingRevision) {
        return round;
      }
      const slot = this.#adapters.get(round.adapterId);
      return slot
        ? { ...round, bindingRevision: slot.bindingRevision }
        : round;
    });
    if (
      plan.some((round) =>
        !round.bindingRevision || !round.runtimeBindingId
      )
    ) {
      throw new OrchestrationConfigError(
        "每个新运行轮次都必须冻结 bindingRevision 与 runtimeBindingId。",
      );
    }
    const run = await this.store.createRun({ ...normalized, plan });
    assertPersistedRun(run);
    return run;
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    return await this.#loadRun(runId);
  }

  async listRunsForTopic(input: ListRunsForTopicInput): Promise<PaginatedRuns> {
    const page = await this.store.listRunsForTopic(input);
    page.runs.forEach(assertPersistedRun);
    return page;
  }

  async listRestartCandidates(input: ListRestartCandidatesInput): Promise<PaginatedRuns> {
    const page = await this.store.listRestartCandidates(input);
    page.runs.forEach(assertPersistedRun);
    return page;
  }

  async claimRunLease(input: ClaimRunLeaseInput): Promise<RunLease> {
    return await this.store.claimRunLease(input);
  }

  async renewRunLease(input: RenewRunLeaseInput): Promise<RunLease> {
    return await this.store.renewRunLease(input);
  }

  async releaseRunLease(lease: RunLease): Promise<boolean> {
    return await this.store.releaseRunLease(lease);
  }

  async begin(runId: string): Promise<OrchestrationRun> {
    const run = await this.#loadRun(runId);
    assertExecutionBindingsFrozen(run);
    this.#assertRunBindingsCurrent(run);
    if (isTerminal(run)) {
      throw new RunStateConflictError(`终态 ${run.status} 运行不能再次启动。`);
    }
    if (run.status !== "idle") {
      throw new RunStateConflictError(`只有 idle 运行可以启动，当前状态为 ${run.status}。`);
    }
    const running = await this.#replaceRun(
      { ...run, status: "running", failure: undefined },
      run.version,
    );
    return running;
  }

  async start(
    runId: string,
    leaseRequest: ExecutionLeaseRequest,
  ): Promise<OrchestrationRun> {
    const running = await this.begin(runId);
    if (running.status !== "running") {
      return running;
    }
    return await this.#driveWithClaimedLease(running.id, leaseRequest);
  }

  async applyApproval(input: ApproveGateInput): Promise<ApproveGateResult> {
    const normalized = normalizeApprovalInput(input);
    const current = await this.#loadRun(normalized.runId);
    assertExecutionBindingsFrozen(current);
    this.#assertRunBindingsCurrent(current);
    const result = await this.store.approveGate(normalized);
    assertPersistedRun(result.run);
    if (!result.applied) {
      return result;
    }
    if (
      result.run.status !== "running" ||
      !result.run.confirmedGates.includes(normalized.expectedGateId)
    ) {
      throw new InvalidRunStateError("CouncilStore 返回了无效的人工批准结果。");
    }
    return result;
  }

  async approve(
    input: ApproveGateInput,
    leaseRequest: ExecutionLeaseRequest,
  ): Promise<OrchestrationRun> {
    const result = await this.applyApproval(input);
    if (!result.applied) {
      return result.run;
    }
    return await this.#driveWithClaimedLease(result.run.id, leaseRequest);
  }

  async cancel(runId: string): Promise<OrchestrationRun> {
    await this.#loadRun(runId);
    this.#activeControllers.get(runId)?.abort(new InvocationCancelledError());
    const cancelled = await this.store.cancelRun(runId);
    assertPersistedRun(cancelled);
    return cancelled;
  }

  async prepareRecovery(runId: string): Promise<OrchestrationRun> {
    if (this.#processingRuns.has(runId)) {
      throw new RunBusyError("当前进程仍在处理该运行，不能并发恢复。");
    }
    const run = await this.#loadRun(runId);
    assertExecutionBindingsFrozen(run);
    this.#assertRunBindingsCurrent(run);
    if (run.status !== "failed") {
      throw new RunStateConflictError(
        `只有 failed 运行可以显式恢复，当前状态为 ${run.status}。缺少 Store lease 时禁止恢复活动或中断状态。`,
      );
    }
    if (run.manualRecoveriesUsed >= run.policy.maxManualRecoveries) {
      throw new RunStateConflictError("该运行已达到人工恢复次数上限。");
    }
    const recovered = await this.#replaceRun(
      {
        ...run,
        status: "running",
        currentAttempt: 0,
        manualRecoveriesUsed: run.manualRecoveriesUsed + 1,
        activeAgentId: undefined,
        pendingGateId: undefined,
        failure: undefined,
      },
      run.version,
    );
    return recovered;
  }

  async recover(
    runId: string,
    leaseRequest: ExecutionLeaseRequest,
  ): Promise<OrchestrationRun> {
    const recovered = await this.prepareRecovery(runId);
    return await this.#driveWithClaimedLease(recovered.id, leaseRequest);
  }

  async drive(runId: string, lease: RunLease): Promise<OrchestrationRun> {
    const run = await this.#loadRun(runId);
    assertExecutionBindingsFrozen(run);
    if (lease.runId !== run.id) {
      throw new LeaseLostError("执行 lease 不属于当前运行。");
    }
    if (run.status === "waiting_agent") {
      throw new InvalidRunStateError(
        "waiting_agent 表示上次调用结果未知，禁止自动重放；请先标记执行中断。",
      );
    }
    if (run.status !== "running") {
      throw new InvalidRunStateError(`只有 running 运行可以 drive，当前状态为 ${run.status}。`);
    }
    if (this.#hasStaleBinding(run)) {
      return await this.#fail(run, lease, unavailableFailure());
    }
    return await this.#process(run, lease);
  }

  async markInterruptedAgent(runId: string, lease: RunLease): Promise<OrchestrationRun> {
    const run = await this.#loadRun(runId);
    assertExecutionBindingsFrozen(run);
    if (run.status !== "waiting_agent") {
      throw new InvalidRunStateError(
        `只有 waiting_agent 可标记为执行中断，当前状态为 ${run.status}。`,
      );
    }
    return await this.#fail(run, lease, {
      code: "execution_interrupted",
      message: "执行进程在 Agent 返回前中断；为避免重复调用，必须由用户显式恢复。",
      retryable: true,
    });
  }

  abortActiveInvocation(runId: string, reason: Error): boolean {
    const controller = this.#activeControllers.get(runId);
    if (!controller) {
      return false;
    }
    controller.abort(reason);
    return true;
  }

  abortActiveBinding(bindingId: string, reason: Error): boolean {
    let aborted = false;
    for (const [runId, lease] of this.#activeBindingLeases) {
      if (lease.bindingId === bindingId) {
        aborted = this.abortActiveInvocation(runId, reason) || aborted;
      }
    }
    return aborted;
  }

  async #driveWithClaimedLease(
    runId: string,
    request: ExecutionLeaseRequest,
  ): Promise<OrchestrationRun> {
    if (
      !isPositiveInteger(request.ttlMs) ||
      !isPositiveInteger(request.renewIntervalMs) ||
      request.renewIntervalMs >= request.ttlMs ||
      request.renewIntervalMs > MAX_TIMER_DELAY_MS
    ) {
      throw new OrchestrationConfigError(
        "lease TTL 必须为正整数，续租间隔必须为更小的安全计时器整数。",
      );
    }
    const lease = await this.claimRunLease({ runId, ownerId: request.ownerId, ttlMs: request.ttlMs });
    let currentLease = lease;
    let renewal: Promise<void> | undefined;
    let renewalFailure: Error | undefined;
    const renew = (): void => {
      if (renewal || renewalFailure) {
        return;
      }
      renewal = this.renewRunLease({ lease: currentLease, ttlMs: request.ttlMs })
        .then(async (renewed) => {
          currentLease = renewed;
          await this.#heartbeatActiveBinding(runId, request.ttlMs);
        })
        .catch((_error: unknown) => {
          renewalFailure = new LeaseLostError("执行 lease 续租失败或已失去执行所有权。");
          this.abortActiveInvocation(runId, renewalFailure);
        })
        .finally(() => {
          renewal = undefined;
        });
    };
    const timer = setInterval(renew, request.renewIntervalMs);
    timer.unref();
    try {
      const result = await this.drive(runId, lease);
      if (renewalFailure) {
        throw renewalFailure;
      }
      return result;
    } finally {
      clearInterval(timer);
      await renewal;
      await this.releaseRunLease(currentLease);
    }
  }

  async #process(initialRun: OrchestrationRun, lease: RunLease): Promise<OrchestrationRun> {
    assertPersistedRun(initialRun);
    if (this.#processingRuns.has(initialRun.id)) {
      throw new RunBusyError("该运行已在当前进程中执行。");
    }
    this.#processingRuns.add(initialRun.id);
    try {
      return await this.#runLoop(initialRun, lease);
    } finally {
      this.#processingRuns.delete(initialRun.id);
      this.#activeControllers.delete(initialRun.id);
      this.#activeBindingLeases.delete(initialRun.id);
    }
  }

  async #runLoop(initialRun: OrchestrationRun, lease: RunLease): Promise<OrchestrationRun> {
    let run = initialRun;
    while (run.status === "running") {
      const effectiveRoundCount = Math.min(run.policy.maxRounds, run.plan.length);
      if (run.nextRoundIndex >= effectiveRoundCount) {
        const completionGate = "before_completion";
        if (
          run.policy.confirmation.beforeCompletion &&
          !run.confirmedGates.includes(completionGate)
        ) {
          return await this.#replaceRunWithLease(
            { ...run, status: "waiting_user", pendingGateId: completionGate },
            run.version,
            lease,
          );
        }
        const stopReason = run.plan.length > run.policy.maxRounds
          ? "max_rounds_reached"
          : "plan_completed";
        return await this.#replaceRunWithLease(
          { ...run, status: "completed", stopReason, pendingGateId: undefined },
          run.version,
          lease,
        );
      }

      const roundNumber = run.nextRoundIndex + 1;
      const roundGate = gateForRound(roundNumber);
      if (
        run.policy.confirmation.beforeRounds.includes(roundNumber) &&
        !run.confirmedGates.includes(roundGate)
      ) {
        return await this.#replaceRunWithLease(
          { ...run, status: "waiting_user", pendingGateId: roundGate },
          run.version,
          lease,
        );
      }

      const round = run.plan[run.nextRoundIndex];
      if (!round) {
        throw new InvalidRunStateError("运行的轮次索引越界，持久化数据已损坏。");
      }
      const adapterSlot = this.#adapters.get(round.adapterId);
      if (
        !adapterSlot ||
        (round.bindingRevision &&
          adapterSlot.bindingRevision !== round.bindingRevision)
      ) {
        return await this.#fail(run, lease, unavailableFailure());
      }

      const runtimeBindingId = round.runtimeBindingId;
      if (!runtimeBindingId) {
        throw new InvalidRunStateError("当前轮次缺少 RuntimeBinding 冻结引用。");
      }
      let bindingLease: RuntimeBindingLease | undefined;
      let binding: RuntimeBinding;
      let context;
      try {
        bindingLease = await this.store.claimRuntimeBindingLease({
          bindingId: runtimeBindingId,
          ownerId: `run:${run.id}`,
          ttlMs: Math.max(1, lease.expiresAtMs - Date.now()),
          processInstanceId: lease.ownerId,
        });
        this.#activeBindingLeases.set(run.id, bindingLease);
        const invocationContext = await this.store.getRuntimeBindingInvocationContext(
          runtimeBindingId,
          round.requestMessageId,
        );
        binding = await this.store.transitionRuntimeBinding({
          lease: bindingLease,
          expectedStateVersion: invocationContext.binding.stateVersion,
          status: "thinking",
          processInstanceId: lease.ownerId,
        });
        context = invocationContext;
      } catch {
        if (bindingLease) {
          await this.store.releaseRuntimeBindingLease(bindingLease);
          this.#activeBindingLeases.delete(run.id);
        }
        return await this.#fail(run, lease, storeFailure("context"));
      }

      const waiting = await this.#replaceRunWithLease(
        {
          ...run,
          status: "waiting_agent",
          currentAttempt: run.currentAttempt + 1,
          activeAgentId: round.adapterId,
          failure: undefined,
        },
        run.version,
        lease,
      );
      const invocation: AgentInvocation = {
        runId: waiting.id,
        topicId: waiting.topicId,
        roundNumber,
        attempt: waiting.currentAttempt,
        adapterId: round.adapterId,
        actorId: round.actorId,
        runtimeBindingId,
        ...(round.requestMessageId ? { requestMessageId: round.requestMessageId } : {}),
        ...(context.binding.sessionId ? { sessionId: context.binding.sessionId } : {}),
        firstTurn: context.firstTurn,
        instruction: round.instruction,
        messageKind: round.messageKind,
        context: context.topic,
      };

      let content: string;
      let resultSessionId: string | undefined;
      let streamingTransition: Promise<void> | undefined;
      const notifyStreaming = (): void => {
        if (streamingTransition || binding.status === "streaming") {
          return;
        }
        streamingTransition = this.store.transitionRuntimeBinding({
          lease: bindingLease,
          expectedStateVersion: binding.stateVersion,
          status: "streaming",
          processInstanceId: lease.ownerId,
        }).then((updated) => {
          binding = updated;
        });
      };
      try {
        const result = await this.#invoke(
          waiting.id,
          adapterSlot.adapter,
          invocation,
          waiting.policy.agentTimeoutMs,
          waiting.policy.agentCleanupTimeoutMs,
          notifyStreaming,
        );
        await streamingTransition;
        content = result.content.trim();
        resultSessionId = result.sessionId;
        if (!content) {
          const message = "Agent 返回了空的公开回复。";
          throw new AgentInvocationError(message, false, message);
        }
        if (content.length > MAX_MESSAGE_CHARS) {
          const message = "Agent 返回的公开回复超过长度上限。";
          throw new AgentInvocationError(message, false, message);
        }
      } catch (error) {
        await streamingTransition?.catch(() => undefined);
        await this.#interruptRuntimeBinding(
          run.id,
          adapterSlot.adapter,
          bindingLease,
          binding.stateVersion,
          lease.ownerId,
        );
        if (error instanceof LeaseLostError) {
          throw error;
        }
        const latest = await this.#loadRun(waiting.id);
        if (latest.status === "cancelled" || latest.version !== waiting.version) {
          return latest;
        }
        if (error instanceof InvocationCancelledError) {
          return await this.cancel(waiting.id);
        }
        const failure = invocationFailure(error);
        if (
          failure.retryable &&
          waiting.currentAttempt < waiting.policy.maxAttemptsPerRound
        ) {
          run = await this.#replaceRunWithLease(
            {
              ...waiting,
              status: "running",
              activeAgentId: undefined,
              failure: undefined,
            },
            waiting.version,
            lease,
          );
          continue;
        }
        return await this.#fail(waiting, lease, failure);
      }

      const currentAdapterSlot = this.#adapters.get(round.adapterId);
      if (
        !currentAdapterSlot ||
        currentAdapterSlot.generation !== adapterSlot.generation
      ) {
        return await this.#fail(waiting, lease, unavailableFailure());
      }

      const nextRun: OrchestrationRun = {
        ...waiting,
        status: "running",
        nextRoundIndex: waiting.nextRoundIndex + 1,
        currentAttempt: 0,
        activeAgentId: undefined,
        failure: undefined,
      };
      try {
        const committed = await this.store.commitRound({
          expectedVersion: waiting.version,
          lease,
          bindingLease,
          ...(resultSessionId ? { bindingSessionId: resultSessionId } : {}),
          ...(context.consumedCursor
            ? { consumedCursor: context.consumedCursor }
            : {}),
          run: nextRun,
          message: {
            topicId: waiting.topicId,
            actorId: round.actorId,
            kind: round.messageKind,
            content,
          },
        });
        assertPersistedRun(committed.run);
        run = committed.run;
        this.#activeBindingLeases.delete(run.id);
      } catch (error) {
        await this.#interruptRuntimeBinding(
          run.id,
          adapterSlot.adapter,
          bindingLease,
          binding.stateVersion,
          lease.ownerId,
        );
        if (error instanceof LeaseLostError) {
          throw error;
        }
        const latest = await this.#loadRun(waiting.id);
        if (latest.status === "cancelled" || latest.version !== waiting.version) {
          return latest;
        }
        return await this.#fail(waiting, lease, storeFailure("commit"));
      }
    }
    return run;
  }

  async #fail(
    run: OrchestrationRun,
    lease: RunLease,
    failure: RunFailure,
  ): Promise<OrchestrationRun> {
    return await this.#replaceRunWithLease(
      {
        ...run,
        status: "failed",
        activeAgentId: undefined,
        pendingGateId: undefined,
        failure,
      },
      run.version,
      lease,
    );
  }

  async #loadRun(runId: string): Promise<OrchestrationRun> {
    const run = await this.store.getRun(runId);
    assertPersistedRun(run);
    return run;
  }

  #hasStaleBinding(run: OrchestrationRun): boolean {
    return run.plan.some(
      (round) => !this.isAdapterBindingCurrent(round.adapterId, round.bindingRevision),
    );
  }

  #assertRunBindingsCurrent(run: OrchestrationRun): void {
    if (this.#hasStaleBinding(run)) {
      throw new RunStateConflictError(
        "运行引用的 Agent 绑定已停用、删除或被新配置替换。",
      );
    }
  }

  async #replaceRun(
    run: OrchestrationRun,
    expectedVersion: number,
  ): Promise<OrchestrationRun> {
    assertPersistedRun(run);
    const saved = await this.store.replaceRun(run, expectedVersion);
    assertPersistedRun(saved);
    return saved;
  }

  async #replaceRunWithLease(
    run: OrchestrationRun,
    expectedVersion: number,
    lease: RunLease,
  ): Promise<OrchestrationRun> {
    assertPersistedRun(run);
    const saved = await this.store.replaceRunWithLease(run, expectedVersion, lease);
    assertPersistedRun(saved);
    return saved;
  }

  async #invoke(
    runId: string,
    adapter: AgentAdapter,
    invocation: AgentInvocation,
    timeoutMs: number,
    cleanupTimeoutMs: number,
    notifyStreaming: () => void,
  ) {
    const controller = new AbortController();
    this.#activeControllers.set(runId, controller);
    this.#activeAdapterIds.set(runId, adapter.adapterId);
    const timeout = setTimeout(() => controller.abort(new AgentTimeoutError()), timeoutMs);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        const reason = controller.signal.reason;
        reject(reason instanceof Error ? reason : new InvocationCancelledError());
      };
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const invocationPromise = Promise.resolve().then(
      async () =>
        await adapter.invoke(invocation, {
          signal: controller.signal,
          notifyStreaming,
        }),
    );
    try {
      return await Promise.race([invocationPromise, aborted]);
    } catch (error) {
      if (controller.signal.aborted) {
        const cleaned = await waitForInvocationCleanup(invocationPromise, cleanupTimeoutMs);
        if (!cleaned) {
          if (error instanceof LeaseLostError || error instanceof InvocationCancelledError) {
            throw error;
          }
          throw new AgentCleanupTimeoutError();
        }
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (abortListener) {
        controller.signal.removeEventListener("abort", abortListener);
      }
      if (this.#activeControllers.get(runId) === controller) {
        this.#activeControllers.delete(runId);
      }
      if (this.#activeAdapterIds.get(runId) === adapter.adapterId) {
        this.#activeAdapterIds.delete(runId);
      }
    }
  }

  async #heartbeatActiveBinding(runId: string, ttlMs: number): Promise<void> {
    const bindingLease = this.#activeBindingLeases.get(runId);
    if (!bindingLease) return;
    try {
      const renewed = await this.store.renewRuntimeBindingLease({
        lease: bindingLease,
        ttlMs,
      });
      this.#activeBindingLeases.set(runId, renewed);
    } catch {
      const lost = new LeaseLostError(
        "RuntimeBinding 已关闭、过期或被其他执行者接管。",
      );
      this.abortActiveInvocation(runId, lost);
      throw lost;
    }
  }

  async #interruptRuntimeBinding(
    runId: string,
    adapter: AgentAdapter,
    lease: RuntimeBindingLease,
    expectedStateVersion: number,
    processInstanceId: string,
  ): Promise<void> {
    try {
      await adapter.closeBinding?.(lease.bindingId);
    } finally {
      try {
        await this.store.transitionRuntimeBinding({
          lease,
          expectedStateVersion,
          status: "interrupted",
          processInstanceId,
          clearSession: true,
        });
      } catch {
        // accepted/cancel/config-close 会先删除 lease；此处只能清理本地运行时，禁止反写旧状态。
      }
      await this.store.releaseRuntimeBindingLease(lease);
      this.#activeBindingLeases.delete(runId);
    }
  }
}
