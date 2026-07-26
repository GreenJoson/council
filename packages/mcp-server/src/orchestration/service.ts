/**
 * @input  依赖：HTTP/Agent 配置、SQLiteCouncilStore、模型路由、Agent 临时工厂、
 *         增量草稿中心、统一日志与 ExecutionManager
 * @output 导出：带配置互斥的编排产品服务、安全 Model Router 入口及临时 Agent 草稿流
 * @pos    REST/SSE 契约使用的编排与模型配置一致性聚合根、生产依赖工厂
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createHash, randomUUID } from "node:crypto";
import {
  CouncilOrchestrator,
  OrchestrationConfigError,
  RunNotFoundError,
  RunStateConflictError,
  SQLiteCouncilStore,
  type AgentAdapter,
  type ApproveGateResult,
  declaredCapabilitiesForTransport,
  defaultPolicyCapabilitiesForTransport,
  deriveCycleRequirements,
  type DiscussionCycleView,
  type DiscussionCycleKind,
  findCapabilityGaps,
  grantRuntimeCapabilities,
  type MessageKind,
  type OrchestrationRun,
  type PaginatedRuns,
  type RuntimeBinding,
  type RuntimeCapabilityKey,
  type RuntimeCapabilitySnapshot,
  type CycleTaskRequirements,
  type RuntimeTransportKind,
} from "council-orchestrator";
import {
  type CreateAgentInput,
  type CreateProviderInput,
  ModelRouterService,
  type ModelRouterSnapshot,
  type PublicProviderProfile,
  type UpdateAgentDefinitionInput,
  type UpdateProviderInput,
} from "../model-router-service.js";
import {
  type AgentDefinition,
  ModelRouterStore,
  type ProviderProfile,
} from "../model-router-store.js";
import { MAX_MESSAGE_CHARS } from "../constants.js";
import { ClaudeRuntime } from "../claude-runtime.js";
import { CodexRuntime } from "../codex-runtime.js";
import { CouncilNotFoundError } from "../errors.js";
import {
  MacOsKeychainSecretStore,
  UnavailableSecretStore,
} from "../keychain-secret-store.js";
import { logger } from "../logger.js";
import { OpenAICompatibleRuntime } from "../openai-compatible-runtime.js";
import type { CouncilConfig, CouncilHttpConfig } from "../types.js";
import { ClaudeAgentAdapter } from "./claude-agent-adapter.js";
import { CodexAgentAdapter } from "./codex-agent-adapter.js";
import {
  CycleDriver,
  type CycleDecisionWriter,
  type CycleRunner,
} from "./cycle-driver.js";
import { RunExecutionManager } from "./execution-manager.js";
import { AgentProgressHub } from "./agent-progress-hub.js";
import { OpenAICompatibleAgentAdapter } from "./openai-compatible-agent-adapter.js";

export interface RegisteredAgentAdapter {
  adapter: AgentAdapter;
  actorAlias: string;
  label?: string;
  available?: boolean;
  limitation?: string;
  /** 可用性检查失败时展示的可执行提示；未提供则回退到通用不可用说明。 */
  limitationWhenUnavailable?: string;
  checkAvailability?: () => Promise<boolean>;
  /** Runtime 自述能力；外部静态适配器未提供时保守降为纯文本。 */
  runtimeCapabilities?: readonly RuntimeCapabilityKey[];
}

export interface EphemeralAgentBinding {
  adapter: AgentAdapter;
  checkAvailability: () => Promise<boolean>;
  limitationWhenUnavailable?: string;
}

export type EphemeralAgentFactory = (
  agent: AgentDefinition,
  provider: ProviderProfile,
) => EphemeralAgentBinding;

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

export interface PublicAgentCapability {
  id: string;
  label: string;
  available: boolean;
  actorId: string;
  limitation?: string;
  runtimeCapabilities: RuntimeCapabilityKey[];
  mentionAlias?: string;
  providerId?: string;
  providerName?: string;
  brand?: {
    glyphId: string;
    colorToken: string;
    displayName: string;
  };
}

function missingRun(error: unknown): boolean {
  return error instanceof RunNotFoundError;
}

/** 可用性检测缓存时长：CLI 登录状态变化最迟这么久反映到 capabilities，无需重启服务。 */
export const AVAILABILITY_TTL_MS = 30_000;

export class CouncilOrchestrationService {
  readonly orchestrator: CouncilOrchestrator;
  readonly manager: RunExecutionManager;
  readonly #store: SQLiteCouncilStore;
  readonly #fallbackRouterStore?: ModelRouterStore;
  readonly #processInstanceId = `council_${randomUUID()}`;
  readonly #actors = new Map<string, string>();
  readonly #capabilities: PublicAgentCapability[] = [];
  readonly #availabilityChecks = new Map<string, () => Promise<boolean>>();
  readonly #unavailableLimitations = new Map<string, string>();
  readonly #baseLimitations = new Map<string, string | undefined>();
  readonly #staticAdapterIds = new Set<string>();
  readonly #dynamicAdapterFingerprints = new Map<string, string>();
  readonly #runtimeCapabilityOverrides = new Map<string, readonly RuntimeCapabilityKey[]>();
  readonly #cycles: CycleDriver;
  /** 决策写入器需要 CouncilDatabase，晚于本服务构造；开局时校验已挂载。 */
  #decisions: CycleDecisionWriter | undefined;
  #availabilityCheckedAt = 0;
  #availabilityRefresh: Promise<void> | null = null;
  #configurationTail = Promise.resolve();
  #runtimeBindingIdleTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  #runtimeBindingIdleSweep: Promise<void> | null = null;

  constructor(
    private readonly config: CouncilHttpConfig,
    registrations: readonly RegisteredAgentAdapter[],
    readonly modelRouter?: ModelRouterService,
    readonly progressHub = new AgentProgressHub(MAX_MESSAGE_CHARS),
    private readonly ephemeralAgentFactory?: EphemeralAgentFactory,
  ) {
    this.#store = new SQLiteCouncilStore(
      config.databasePath,
      config.sqliteBusyTimeoutMs,
      Date.now,
      config.defaultMessageLimit,
    );
    if (!modelRouter) {
      this.#fallbackRouterStore = new ModelRouterStore(
        config.databasePath,
        config.sqliteBusyTimeoutMs,
      );
    }
    for (const registration of registrations) {
      if (this.#actors.has(registration.adapter.adapterId)) {
        this.#store.close();
        throw new Error("编排 Agent 注册重复。");
      }
      const actorId = this.#store.resolveActorAlias(registration.actorAlias);
      this.#actors.set(registration.adapter.adapterId, actorId);
      this.#staticAdapterIds.add(registration.adapter.adapterId);
      this.#capabilities.push({
        id: registration.adapter.adapterId,
        label: registration.label ?? registration.adapter.adapterId,
        available: registration.available ?? true,
        actorId,
        runtimeCapabilities: [...(registration.runtimeCapabilities ?? ["text"])],
        ...(registration.limitation ? { limitation: registration.limitation } : {}),
      });
      if (registration.runtimeCapabilities) {
        this.#runtimeCapabilityOverrides.set(
          registration.adapter.adapterId,
          registration.runtimeCapabilities,
        );
      }
      if (registration.checkAvailability) {
        this.#availabilityChecks.set(
          registration.adapter.adapterId,
          registration.checkAvailability,
        );
      }
      this.#baseLimitations.set(registration.adapter.adapterId, registration.limitation);
      if (registration.limitationWhenUnavailable) {
        this.#unavailableLimitations.set(
          registration.adapter.adapterId,
          registration.limitationWhenUnavailable,
        );
      }
    }
    this.orchestrator = new CouncilOrchestrator(
      this.#store,
      registrations.map((registration) => registration.adapter),
      {
        runtimeEvents: progressHub,
        // 未被适配器分类的异常此前会静默消失，运行里只剩一句无信息量的兜底文案。
        onUnclassifiedError: ({ runId, adapterId }, error) => {
          logger.error(
            "orchestration",
            `Agent 调用抛出未分类异常：run=${runId} adapter=${adapterId}`,
            error,
          );
        },
      },
    );
    this.manager = new RunExecutionManager(this.orchestrator, {
      ownerId: this.#processInstanceId,
      leaseTtlMs: config.orchestrationLeaseTtlMs,
      leaseRenewMs: config.orchestrationLeaseRenewMs,
      sweepIntervalMs: config.orchestrationSweepIntervalMs,
      runPageLimit: config.orchestrationRunPageLimit,
      startupScanLimit: config.orchestrationStartupScanLimit,
      shutdownTimeoutMs: config.orchestrationShutdownTimeoutMs,
      onRunSettled: (runId) => {
        this.#advanceCycleAfterRun(runId);
      },
    });
    const runner: CycleRunner = {
      createRun: async (topicId, plan) => await this.createRun(topicId, plan),
      startRun: async (runId) => await this.start(runId),
    };
    this.#cycles = new CycleDriver({
      store: this.#store,
      runner,
      decisions: {
        recordProposedDecision: async (input) => {
          if (!this.#decisions) {
            throw new OrchestrationConfigError("决策写入器未挂载，无法记录圆桌结论。");
          }
          return await this.#decisions.recordProposedDecision(input);
        },
      },
      now: () => new Date().toISOString(),
    });
  }

  // ---- 圆桌讨论 ----

  /**
   * 挂载决策写入器。CouncilDatabase 由进程入口在本服务之后创建，
   * 所以只能事后注入；未挂载时开局会直接失败，不会拖到收敛那一刻才暴露。
   */
  attachDecisionWriter(writer: CycleDecisionWriter): void {
    this.#decisions = writer;
  }

  /** 用户点「开始圆桌」：冻结名册，随即召唤提案人，此后无需再点。 */
  async startCycle(input: {
    topicId: string;
    participants: readonly string[];
    roundBudget?: number;
    kind?: DiscussionCycleKind;
    taskRequirements?: CycleTaskRequirements;
  }): Promise<DiscussionCycleView> {
    if (!this.#decisions) {
      throw new OrchestrationConfigError("决策写入器未挂载，无法开始圆桌讨论。");
    }
    await this.#syncDynamicAgents();
    await this.#ensureFreshAvailability();
    for (const participant of input.participants) {
      if (!this.#actors.has(participant)) {
        throw new OrchestrationConfigError("参与名册包含未注册的 Agent 适配器。");
      }
      const publicCapability = this.#capabilities.find(
        (capability) => capability.id === participant,
      );
      if (!publicCapability?.available) {
        throw new OrchestrationConfigError(
          `参与者 ${participant} 当前不可用，圆桌尚未启动。`,
        );
      }
    }
    const kind = input.kind ?? "discussion";
    const requirements = deriveCycleRequirements({
      kind,
      participants: input.participants,
      ...(input.taskRequirements ? { task: input.taskRequirements } : {}),
    });
    const runtimeCapabilities = input.participants.map((participant) =>
      this.#freezeRuntimeCapabilities(participant));
    const gaps = findCapabilityGaps(requirements, runtimeCapabilities);
    if (gaps.length > 0) {
      const summary = gaps
        .map((gap) => `${gap.adapterId}: ${gap.missing.join(", ")}`)
        .join("；");
      throw new OrchestrationConfigError(
        `圆桌尚未启动：Runtime 能力不足（${summary}）。请更换具备所需能力的 Agent，或改用普通讨论。`,
      );
    }
    return await this.#cycles.start({
      topicId: input.topicId,
      participants: input.participants,
      ...(input.roundBudget === undefined ? {} : { roundBudget: input.roundBudget }),
      kind,
      requirements,
      runtimeCapabilities,
    });
  }

  #freezeRuntimeCapabilities(adapterId: string): RuntimeCapabilitySnapshot {
    const actorId = this.#actors.get(adapterId);
    const agent =
      this.modelRouter?.getAgent(adapterId)
      ?? this.#fallbackRouterStore?.getAgent(adapterId)
      ?? (actorId ? this.#fallbackRouterStore?.getAgent(actorId) : undefined);
    const provider = agent
      ? this.modelRouter?.getProvider(agent.providerId)
        ?? this.#fallbackRouterStore?.getProvider(agent.providerId)
      : undefined;
    const bindingRevision = this.orchestrator.adapterBindingRevision(adapterId);
    if (!actorId || !agent || !provider || !bindingRevision) {
      throw new OrchestrationConfigError(
        `参与者 ${adapterId} 缺少可冻结的 Agent、Provider 或 Runtime 版本。`,
      );
    }
    const transportKind = transportKindForProtocol(provider.protocol);
    const publicCapability = this.#capabilities.find(
      (capability) => capability.id === adapterId,
    );
    const declared = [
      ...(this.#runtimeCapabilityOverrides.get(adapterId)
        ?? (this.#staticAdapterIds.has(adapterId)
          ? publicCapability?.runtimeCapabilities ?? ["text"]
          : declaredCapabilitiesForTransport(transportKind))),
    ];
    const granted = grantRuntimeCapabilities(
      declared,
      defaultPolicyCapabilitiesForTransport(transportKind),
    );
    if (publicCapability) {
      publicCapability.runtimeCapabilities = [...granted];
    }
    return {
      schemaVersion: 1,
      adapterId,
      actorId,
      agentConfigRevision: agent.configRevision,
      providerId: provider.id,
      providerConfigRevision: provider.configRevision,
      bindingRevision,
      transportKind,
      declared,
      granted,
    };
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

  /** 用户主动放弃当前圆桌；Run 失败卡住时靠它把议题解锁。 */
  abandonCycle(topicId: string): DiscussionCycleView | undefined {
    return this.#cycles.abandon(topicId);
  }

  /** Run 落地后接着推进对应议题；这一步失败只记日志，不能反过来打断执行面。 */
  #advanceCycleAfterRun(runId: string): void {
    void (async () => {
      try {
        const run = await this.orchestrator.getRun(runId);
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

  capabilities(): object {
    return {
      adapters: this.#capabilities.map((capability) => ({ ...capability })),
      defaultPolicy: {
        maxRounds: this.config.orchestrationDefaultMaxRounds,
        agentTimeoutMs: this.config.orchestrationDefaultAgentTimeoutMs,
        maxAttemptsPerRound: this.config.orchestrationDefaultMaxAttempts,
        maxManualRecoveries: this.config.orchestrationDefaultMaxRecoveries,
        confirmation: {
          beforeRounds: [],
          beforeCompletion: this.config.orchestrationConfirmCompletion,
        },
      },
      limitations: [
        "Claude/Codex 通过议题级逻辑绑定恢复 session；兼容远程 Provider 保持无状态。",
        "只有已注册的后台适配器可以自动执行。",
      ],
    };
  }

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
    await this.#syncDynamicAgents();
    const hasUnavailableTarget = plan.some((round) => {
      const capability = this.#capabilities.find((item) => item.id === round.adapterId);
      return capability !== undefined && !capability.available;
    });
    if (hasUnavailableTarget) {
      // 用户明确点名了被标记不可用的适配器：强制复检而非等 TTL，让 CLI 刚登录立即可用
      await this.#ensureFreshAvailability(true);
    }
    const rounds = [];
    for (const round of plan) {
      const actorId = this.#actors.get(round.adapterId);
      if (!actorId) {
        throw new OrchestrationConfigError("计划包含未注册的 Agent 适配器。");
      }
      const capability = this.#capabilities.find((item) => item.id === round.adapterId);
      if (!capability?.available) {
        throw new OrchestrationConfigError("计划包含当前不可用的 Agent 适配器。");
      }
      const agent =
        this.modelRouter?.getAgent(round.adapterId)
        ?? this.#fallbackRouterStore?.getAgent(round.adapterId)
        ?? this.#fallbackRouterStore?.getAgent(actorId);
      const provider = agent
        ? this.modelRouter?.getProvider(agent.providerId)
          ?? this.#fallbackRouterStore?.getProvider(agent.providerId)
        : undefined;
      const bindingRevision = this.orchestrator.adapterBindingRevision(round.adapterId);
      if (!agent || !provider || !bindingRevision) {
        throw new OrchestrationConfigError(
          "计划 Agent 缺少可冻结的模型路由或适配器配置。",
        );
      }
      const transportKind = provider.protocol === "claude-cli"
        ? "claude-resume"
        : provider.protocol === "codex-cli"
          ? "codex-resume"
          : "openai-sessionless";
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
      rounds.push({
        ...round,
        actorId,
        bindingRevision,
        runtimeBindingId: binding.id,
      });
    }
    return await this.orchestrator.createRun({
      topicId,
      plan: rounds,
      policy: {
        maxRounds: this.config.orchestrationDefaultMaxRounds,
        allowedAgents: [...this.#actors.keys()],
        agentTimeoutMs: this.config.orchestrationDefaultAgentTimeoutMs,
        agentCleanupTimeoutMs: this.config.orchestrationAgentCleanupTimeoutMs,
        maxAttemptsPerRound: this.config.orchestrationDefaultMaxAttempts,
        maxManualRecoveries: this.config.orchestrationDefaultMaxRecoveries,
        confirmation: {
          beforeRounds: [],
          beforeCompletion:
            options.confirmationBeforeCompletion
            ?? this.config.orchestrationConfirmCompletion,
        },
      },
    });
  }

  async #withConfigurationLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#configurationTail;
    let release: (() => void) | undefined;
    this.#configurationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    try {
      return await this.orchestrator.getRun(runId);
    } catch (error) {
      if (missingRun(error)) {
        throw new CouncilNotFoundError("编排运行不存在。");
      }
      throw error;
    }
  }

  async listRuns(topicId: string, limit: number, offset: number): Promise<PaginatedRuns> {
    return await this.orchestrator.listRunsForTopic({ topicId, limit, offset });
  }

  async start(runId: string): Promise<OrchestrationRun> {
    await this.#syncDynamicAgents();
    await this.#assertRunAgentsConfigured(runId);
    return await this.manager.start(runId);
  }

  async approve(runId: string, input: PublicApprovalInput): Promise<ApproveGateResult> {
    return await this.manager.approve({
      runId,
      expectedGateId: input.expectedGateId,
      expectedVersion: input.expectedVersion,
      approvalId: input.approvalId,
      approvedByActorId: this.#store.resolveActorAlias("human"),
    });
  }

  async cancel(runId: string): Promise<OrchestrationRun> {
    return await this.manager.cancel(runId);
  }

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
    this.orchestrator.abortActiveBinding(
      bindingId,
      new Error("RuntimeBinding 已关闭，活动调用停止。"),
    );
    const closing = await this.#store.requestRuntimeBindingClose(bindingId, reason);
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
      await this.#syncDynamicAgents();
      const previous = await this.#store.getRuntimeBinding(bindingId);
      if (previous.status !== "closed") {
        return previous;
      }
      const agent =
        this.modelRouter?.getAgent(previous.agentId)
        ?? this.#fallbackRouterStore?.getAgent(previous.agentId);
      const provider = agent
        ? this.modelRouter?.getProvider(agent.providerId)
          ?? this.#fallbackRouterStore?.getProvider(agent.providerId)
        : undefined;
      const bindingRevision = this.orchestrator.adapterBindingRevision(previous.agentId);
      if (!agent || !provider || !bindingRevision) {
        throw new OrchestrationConfigError(
          "原 Agent 配置已删除或停用，不能重新打开持久会话。",
        );
      }
      const transportKind = provider.protocol === "claude-cli"
        ? "claude-resume"
        : provider.protocol === "codex-cli"
          ? "codex-resume"
          : "openai-sessionless";
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

  async recover(runId: string): Promise<OrchestrationRun> {
    return await this.#withConfigurationLock(async () => {
      await this.#syncDynamicAgents();
      await this.#assertRunAgentsConfigured(runId);
      return await this.manager.recover(runId);
    });
  }

  async #assertRunAgentsConfigured(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    const unavailable = run.plan.find(
      (round) =>
        !this.#actors.has(round.adapterId) ||
        !this.orchestrator.isAdapterBindingCurrent(
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

  async getModelRouter(): Promise<ModelRouterSnapshot> {
    if (!this.modelRouter) {
      return { providers: [], agents: [], brands: [], catalog: { providers: [] } };
    }
    return await this.modelRouter.snapshot();
  }

  async createProvider(input: CreateProviderInput): Promise<PublicProviderProfile> {
    if (!this.modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const provider = await this.modelRouter?.createProvider(input);
      if (!provider) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return provider;
    });
  }

  async updateProvider(id: string, input: UpdateProviderInput): Promise<PublicProviderProfile> {
    if (!this.modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const provider = await this.modelRouter?.updateProvider(id, input);
      if (!provider) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return provider;
    });
  }

  async removeProvider(id: string): Promise<PublicProviderProfile> {
    if (!this.modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const provider = await this.modelRouter?.removeProvider(id);
      if (!provider) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return provider;
    });
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    if (!this.modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const agent = this.modelRouter?.createAgent(input);
      if (!agent) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return agent;
    });
  }

  async updateAgent(id: string, input: UpdateAgentDefinitionInput): Promise<AgentDefinition> {
    if (!this.modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const agent = this.modelRouter?.updateAgent(id, input);
      if (!agent) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return agent;
    });
  }

  async removeAgent(id: string): Promise<AgentDefinition> {
    if (!this.modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.#withConfigurationLock(async () => {
      const agent = this.modelRouter?.removeAgent(id);
      if (!agent) {
        throw new OrchestrationConfigError("模型路由服务未启用。");
      }
      await this.#settingsChanged();
      return agent;
    });
  }

  async #settingsChanged(): Promise<void> {
    this.#availabilityCheckedAt = 0;
    await this.closeAllRuntimeBindings();
    await this.#syncDynamicAgents();
    await this.#ensureFreshAvailability(true);
  }

  async testAgent(id: string): Promise<{ ok: true; latencyMs: number }> {
    if (!this.modelRouter) {
      throw new OrchestrationConfigError("模型路由服务未启用。");
    }
    return await this.modelRouter.testAgent(id);
  }

  async initialize(): Promise<void> {
    await this.#store.markRuntimeBindingsInterrupted(this.#processInstanceId);
    await this.#closeIdleRuntimeBindings();
    await this.#syncDynamicAgents();
    await this.#ensureFreshAvailability(true);
    await this.manager.recoverOnStartup();
    this.#startRuntimeBindingIdleSweep();
  }

  #startRuntimeBindingIdleSweep(): void {
    if (this.#runtimeBindingIdleTimer) {
      return;
    }
    this.#runtimeBindingIdleTimer = globalThis.setInterval(() => {
      this.#runtimeBindingIdleSweep ??= this.#closeIdleRuntimeBindings()
        .catch((error: unknown) => {
          logger.error("runtime-binding", "空闲持久会话清理失败", error);
        })
        .finally(() => {
          this.#runtimeBindingIdleSweep = null;
        });
    }, this.config.orchestrationSweepIntervalMs);
  }

  async #closeIdleRuntimeBindings(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.config.runtimeBindingIdleTimeoutMs,
    ).toISOString();
    await this.#store.closeIdleRuntimeBindings(cutoff);
  }

  /** 返回 capabilities 前按 TTL 重新检测可用性，让 CLI 登录状态变化无需重启即可生效。 */
  async capabilitiesFresh(): Promise<object> {
    await this.#syncDynamicAgents();
    await this.#ensureFreshAvailability();
    return this.capabilities();
  }

  async #ensureFreshAvailability(force = false): Promise<void> {
    if (!force && Date.now() - this.#availabilityCheckedAt < AVAILABILITY_TTL_MS) {
      return;
    }
    this.#availabilityRefresh ??= this.#refreshAvailability().finally(() => {
      this.#availabilityRefresh = null;
    });
    await this.#availabilityRefresh;
  }

  async #refreshAvailability(): Promise<void> {
    await Promise.all(this.#capabilities.map(async (capability) => {
      const check = this.#availabilityChecks.get(capability.id);
      if (!check) {
        return;
      }
      try {
        capability.available = await check();
      } catch {
        capability.available = false;
      }
      const base = this.#baseLimitations.get(capability.id);
      if (capability.available) {
        if (base) {
          capability.limitation = base;
        } else {
          delete capability.limitation;
        }
      } else {
        capability.limitation =
          base ??
          this.#unavailableLimitations.get(capability.id) ??
          "本地 Agent 自动调用当前不可用。";
      }
    }));
    this.#availabilityCheckedAt = Date.now();
  }

  async #syncDynamicAgents(): Promise<void> {
    if (!this.modelRouter || !this.ephemeralAgentFactory) {
      return;
    }
    const snapshot = await this.modelRouter.snapshot();
    const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
    const enabledIds = new Set<string>();
    for (const agent of snapshot.agents) {
      const provider = providers.get(agent.providerId);
      if (
        !agent.enabled ||
        agent.deletedAt ||
        !provider ||
        provider.status !== "active"
      ) {
        continue;
      }
      enabledIds.add(agent.id);
      const fingerprintSource = JSON.stringify({
        agent: {
          id: agent.id,
          actorId: agent.actorId,
          providerId: agent.providerId,
          model: agent.model,
          mentionAlias: agent.mentionAlias,
          enabled: agent.enabled,
          configRevision: agent.configRevision,
        },
        provider: {
          id: provider.id,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          status: provider.status,
          configRevision: provider.configRevision,
        },
      });
      const fingerprint = `router:${createHash("sha256")
        .update(fingerprintSource)
        .digest("hex")}`;
      let binding: EphemeralAgentBinding | undefined;
      if (this.#dynamicAdapterFingerprints.get(agent.id) !== fingerprint) {
        binding = this.ephemeralAgentFactory(agent, provider);
        this.orchestrator.upsertAdapter(binding.adapter, fingerprint);
        this.#dynamicAdapterFingerprints.set(agent.id, fingerprint);
        this.#availabilityCheckedAt = 0;
      }
      this.#actors.set(agent.id, agent.actorId);
      const existing = this.#capabilities.find((item) => item.id === agent.id);
      const brand = snapshot.brands.find((item) => item.id === provider.brandAssetId);
      const next = {
        id: agent.id,
        label: agent.displayName,
        available: binding ? false : existing?.available ?? false,
        actorId: agent.actorId,
        mentionAlias: agent.mentionAlias,
        providerId: provider.id,
        providerName: provider.displayName,
        runtimeCapabilities: grantRuntimeCapabilities(
          declaredCapabilitiesForTransport(transportKindForProtocol(provider.protocol)),
          defaultPolicyCapabilitiesForTransport(
            transportKindForProtocol(provider.protocol),
          ),
        ),
        brand: brand ? {
          glyphId: brand.glyphId,
          colorToken: brand.colorToken,
          displayName: brand.displayName,
        } : undefined,
      };
      if (existing) {
        Object.assign(existing, next);
      } else {
        this.#capabilities.push(next);
      }
      if (binding) {
        this.#availabilityChecks.set(agent.id, binding.checkAvailability);
      }
      this.#baseLimitations.set(agent.id, undefined);
      if (binding?.limitationWhenUnavailable) {
        this.#unavailableLimitations.set(agent.id, binding.limitationWhenUnavailable);
      }
    }
    for (const capability of [...this.#capabilities]) {
      if (this.#staticAdapterIds.has(capability.id) || enabledIds.has(capability.id)) {
        continue;
      }
      this.#capabilities.splice(this.#capabilities.indexOf(capability), 1);
      this.orchestrator.removeAdapter(capability.id);
      this.#actors.delete(capability.id);
      this.#dynamicAdapterFingerprints.delete(capability.id);
      this.#availabilityChecks.delete(capability.id);
      this.#baseLimitations.delete(capability.id);
      this.#unavailableLimitations.delete(capability.id);
      this.#runtimeCapabilityOverrides.delete(capability.id);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#runtimeBindingIdleTimer) {
      globalThis.clearInterval(this.#runtimeBindingIdleTimer);
      this.#runtimeBindingIdleTimer = undefined;
    }
    await this.#runtimeBindingIdleSweep;
    await this.manager.shutdown();
  }

  close(): void {
    this.#store.close();
    this.#fallbackRouterStore?.close();
    this.modelRouter?.close();
  }
}

function transportKindForProtocol(
  protocol: ProviderProfile["protocol"],
): RuntimeTransportKind {
  return protocol === "claude-cli"
    ? "claude-resume"
    : protocol === "codex-cli"
      ? "codex-resume"
      : "openai-sessionless";
}

export function createProductionOrchestrationService(
  httpConfig: CouncilHttpConfig,
  councilConfig: CouncilConfig,
): CouncilOrchestrationService {
  const progressHub = new AgentProgressHub(MAX_MESSAGE_CHARS);
  const routerStore = new ModelRouterStore(
    httpConfig.databasePath,
    httpConfig.sqliteBusyTimeoutMs,
  );
  const secretStore = councilConfig.keychainCommand
    ? new MacOsKeychainSecretStore(councilConfig.keychainCommand)
    : new UnavailableSecretStore();
  const modelRouter = new ModelRouterService(routerStore, secretStore);
  const claudeRuntime = new ClaudeRuntime(councilConfig);
  const codexRuntime = new CodexRuntime(councilConfig);
  const remoteRuntime = new OpenAICompatibleRuntime(
    councilConfig.maxOutputChars,
    httpConfig.orchestrationDefaultAgentTimeoutMs,
  );

  modelRouter.registerTester(async (agent, provider, apiKey) => {
    if (provider.protocol === "claude-cli") {
      await claudeRuntime.generate({
        prompt: "只回复 OK",
        cwd: process.cwd(),
        ...(agent.model || councilConfig.claudeModel
          ? { model: agent.model || councilConfig.claudeModel }
          : {}),
      });
      return;
    }
    if (provider.protocol === "codex-cli") {
      await codexRuntime.generate({
        prompt: "只回复 OK",
        cwd: process.cwd(),
        ...(agent.model || councilConfig.codexModel
          ? { model: agent.model || councilConfig.codexModel }
          : {}),
      });
      return;
    }
    if (!provider.baseUrl || !apiKey) {
      throw new Error("远程 Provider 配置不完整。");
    }
      await remoteRuntime.generate({
        baseUrl: provider.baseUrl,
        model: agent.model,
        apiKey,
        prompt: "只回复 OK",
      });
  });

  const factory: EphemeralAgentFactory = (agent, provider) => {
    if (provider.protocol === "claude-cli") {
      return {
        adapter: new ClaudeAgentAdapter(claudeRuntime, {
          adapterId: agent.id,
          maxContextChars: councilConfig.maxContextChars,
          getModel: () => modelRouter.getAgent(agent.id)?.model || councilConfig.claudeModel,
        }),
        checkAvailability: async () => {
          const availability = await claudeRuntime.checkAvailability();
          return await modelRouter.isAgentReady(agent.id)
            && availability.available
            && availability.authenticated;
        },
        limitationWhenUnavailable:
          "Claude CLI 当前不可用或未登录；请检查本机安装和登录状态。",
      };
    }
    if (provider.protocol === "codex-cli") {
      return {
        adapter: new CodexAgentAdapter(codexRuntime, {
          adapterId: agent.id,
          maxContextChars: councilConfig.maxContextChars,
          getModel: () => modelRouter.getAgent(agent.id)?.model || councilConfig.codexModel,
        }),
        checkAvailability: async () => {
          const availability = await codexRuntime.checkAvailability();
          return await modelRouter.isAgentReady(agent.id)
            && availability.available
            && availability.authenticated;
        },
        limitationWhenUnavailable:
          "Codex CLI 当前不可用或未登录；请检查本机安装和登录状态。",
      };
    }
    return {
      adapter: new OpenAICompatibleAgentAdapter(
        agent.id,
        remoteRuntime,
        modelRouter,
        councilConfig.maxContextChars,
      ),
      checkAvailability: async () => await modelRouter.isAgentReady(agent.id),
      limitationWhenUnavailable:
        `请在设置中完成 ${provider.displayName} 的连接与 Agent 模型配置。`,
    };
  };

  return new CouncilOrchestrationService(
    httpConfig,
    [],
    modelRouter,
    progressHub,
    factory,
  );
}
