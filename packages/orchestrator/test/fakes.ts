/**
 * @input  依赖：编排端口、领域类型与并发冲突错误
 * @output 导出：含内存 lease 的 FakeCouncilStore、FakeAgentAdapter 与异步辅助
 * @pos    不调用真实模型或数据库的确定性编排测试基础
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  InvalidRunStateError,
  LeaseConflictError,
  LeaseLostError,
  StoreConflictError,
} from "../src/errors.js";
import type { AgentAdapter, CouncilStore } from "../src/ports.js";
import type {
  AgentInvocation,
  AgentInvocationOptions,
  AgentResult,
  ApproveGateInput,
  ApproveGateResult,
  ClaimRuntimeBindingLeaseInput,
  ClaimRunLeaseInput,
  CouncilPublicMessage,
  CouncilTopicContext,
  CreateRunInput,
  EnsureRuntimeBindingInput,
  FinalizeRuntimeBindingCloseInput,
  ListRunsForTopicInput,
  ListRestartCandidatesInput,
  ListRuntimeBindingsInput,
  OrchestrationRun,
  PaginatedRuns,
  RenewRunLeaseInput,
  RenewRuntimeBindingLeaseInput,
  RoundCommitInput,
  RoundCommitResult,
  RunLease,
  RunStatus,
  RuntimeBinding,
  RuntimeBindingInvocationContext,
  RuntimeBindingLease,
  TransitionRuntimeBindingInput,
} from "../src/types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
    reject(error: unknown): void {
      rejectPromise?.(error);
    },
  };
}

export class FakeCouncilStore implements CouncilStore {
  readonly messages: CouncilPublicMessage[] = [];
  readonly statusHistory: RunStatus[] = [];
  commitFailure?: Error;
  renewFailure?: Error;
  commitAttempts = 0;
  readonly #runs = new Map<string, OrchestrationRun>();
  readonly #approvals = new Map<string, Map<string, ApproveGateInput>>();
  readonly #leases = new Map<string, RunLease>();
  readonly #runtimeBindings = new Map<string, RuntimeBinding>();
  readonly #runtimeBindingLeases = new Map<string, RuntimeBindingLease>();
  readonly #consumedRequests = new Set<string>();
  #runSequence = 0;
  #messageSequence = 0;
  #leaseSequence = 0;
  #runtimeBindingLeaseSequence = 0;

  async createRun(input: CreateRunInput): Promise<OrchestrationRun> {
    this.#runSequence += 1;
    const now = new Date().toISOString();
    const run: OrchestrationRun = {
      id: `run_${String(this.#runSequence)}`,
      topicId: input.topicId,
      status: "idle",
      plan: clone(input.plan),
      policy: clone(input.policy),
      nextRoundIndex: 0,
      currentAttempt: 0,
      manualRecoveriesUsed: 0,
      confirmedGates: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#runs.set(run.id, clone(run));
    this.statusHistory.push(run.status);
    return clone(run);
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    const run = this.#runs.get(runId);
    if (!run) {
      throw new Error("测试运行不存在。");
    }
    return clone(run);
  }

  async listRunsForTopic(input: ListRunsForTopicInput): Promise<PaginatedRuns> {
    const runs = [...this.#runs.values()]
      .filter((run) => run.topicId === input.topicId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const page = runs.slice(input.offset, input.offset + input.limit).map(clone);
    const nextOffset = input.offset + page.length;
    return {
      total: runs.length,
      count: page.length,
      offset: input.offset,
      hasMore: nextOffset < runs.length,
      ...(nextOffset < runs.length ? { nextOffset } : {}),
      runs: page,
    };
  }

  async listRestartCandidates(input: ListRestartCandidatesInput): Promise<PaginatedRuns> {
    const runs = [...this.#runs.values()]
      .filter((run) => run.status === "running" || run.status === "waiting_agent")
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      );
    const page = runs.slice(input.offset, input.offset + input.limit).map(clone);
    const nextOffset = input.offset + page.length;
    return {
      total: runs.length,
      count: page.length,
      offset: input.offset,
      hasMore: nextOffset < runs.length,
      ...(nextOffset < runs.length ? { nextOffset } : {}),
      runs: page,
    };
  }

  async replaceRun(
    run: OrchestrationRun,
    expectedVersion: number,
  ): Promise<OrchestrationRun> {
    const current = this.#runs.get(run.id);
    if (!current || current.version !== expectedVersion) {
      throw new StoreConflictError("测试存储检测到运行版本冲突。");
    }
    const saved: OrchestrationRun = {
      ...clone(run),
      version: expectedVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#runs.set(saved.id, clone(saved));
    this.statusHistory.push(saved.status);
    return clone(saved);
  }

  async replaceRunWithLease(
    run: OrchestrationRun,
    expectedVersion: number,
    lease: RunLease,
  ): Promise<OrchestrationRun> {
    this.#assertLease(lease);
    return await this.replaceRun(run, expectedVersion);
  }

  async cancelRun(runId: string): Promise<OrchestrationRun> {
    const current = this.#runs.get(runId);
    if (!current) {
      throw new Error("测试运行不存在。");
    }
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      return clone(current);
    }
    return await this.replaceRun(
      {
        ...current,
        status: "cancelled",
        activeAgentId: undefined,
        pendingGateId: undefined,
        failure: undefined,
      },
      current.version,
    );
  }

  async approveGate(input: ApproveGateInput): Promise<ApproveGateResult> {
    const runApprovals = this.#approvals.get(input.runId) ?? new Map();
    const existing = runApprovals.get(input.approvalId);
    if (existing) {
      if (
        existing.expectedGateId !== input.expectedGateId ||
        existing.expectedVersion !== input.expectedVersion ||
        existing.approvedByActorId !== input.approvedByActorId
      ) {
        throw new StoreConflictError("同一个 approvalId 不能表示不同的批准操作。");
      }
      return { run: await this.getRun(input.runId), applied: false };
    }

    const current = this.#runs.get(input.runId);
    if (
      !current ||
      current.version !== input.expectedVersion ||
      current.status !== "waiting_user" ||
      current.pendingGateId !== input.expectedGateId
    ) {
      throw new StoreConflictError("人工批准的门或运行版本已经变化。");
    }
    const approved: OrchestrationRun = {
      ...current,
      status: "running",
      confirmedGates: [...current.confirmedGates, input.expectedGateId],
      pendingGateId: undefined,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#runs.set(approved.id, clone(approved));
    this.statusHistory.push(approved.status);
    runApprovals.set(input.approvalId, clone(input));
    this.#approvals.set(input.runId, runApprovals);
    return { run: clone(approved), applied: true };
  }

  async getTopicContext(topicId: string): Promise<CouncilTopicContext> {
    return {
      topicId,
      title: "测试议题",
      question: "自动轮次是否遵守确定性边界？",
      constraints: ["不得自动接受决策"],
      projectPath: "/tmp/council-test-project",
      messages: clone(this.messages),
    };
  }

  async ensureRuntimeBinding(input: EnsureRuntimeBindingInput): Promise<RuntimeBinding> {
    const current = [...this.#runtimeBindings.values()].find(
      (binding) =>
        binding.topicId === input.topicId &&
        binding.agentId === input.agentId &&
        binding.status !== "closed",
    );
    if (current) return clone(current);
    const now = new Date().toISOString();
    const binding: RuntimeBinding = {
      id: `binding_${input.agentId}`,
      topicId: input.topicId,
      agentId: input.agentId,
      actorId: input.actorId,
      providerId: input.providerId,
      bindingRevision: input.bindingRevision,
      agentConfigRevision: input.agentConfigRevision,
      providerConfigRevision: input.providerConfigRevision,
      transportKind: input.transportKind,
      status: "starting",
      stateVersion: 1,
      epoch: 0,
      processInstanceId: input.processInstanceId,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.#runtimeBindings.set(binding.id, clone(binding));
    return clone(binding);
  }

  async getRuntimeBinding(bindingId: string): Promise<RuntimeBinding> {
    const binding = this.#runtimeBindings.get(bindingId) ?? this.#createTestBinding(bindingId);
    return clone(binding);
  }

  async listRuntimeBindings(
    input: ListRuntimeBindingsInput,
  ): Promise<readonly RuntimeBinding[]> {
    return [...this.#runtimeBindings.values()]
      .filter((binding) =>
        binding.topicId === input.topicId &&
        (input.includeClosed || binding.status !== "closed")
      )
      .map(clone);
  }

  async listOpenRuntimeBindings(): Promise<readonly RuntimeBinding[]> {
    return [...this.#runtimeBindings.values()]
      .filter((binding) => binding.status !== "closed")
      .map((binding) => structuredClone(binding));
  }

  async getRuntimeBindingInvocationContext(
    bindingId: string,
    requestMessageId?: string,
  ): Promise<RuntimeBindingInvocationContext> {
    const binding = await this.getRuntimeBinding(bindingId);
    const requestKey = requestMessageId ? `${binding.id}:${requestMessageId}` : undefined;
    if (requestKey && this.#consumedRequests.has(requestKey)) {
      throw new InvalidRunStateError("测试请求已经被 RuntimeBinding 消费。");
    }
    const topic = await this.getTopicContext(binding.topicId);
    const firstTurn =
      !binding.sessionId
      || !binding.cursor
      || binding.transportKind === "openai-sessionless";
    const messages = firstTurn
      ? topic.messages
      : topic.messages.filter((message) =>
          message.createdAt > binding.cursor!.createdAt
          || (
            message.createdAt === binding.cursor!.createdAt
            && message.id > binding.cursor!.messageId
          )
        );
    if (
      requestMessageId
      && !messages.some((message) =>
        message.id === requestMessageId && message.actorId === "human"
      )
    ) {
      throw new InvalidRunStateError("测试请求不在当前公开增量中。");
    }
    const consumed = messages.at(-1);
    return {
      binding,
      topic: { ...topic, messages: clone(messages) },
      firstTurn,
      ...(consumed
        ? { consumedCursor: { createdAt: consumed.createdAt, messageId: consumed.id } }
        : {}),
    };
  }

  async claimRuntimeBindingLease(
    input: ClaimRuntimeBindingLeaseInput,
  ): Promise<RuntimeBindingLease> {
    const binding = await this.getRuntimeBinding(input.bindingId);
    const current = this.#runtimeBindingLeases.get(input.bindingId);
    if (current && current.expiresAtMs > Date.now()) {
      throw new LeaseConflictError("测试 RuntimeBinding lease 已被占用。");
    }
    this.#runtimeBindingLeaseSequence += 1;
    const lease: RuntimeBindingLease = {
      bindingId: input.bindingId,
      ownerId: input.ownerId,
      token: `binding_lease_${String(this.#runtimeBindingLeaseSequence)}`,
      epoch: (current?.epoch ?? binding.epoch) + 1,
      expiresAtMs: Date.now() + input.ttlMs,
    };
    this.#runtimeBindingLeases.set(binding.id, clone(lease));
    this.#runtimeBindings.set(binding.id, {
      ...binding,
      status: "starting",
      stateVersion: binding.stateVersion + 1,
      epoch: lease.epoch,
      processInstanceId: input.processInstanceId,
    });
    return clone(lease);
  }

  async renewRuntimeBindingLease(
    input: RenewRuntimeBindingLeaseInput,
  ): Promise<RuntimeBindingLease> {
    this.#assertRuntimeBindingLease(input.lease);
    const renewed = {
      ...input.lease,
      expiresAtMs: Date.now() + input.ttlMs,
    };
    this.#runtimeBindingLeases.set(renewed.bindingId, clone(renewed));
    return clone(renewed);
  }

  async transitionRuntimeBinding(
    input: TransitionRuntimeBindingInput,
  ): Promise<RuntimeBinding> {
    this.#assertRuntimeBindingLease(input.lease);
    const current = await this.getRuntimeBinding(input.lease.bindingId);
    if (current.stateVersion !== input.expectedStateVersion) {
      throw new StoreConflictError("测试 RuntimeBinding stateVersion 冲突。");
    }
    const now = new Date().toISOString();
    const binding: RuntimeBinding = {
      ...current,
      status: input.status,
      stateVersion: current.stateVersion + 1,
      ...(input.clearSession
        ? { sessionId: undefined, cursor: undefined }
        : input.sessionId
          ? { sessionId: input.sessionId }
          : {}),
      ...(input.closeReason ? { closeReason: input.closeReason } : {}),
      updatedAt: now,
      lastActivityAt: now,
      ...(input.status === "closed" ? { closedAt: now } : {}),
    };
    this.#runtimeBindings.set(binding.id, clone(binding));
    return clone(binding);
  }

  async releaseRuntimeBindingLease(lease: RuntimeBindingLease): Promise<boolean> {
    const current = this.#runtimeBindingLeases.get(lease.bindingId);
    if (!current || current.token !== lease.token || current.epoch !== lease.epoch) {
      return false;
    }
    this.#runtimeBindingLeases.delete(lease.bindingId);
    return true;
  }

  async requestRuntimeBindingClose(
    bindingId: string,
    reason: string,
  ): Promise<RuntimeBinding> {
    const current = await this.getRuntimeBinding(bindingId);
    const binding = {
      ...current,
      status: "closing" as const,
      stateVersion: current.stateVersion + 1,
      epoch: current.epoch + 1,
      closeReason: reason,
    };
    this.#runtimeBindings.set(bindingId, clone(binding));
    this.#runtimeBindingLeases.delete(bindingId);
    return clone(binding);
  }

  async finalizeRuntimeBindingClose(
    input: FinalizeRuntimeBindingCloseInput,
  ): Promise<RuntimeBinding> {
    const current = await this.getRuntimeBinding(input.bindingId);
    const now = new Date().toISOString();
    const binding: RuntimeBinding = {
      ...current,
      status: "closed",
      stateVersion: current.stateVersion + 1,
      closeReason: input.closeReason ?? current.closeReason,
      updatedAt: now,
      lastActivityAt: now,
      closedAt: now,
    };
    this.#runtimeBindings.set(binding.id, clone(binding));
    return clone(binding);
  }

  async markRuntimeBindingsInterrupted(_processInstanceId: string): Promise<number> {
    return 0;
  }

  async closeIdleRuntimeBindings(_beforeIso: string): Promise<number> {
    return 0;
  }

  async commitRound(input: RoundCommitInput): Promise<RoundCommitResult> {
    this.#assertLease(input.lease);
    this.#assertRuntimeBindingLease(input.bindingLease);
    this.commitAttempts += 1;
    if (this.commitFailure) {
      throw this.commitFailure;
    }
    const current = this.#runs.get(input.run.id);
    if (!current || current.version !== input.expectedVersion) {
      throw new StoreConflictError("测试存储拒绝提交过期轮次。");
    }
    const round = current.plan[current.nextRoundIndex];
    if (round?.requestMessageId) {
      const requestKey = `${input.bindingLease.bindingId}:${round.requestMessageId}`;
      if (this.#consumedRequests.has(requestKey)) {
        throw new StoreConflictError("测试请求已被成功消费。");
      }
      this.#consumedRequests.add(requestKey);
    }
    this.#messageSequence += 1;
    const message: CouncilPublicMessage = {
      id: `message_${String(this.#messageSequence)}`,
      topicId: input.message.topicId,
      actorId: input.message.actorId,
      kind: input.message.kind,
      content: input.message.content,
      createdAt: new Date().toISOString(),
    };
    const run: OrchestrationRun = {
      ...clone(input.run),
      version: input.expectedVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.messages.push(clone(message));
    this.#runs.set(run.id, clone(run));
    const binding = await this.getRuntimeBinding(input.bindingLease.bindingId);
    this.#runtimeBindings.set(binding.id, {
      ...binding,
      status: "idle",
      stateVersion: binding.stateVersion + 1,
      ...(input.bindingSessionId ? { sessionId: input.bindingSessionId } : {}),
      ...(input.consumedCursor ? { cursor: clone(input.consumedCursor) } : {}),
      lastActivityAt: message.createdAt,
      updatedAt: message.createdAt,
    });
    this.#runtimeBindingLeases.delete(binding.id);
    this.statusHistory.push(run.status);
    return { run: clone(run), message: clone(message) };
  }

  async claimRunLease(input: ClaimRunLeaseInput): Promise<RunLease> {
    const run = this.#runs.get(input.runId);
    if (!run || (run.status !== "running" && run.status !== "waiting_agent")) {
      throw new LeaseConflictError("测试运行当前不能获取 lease。");
    }
    const current = this.#leases.get(input.runId);
    const now = Date.now();
    if (current && current.expiresAtMs > now) {
      if (current.ownerId === input.ownerId) {
        return clone(current);
      }
      throw new LeaseConflictError("测试 lease 已被占用。");
    }
    this.#leaseSequence += 1;
    const lease: RunLease = {
      runId: input.runId,
      ownerId: input.ownerId,
      token: `lease_${String(this.#leaseSequence)}`,
      epoch: (current?.epoch ?? 0) + 1,
      expiresAtMs: now + input.ttlMs,
    };
    this.#leases.set(input.runId, clone(lease));
    return lease;
  }

  async renewRunLease(input: RenewRunLeaseInput): Promise<RunLease> {
    if (this.renewFailure) {
      throw this.renewFailure;
    }
    this.#assertLease(input.lease);
    const renewed = { ...input.lease, expiresAtMs: Date.now() + input.ttlMs };
    this.#leases.set(renewed.runId, clone(renewed));
    return renewed;
  }

  async releaseRunLease(lease: RunLease): Promise<boolean> {
    const current = this.#leases.get(lease.runId);
    if (
      !current ||
      current.token !== lease.token ||
      current.epoch !== lease.epoch ||
      current.ownerId !== lease.ownerId
    ) {
      return false;
    }
    this.#leases.delete(lease.runId);
    return true;
  }

  #assertLease(lease: RunLease): void {
    const current = this.#leases.get(lease.runId);
    if (
      !current ||
      current.token !== lease.token ||
      current.epoch !== lease.epoch ||
      current.ownerId !== lease.ownerId ||
      current.expiresAtMs <= Date.now()
    ) {
      throw new LeaseLostError("测试执行 lease 已失效。");
    }
  }

  #assertRuntimeBindingLease(lease: RuntimeBindingLease): void {
    const current = this.#runtimeBindingLeases.get(lease.bindingId);
    if (
      !current ||
      current.token !== lease.token ||
      current.epoch !== lease.epoch ||
      current.ownerId !== lease.ownerId ||
      current.expiresAtMs <= Date.now()
    ) {
      throw new LeaseLostError("测试 RuntimeBinding lease 已失效。");
    }
  }

  #createTestBinding(bindingId: string): RuntimeBinding {
    const now = new Date().toISOString();
    const agentId = bindingId.replace(/^binding_/u, "");
    const binding: RuntimeBinding = {
      id: bindingId,
      topicId: "topic_test",
      agentId,
      actorId: agentId,
      providerId: `provider_${agentId}`,
      bindingRevision: `static:${agentId}`,
      agentConfigRevision: 1,
      providerConfigRevision: 1,
      projectPath: "/tmp/council-test-project",
      transportKind: "openai-sessionless",
      status: "idle",
      stateVersion: 1,
      epoch: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.#runtimeBindings.set(bindingId, clone(binding));
    return binding;
  }

  corruptRun(runId: string, mutate: (run: OrchestrationRun) => OrchestrationRun): void {
    const current = this.#runs.get(runId);
    if (!current) {
      throw new Error("测试运行不存在。");
    }
    this.#runs.set(runId, clone(mutate(clone(current))));
  }
}

type AgentHandler = (
  input: AgentInvocation,
  options: AgentInvocationOptions,
  callNumber: number,
) => Promise<AgentResult>;

export class FakeAgentAdapter implements AgentAdapter {
  readonly invocations: AgentInvocation[] = [];

  constructor(
    readonly adapterId: string,
    private readonly handler: AgentHandler,
  ) {}

  async invoke(
    input: AgentInvocation,
    options: AgentInvocationOptions,
  ): Promise<AgentResult> {
    this.invocations.push(clone(input));
    return await this.handler(input, options, this.invocations.length);
  }
}
