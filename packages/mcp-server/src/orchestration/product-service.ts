/**
 * @input  依赖：SQLiteCouncilStore、CouncilOrchestrator、RunExecutionManager、CycleDriver、AgentRegistry、
 *         模型路由服务与回退路由仓库、任务委派管理器、HTTP 编排配置、决策写入器取值器与配置互斥回调
 * @output 导出：CouncilProductService —— 圆桌开局/推进/放弃、Run 创建/启动/审批/取消/恢复、只读任务规划、
 *         RuntimeBinding 生命周期、Model Router 设置变更联动、任务委派转发（议题入口与任务入口）
 * @pos    Composer/@Agent 产品接线的真正实现；CouncilOrchestrationService 以同名同签名方法转发到这里
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import {
  type CouncilOrchestrator,
  AgentTimeoutError,
  OrchestrationConfigError,
  RunNotFoundError,
  RunStateConflictError,
  type SQLiteCouncilStore,
  type ApproveGateResult,
  deriveCycleRequirements,
  type DiscussionCycleView,
  type DiscussionCycleKind,
  type CycleReviewScope,
  findCapabilityGaps,
  type MessageKind,
  type OrchestrationRun,
  type PaginatedRuns,
  type RuntimeBinding,
  type CycleTaskRequirements,
} from "council-orchestrator";
import type {
  CreateAgentInput,
  CreateProviderInput,
  ModelRouterConnectionTest,
  ModelRouterService,
  ModelRouterSnapshot,
  PublicProviderProfile,
  UpdateAgentDefinitionInput,
  UpdateProviderInput,
} from "../model-router-service.js";
import type { AgentDefinition, ModelRouterStore } from "../model-router-store.js";
import { MAX_MESSAGE_CHARS } from "../constants.js";
import { CouncilNotFoundError } from "../errors.js";
import { logger } from "../logger.js";
import type { ProviderModels } from "../model-diagnostics.js";
import type { CouncilHttpConfig } from "../types.js";
import { withTrustedGitCommitTargets } from "../trusted-git-targets.js";
import { type AgentRegistry, transportKindForProtocol } from "./agent-registry.js";
import type { CycleDecisionWriter, CycleDriver } from "./cycle-driver.js";
import type { RunExecutionManager } from "./execution-manager.js";
import type {
  StartWorkItemDelegationBatchInput,
  StartWorkItemDelegationInput,
  WorkItemDelegationManager,
} from "./work-item-delegation-manager.js";
import type { WorkItemDelegation } from "./work-item-delegation-store.js";

export interface PublicRoundInput {
  adapterId: string;
  messageKind: MessageKind;
  instruction: string;
  requestMessageId?: string;
}

export interface CreateRunOptions {
  confirmationBeforeCompletion?: boolean;
}

export interface PublicApprovalInput {
  expectedGateId: string;
  expectedVersion: number;
  approvalId: string;
}

function missingRun(error: unknown): boolean {
  return error instanceof RunNotFoundError;
}

export interface CouncilProductServiceDependencies {
  config: CouncilHttpConfig;
  store: SQLiteCouncilStore;
  orchestrator: CouncilOrchestrator;
  manager: RunExecutionManager;
  cycles: CycleDriver;
  registry: AgentRegistry;
  processInstanceId: string;
  modelRouter?: ModelRouterService;
  fallbackRouterStore?: ModelRouterStore;
  delegationManager?: WorkItemDelegationManager;
  /** 决策写入器晚于聚合根构造才挂载，开局时再取当前值。 */
  decisionWriter: () => CycleDecisionWriter | undefined;
  /** 配置互斥由聚合根持有：Run 创建、持久会话重开与模型路由变更在此串行化。 */
  withConfigurationLock: <T>(operation: () => Promise<T> | T) => Promise<T>;
}

export class CouncilProductService {
  readonly #config: CouncilHttpConfig;
  readonly #store: SQLiteCouncilStore;
  readonly #orchestrator: CouncilOrchestrator;
  readonly #manager: RunExecutionManager;
  readonly #cycles: CycleDriver;
  readonly #registry: AgentRegistry;
  readonly #processInstanceId: string;
  readonly #modelRouter: ModelRouterService | undefined;
  readonly #fallbackRouterStore: ModelRouterStore | undefined;
  readonly #delegationManager: WorkItemDelegationManager | undefined;
  readonly #decisionWriter: () => CycleDecisionWriter | undefined;
  readonly #withConfigurationLock: <T>(operation: () => Promise<T> | T) => Promise<T>;

  constructor(dependencies: CouncilProductServiceDependencies) {
    this.#config = dependencies.config;
    this.#store = dependencies.store;
    this.#orchestrator = dependencies.orchestrator;
    this.#manager = dependencies.manager;
    this.#cycles = dependencies.cycles;
    this.#registry = dependencies.registry;
    this.#processInstanceId = dependencies.processInstanceId;
    this.#modelRouter = dependencies.modelRouter;
    this.#fallbackRouterStore = dependencies.fallbackRouterStore;
    this.#delegationManager = dependencies.delegationManager;
    this.#decisionWriter = dependencies.decisionWriter;
    this.#withConfigurationLock = dependencies.withConfigurationLock;
  }

  // ---- 圆桌讨论 ----

  /** 用户点「开始圆桌」：发起人入选时冻结为提案人并跳过首轮，随后自动交接。 */
  async startCycle(input: {
    topicId: string;
    participants: readonly string[];
    roundBudget?: number;
    kind?: DiscussionCycleKind;
    reviewScope?: CycleReviewScope;
    taskRequirements?: CycleTaskRequirements;
  }): Promise<DiscussionCycleView> {
    if (!this.#decisionWriter()) {
      throw new OrchestrationConfigError("决策写入器未挂载，无法开始圆桌讨论。");
    }
    await this.#registry.syncDynamicAgents();
    await this.#registry.ensureFreshAvailability();
    const topicSeed = this.#store.readTopicProposalSeed(input.topicId);
    const initiatorAdapterId = input.participants.find(
      (participant) => this.#registry.actorId(participant) === topicSeed?.actorId,
    );
    const participants = initiatorAdapterId
      ? [
          initiatorAdapterId,
          ...input.participants.filter((participant) => participant !== initiatorAdapterId),
        ]
      : [...input.participants];
    for (const participant of participants) {
      if (!this.#registry.hasAdapter(participant)) {
        throw new OrchestrationConfigError("参与名册包含未注册的 Agent 适配器。");
      }
      const publicCapability = this.#registry.capability(participant);
      if (!publicCapability?.available) {
        throw new OrchestrationConfigError(
          `参与者 ${participant} 当前不可用，圆桌尚未启动。`,
        );
      }
    }
    const reviewScope = input.reviewScope
      ?? (input.kind === "fix_review" ? "commit" : "discussion");
    const kind = input.kind
      ?? (reviewScope === "commit" ? "fix_review" : "discussion");
    if (
      (kind === "fix_review" && reviewScope !== "commit")
      || (kind === "discussion" && reviewScope === "commit")
    ) {
      throw new OrchestrationConfigError("圆桌类型与审查范围冲突。");
    }
    const requirements = deriveCycleRequirements({
      kind,
      reviewScope,
      participants,
      ...(input.taskRequirements ? { task: input.taskRequirements } : {}),
    });
    const runtimeCapabilities = participants.map((participant) =>
      this.#registry.freezeRuntimeCapabilities(participant));
    const gaps = findCapabilityGaps(requirements, runtimeCapabilities);
    if (gaps.length > 0) {
      const summary = gaps
        .map((gap) => `${gap.adapterId}: ${gap.missing.join(", ")}`)
        .join("；");
      throw new OrchestrationConfigError(
        `圆桌尚未启动：Runtime 能力不足（${summary}）。请更换具备所需能力的 Agent，或调整审查范围。`,
      );
    }
    return await this.#cycles.start({
      topicId: input.topicId,
      participants,
      ...(input.roundBudget === undefined ? {} : { roundBudget: input.roundBudget }),
      kind,
      requirements,
      runtimeCapabilities,
    });
  }

  readCycle(topicId: string): DiscussionCycleView | undefined {
    return this.#store.readActiveDiscussionCycle(topicId);
  }

  readLatestCycle(topicId: string): DiscussionCycleView | undefined {
    return this.#store.readLatestDiscussionCycle(topicId);
  }

  /**
   * 用户回答了阻塞提问：记账后立刻续跑，接着上次停住的阶段往下走。
   * `answerMessageId` 必须是已公开的用户消息——回答要留在讨论流里可被复查。
   */
  async answerCycleQuestion(input: {
    topicId: string;
    questionMessageId: string;
    answerMessageId: string;
  }): Promise<DiscussionCycleView | undefined> {
    this.#store.answerBlockingQuestion({
      questionMessageId: input.questionMessageId,
      answerMessageId: input.answerMessageId,
      now: new Date().toISOString(),
    });
    return await this.#cycles.advance(input.topicId);
  }

  /**
   * 外部 Agent 提交了一批修复，开一轮复审。
   *
   * 提交动作本身不改任何条目状态：条目是「修好了没有」的账本，
   * 判定权在复审者手里。这里只负责把轮次推进一格并重新召唤评审。
   */
  async submitFixes(input: {
    topicId: string;
  }): Promise<DiscussionCycleView | undefined> {
    const current = this.#store.readActiveDiscussionCycle(input.topicId);
    if (!current) {
      throw new OrchestrationConfigError("该议题没有进行中的圆桌，无法提交复审。");
    }
    this.#store.resumeDiscussionCycleAfterFixes({
      cycleId: current.cycle.id,
      expectedVersion: current.cycle.stateVersion,
      now: new Date().toISOString(),
    });
    return await this.#cycles.advance(input.topicId);
  }

  /** 用户主动放弃当前圆桌；Run 失败卡住时靠它把议题解锁。 */
  abandonCycle(topicId: string): DiscussionCycleView | undefined {
    return this.#cycles.abandon(topicId);
  }

  /**
   * Run 落地后接着推进对应议题；这一步失败只记日志，不能反过来打断执行面。
   * 由聚合根在 RunExecutionManager.onRunSettled 里回调，因此必须是公开方法。
   */
  advanceCycleAfterRun(runId: string): void {
    void (async () => {
      try {
        const run = await this.#orchestrator.getRun(runId);
        if (run.status === "failed" || run.status === "cancelled") {
          // 失败的 Run 没有提交发言，状态机看到的还是"轮到同一个人"。此时继续推进
          // 就是对同一阶段无限重召唤——真实 Provider 上等于无上限烧钱。
          // 停在这里，把 cycle 留成活动状态：用户可以恢复该 Run 接着走，也可以放弃圆桌。
          logger.warn(
            "orchestration",
            `圆桌暂停：run=${runId} 以 ${run.status} 结束，等待人工恢复或放弃`,
          );
          return;
        }
        await this.#cycles.advance(run.topicId);
      } catch (error) {
        if (!missingRun(error)) {
          logger.error("orchestration", "圆桌自动交接失败", error);
        }
      }
    })();
  }

  // ---- Run 生命周期 ----

  async createRun(
    topicId: string,
    plan: readonly PublicRoundInput[],
    options: CreateRunOptions = {},
  ): Promise<OrchestrationRun> {
    return await this.#withConfigurationLock(async () =>
      await this.#createRunLocked(topicId, plan, options));
  }

  async #createRunLocked(
    topicId: string,
    plan: readonly PublicRoundInput[],
    options: CreateRunOptions,
  ): Promise<OrchestrationRun> {
    await this.#registry.syncDynamicAgents();
    const hasUnavailableTarget = plan.some((round) => {
      const capability = this.#registry.capability(round.adapterId);
      return capability !== undefined && !capability.available;
    });
    if (hasUnavailableTarget) {
      // 用户明确点名了被标记不可用的适配器：强制复检而非等 TTL，让 CLI 刚登录立即可用
      await this.#registry.ensureFreshAvailability(true);
    }
    const rounds = [];
    for (const round of plan) {
      const actorId = this.#registry.actorId(round.adapterId);
      if (!actorId) {
        throw new OrchestrationConfigError("计划包含未注册的 Agent 适配器。");
      }
      const capability = this.#registry.capability(round.adapterId);
      if (!capability?.available) {
        throw new OrchestrationConfigError("计划包含当前不可用的 Agent 适配器。");
      }
      const agent =
        this.#modelRouter?.getAgent(round.adapterId)
        ?? this.#fallbackRouterStore?.getAgent(round.adapterId)
        ?? this.#fallbackRouterStore?.getAgent(actorId);
      const provider = agent
        ? this.#modelRouter?.getProvider(agent.providerId)
          ?? this.#fallbackRouterStore?.getProvider(agent.providerId)
        : undefined;
      const bindingRevision = this.#orchestrator.adapterBindingRevision(round.adapterId);
      if (!agent || !provider || !bindingRevision) {
        throw new OrchestrationConfigError(
          "计划 Agent 缺少可冻结的模型路由或适配器配置。",
        );
      }
      const transportKind = transportKindForProtocol(provider.protocol);
      const binding = await this.#store.ensureRuntimeBinding({
        topicId,
        agentId: agent.id,
        actorId,
        providerId: provider.id,
        bindingRevision,
        agentConfigRevision: agent.configRevision,
        providerConfigRevision: provider.configRevision,
        transportKind,
        processInstanceId: this.#processInstanceId,
      });
      const instruction = round.requestMessageId
        ? withTrustedGitCommitTargets(
            round.instruction,
            this.#store.readTopicProposalSeed(topicId)?.commitTargets ?? [],
          )
        : round.instruction;
      rounds.push({
        ...round,
        instruction,
        actorId,
        bindingRevision,
        runtimeBindingId: binding.id,
      });
    }
    return await this.#orchestrator.createRun({
      topicId,
      plan: rounds,
      policy: {
        maxRounds: this.#config.orchestrationDefaultMaxRounds,
        allowedAgents: this.#registry.adapterIds(),
        agentIdleTimeoutMs: this.#config.orchestrationDefaultAgentIdleTimeoutMs,
        agentTimeoutMs: this.#config.orchestrationDefaultAgentTimeoutMs,
        agentCleanupTimeoutMs: this.#config.orchestrationAgentCleanupTimeoutMs,
        maxAttemptsPerRound: this.#config.orchestrationDefaultMaxAttempts,
        maxManualRecoveries: this.#config.orchestrationDefaultMaxRecoveries,
        confirmation: {
          beforeRounds: [],
          beforeCompletion:
            options.confirmationBeforeCompletion
            ?? this.#config.orchestrationConfirmCompletion,
        },
      },
    });
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    try {
      return await this.#orchestrator.getRun(runId);
    } catch (error) {
      if (missingRun(error)) {
        throw new CouncilNotFoundError("编排运行不存在。");
      }
      throw error;
    }
  }

  async listRuns(topicId: string, limit: number, offset: number): Promise<PaginatedRuns> {
    return await this.#orchestrator.listRunsForTopic({ topicId, limit, offset });
  }

  async start(runId: string): Promise<OrchestrationRun> {
    await this.#registry.syncDynamicAgents();
    await this.#assertRunAgentsConfigured(runId);
    return await this.#manager.start(runId);
  }

  /**
   * 直接执行一次只读任务规划，不创建通用 Run，因此已决议题也能补充实施任务。
   * 模型输出只作为草案返回；调用方必须严格解析并通过 CouncilDatabase 写入。
   */
  async generateWorkItemPlan(input: {
    topicId: string;
    adapterId: string;
    instruction: string;
    contextMessage: string;
    signal?: AbortSignal;
  }): Promise<{ actorId: string; content: string }> {
    const target = await this.#withConfigurationLock(async () => {
      await this.#registry.syncDynamicAgents();
      await this.#registry.ensureFreshAvailability(true);
      const capability = this.#registry.capability(input.adapterId);
      const adapter = this.#registry.adapter(input.adapterId);
      const actorId = this.#registry.actorId(input.adapterId);
      if (!capability || !adapter || !actorId) {
        throw new OrchestrationConfigError("任务规划 Agent 不存在或已停用。");
      }
      if (!capability.available) {
        throw new OrchestrationConfigError(
          capability.limitation ?? "任务规划 Agent 当前不可用。",
        );
      }
      return { adapter, actorId };
    });

    const context = await this.#store.getTopicContext(input.topicId);
    const invocationId = `planner_${randomUUID()}`;
    const runtimeBindingId = `binding_${randomUUID()}`;
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (input.signal?.aborted) {
      abortFromCaller();
    }
    const timeout = globalThis.setTimeout(
      () => controller.abort(new AgentTimeoutError("hard")),
      this.#config.orchestrationDefaultAgentTimeoutMs
        + this.#config.orchestrationAgentCleanupTimeoutMs,
    );
    timeout.unref();
    try {
      const result = await target.adapter.invoke({
        runId: invocationId,
        topicId: input.topicId,
        roundNumber: 1,
        attempt: 1,
        adapterId: input.adapterId,
        actorId: target.actorId,
        runtimeBindingId,
        firstTurn: true,
        instruction: input.instruction,
        messageKind: "note",
        context: {
          ...context,
          messages: [
            ...context.messages,
            {
              id: `message_${randomUUID()}`,
              topicId: input.topicId,
              actorId: this.#store.resolveActorAlias("human"),
              kind: "note",
              content: input.contextMessage,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      }, {
        signal: controller.signal,
        notifyActivity: () => undefined,
        notifyStreaming: () => undefined,
      });
      const content = result.content.trim();
      if (!content) {
        throw new OrchestrationConfigError("AI 返回了空的任务规划结果。");
      }
      if (content.length > MAX_MESSAGE_CHARS) {
        throw new OrchestrationConfigError("AI 返回的任务规划结果超过长度上限。");
      }
      return { actorId: target.actorId, content };
    } finally {
      globalThis.clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromCaller);
      await target.adapter.closeBinding?.(runtimeBindingId).catch((error: unknown) => {
        logger.warn("work-item-planner", "一次性任务规划会话清理失败", error);
      });
    }
  }

  async approve(runId: string, input: PublicApprovalInput): Promise<ApproveGateResult> {
    return await this.#manager.approve({
      runId,
      expectedGateId: input.expectedGateId,
      expectedVersion: input.expectedVersion,
      approvalId: input.approvalId,
      approvedByActorId: this.#store.resolveActorAlias("human"),
    });
  }

  async cancel(runId: string): Promise<OrchestrationRun> {
    return await this.#manager.cancel(runId);
  }

  async recover(runId: string): Promise<OrchestrationRun> {
    return await this.#withConfigurationLock(async () => {
      await this.#registry.syncDynamicAgents();
      await this.#assertRunAgentsConfigured(runId);
      return await this.#manager.recover(runId);
    });
  }

  async #assertRunAgentsConfigured(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    const unavailable = run.plan.find(
      (round) =>
        !this.#registry.hasAdapter(round.adapterId) ||
        !this.#orchestrator.isAdapterBindingCurrent(
          round.adapterId,
          round.bindingRevision,
        ),
    );
    if (unavailable) {
      throw new RunStateConflictError(
        "运行引用的 Agent 已停用或删除，不能继续启动或恢复。",
      );
    }
  }

  // ---- RuntimeBinding 生命周期 ----

  async listRuntimeBindings(
    topicId: string,
    includeClosed = false,
  ): Promise<readonly RuntimeBinding[]> {
    return await this.#store.listRuntimeBindings({ topicId, includeClosed });
  }

  async closeRuntimeBinding(
    bindingId: string,
    reason = "manual-close",
  ): Promise<RuntimeBinding> {
    this.#orchestrator.abortActiveBinding(
      bindingId,
      new Error("RuntimeBinding 已关闭，活动调用停止。"),
    );
    const closing = await this.#store.requestRuntimeBindingClose(bindingId, reason);
    await this.#orchestrator.closeAdapterBinding(closing.agentId, closing.id);
    if (closing.status === "closed") {
      return closing;
    }
    return await this.#store.finalizeRuntimeBindingClose({
      bindingId,
      expectedStateVersion: closing.stateVersion,
      closeReason: reason,
    });
  }

  async closeTopicRuntimeBindings(
    topicId: string,
    reason = "decision-accepted",
  ): Promise<readonly RuntimeBinding[]> {
    const bindings = await this.#store.listRuntimeBindings({
      topicId,
      includeClosed: false,
    });
    const closed: RuntimeBinding[] = [];
    for (const binding of bindings) {
      closed.push(await this.closeRuntimeBinding(binding.id, reason));
    }
    return closed;
  }

  async closeAllRuntimeBindings(
    reason = "configuration-changed",
  ): Promise<readonly RuntimeBinding[]> {
    const bindings = await this.#store.listOpenRuntimeBindings();
    const closed: RuntimeBinding[] = [];
    for (const binding of bindings) {
      closed.push(await this.closeRuntimeBinding(binding.id, reason));
    }
    return closed;
  }

  async reopenRuntimeBinding(bindingId: string): Promise<RuntimeBinding> {
    return await this.#withConfigurationLock(async () => {
      await this.#registry.syncDynamicAgents();
      const previous = await this.#store.getRuntimeBinding(bindingId);
      if (previous.status !== "closed") {
        return previous;
      }
      const agent =
        this.#modelRouter?.getAgent(previous.agentId)
        ?? this.#fallbackRouterStore?.getAgent(previous.agentId);
      const provider = agent
        ? this.#modelRouter?.getProvider(agent.providerId)
          ?? this.#fallbackRouterStore?.getProvider(agent.providerId)
        : undefined;
      const bindingRevision = this.#orchestrator.adapterBindingRevision(previous.agentId);
      if (!agent || !provider || !bindingRevision) {
        throw new OrchestrationConfigError(
          "原 Agent 配置已删除或停用，不能重新打开持久会话。",
        );
      }
      const transportKind = transportKindForProtocol(provider.protocol);
      return await this.#store.ensureRuntimeBinding({
        topicId: previous.topicId,
        agentId: agent.id,
        actorId: agent.actorId,
        providerId: provider.id,
        bindingRevision,
        agentConfigRevision: agent.configRevision,
        providerConfigRevision: provider.configRevision,
        transportKind,
        processInstanceId: this.#processInstanceId,
      });
    });
  }

  // ---- Model Router 设置 ----

  async getModelRouter(): Promise<ModelRouterSnapshot> {
    if (!this.#modelRouter) {
      return { providers: [], agents: [], brands: [], catalog: { providers: [] } };
    }
    return await this.#modelRouter.snapshot();
  }

  async createProvider(input: CreateProviderInput): Promise<PublicProviderProfile> {
    if (!this.#modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const provider = await this.#modelRouter?.createProvider(input);
      if (!provider) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return provider;
    });
  }

  async updateProvider(id: string, input: UpdateProviderInput): Promise<PublicProviderProfile> {
    if (!this.#modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const provider = await this.#modelRouter?.updateProvider(id, input);
      if (!provider) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return provider;
    });
  }

  async removeProvider(id: string): Promise<PublicProviderProfile> {
    if (!this.#modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const provider = await this.#modelRouter?.removeProvider(id);
      if (!provider) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return provider;
    });
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    if (!this.#modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const agent = this.#modelRouter?.createAgent(input);
      if (!agent) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return agent;
    });
  }

  async updateAgent(id: string, input: UpdateAgentDefinitionInput): Promise<AgentDefinition> {
    if (!this.#modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const agent = this.#modelRouter?.updateAgent(id, input);
      if (!agent) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return agent;
    });
  }

  async removeAgent(id: string): Promise<AgentDefinition> {
    if (!this.#modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const agent = this.#modelRouter?.removeAgent(id);
      if (!agent) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return agent;
    });
  }

  async #settingsChanged(): Promise<void> {
    this.#registry.invalidateAvailability();
    await this.closeAllRuntimeBindings();
    await this.#registry.syncDynamicAgents();
    await this.#registry.ensureFreshAvailability(true);
  }

  async testAgent(id: string): Promise<ModelRouterConnectionTest> {
    if (!this.#modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#modelRouter.testAgent(id);
  }

  async listProviderModels(id: string): Promise<ProviderModels> {
    if (!this.#modelRouter) throw new OrchestrationConfigError("模型路由服务未启用。");
    return this.#modelRouter.listModels(id);
  }

  // ---- 任务委派转发 ----

  listWorkItemDelegations(topicId: string): WorkItemDelegation[] {
    if (!this.#delegationManager) {
      throw new OrchestrationConfigError("任务委派服务未启用。");
    }
    return this.#delegationManager.list(topicId);
  }

  /** 任务入口：单个任务（含无议题直接任务）的委派列表。 */
  listTaskDelegations(workItemId: string): WorkItemDelegation[] {
    if (!this.#delegationManager) throw new OrchestrationConfigError("任务委派服务未启用。");
    return this.#delegationManager.listForWorkItem(workItemId);
  }

  startWorkItemDelegation(input: StartWorkItemDelegationInput): WorkItemDelegation {
    if (!this.#delegationManager) {
      throw new OrchestrationConfigError("任务委派服务未启用。");
    }
    return this.#delegationManager.start(input);
  }

  startWorkItemDelegationBatch(
    input: StartWorkItemDelegationBatchInput,
  ): WorkItemDelegation[] {
    if (!this.#delegationManager) {
      throw new OrchestrationConfigError("任务委派服务未启用。");
    }
    return this.#delegationManager.startBatch(input);
  }

  async resumeWorkItemDelegation(id: string, expectedVersion: number, requestedPermission?: WorkItemDelegation["permissionProfile"]): Promise<WorkItemDelegation> {
    if (!this.#delegationManager) throw new OrchestrationConfigError("任务委派服务未启用。");
    return this.#delegationManager.resume(id, expectedVersion, requestedPermission);
  }

  cancelWorkItemDelegation(id: string): WorkItemDelegation {
    if (!this.#delegationManager) {
      throw new OrchestrationConfigError("任务委派服务未启用。");
    }
    return this.#delegationManager.cancel(id);
  }
}
