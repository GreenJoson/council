/**
 * @input  依赖：HTTP/Agent 配置、SQLiteCouncilStore、模型路由、Agent 临时工厂、
 *         增量草稿中心、统一日志、ExecutionManager、AgentRegistry 与 CouncilProductService
 * @output 导出：带配置互斥的编排服务聚合根（装配 store/attention/audit/orchestrator/manager/CycleDriver，
 *         并以同名同签名方法转发到 AgentRegistry 与 CouncilProductService，含一次性调用与 Agent 候选）、
 *         生产依赖工厂，以及从两个协作模块再导出的注册/Run/审批类型与 AVAILABILITY_TTL_MS
 * @pos    REST/SSE 契约使用的编排、模型配置与 supervisor→executor 执行一致性聚合根、生产依赖工厂
 *         （Codex 绑定的可用性检查顺带刷新生图探针声明；工厂装配并挂载 P3 PipelineService，
 *         initialize 在委派恢复后启动流水线对账，shutdown/close 同步停止与关闭）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { RuntimeAuditStore } from "./runtime-audit-store.js";
import { WorkAttentionStore } from "./work-attention-store.js";
import { randomUUID } from "node:crypto";
import {
  CouncilOrchestrator,
  OrchestrationConfigError,
  SQLiteCouncilStore,
  type ApproveGateResult,
  defaultPolicyCapabilitiesForTransport,
  type DiscussionCycleView,
  type DiscussionCycleKind,
  type CycleReviewScope,
  declaredCapabilitiesForTransport,
  grantRuntimeCapabilities,
  type OrchestrationRun,
  type PaginatedRuns,
  type RuntimeBinding,
  type CycleTaskRequirements,
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
import {
  MacOsKeychainSecretStore,
  UnavailableSecretStore,
} from "../keychain-secret-store.js";
import { logger } from "../logger.js";
import { AcpDelegatedRuntime } from "../acp-delegated-runtime.js";
import {
  createProductionAcpRuntimeRegistry,
  type AcpRuntimeDefinition,
  type AcpRuntimeRegistry,
} from "../acp-runtime-registry.js";
import { OpenAICompatibleModelClient } from "../openai-compatible-model-client.js";
import { createModelRouterProbe } from "../model-router-probes.js";
import type { ModelRouterConnectionTest } from "../model-router-service.js";
import type { ProviderModels } from "../model-diagnostics.js";
import { ReadOnlyAgentLoop } from "../read-only-agent-loop.js";
import type { CouncilConfig, CouncilHttpConfig } from "../types.js";
import { ClaudeAgentAdapter } from "./claude-agent-adapter.js";
import { CodexAgentAdapter } from "./codex-agent-adapter.js";
import {
  CycleDriver,
  type CycleDecisionWriter,
  type CycleRunner,
} from "./cycle-driver.js";
import type { ReviewLedgerWriter } from "./review-ledger.js";
import { RunExecutionManager } from "./execution-manager.js";
import { AgentProgressHub } from "./agent-progress-hub.js";
import { AcpDelegatedAgentAdapter } from "./acp-delegated-agent-adapter.js";
import { OpenAICompatibleAgentAdapter } from "./openai-compatible-agent-adapter.js";
import {
  WorkItemDelegationManager,
  type StartWorkItemDelegationBatchInput,
  type StartWorkItemDelegationInput,
} from "./work-item-delegation-manager.js";
import type { WorkItemDelegation } from "./work-item-delegation-store.js";
import {
  AgentRegistry,
  type EphemeralAgentFactory,
  type RegisteredAgentAdapter,
} from "./agent-registry.js";
import { CouncilDatabase } from "../database.js";
import { PipelineService } from "../pipelines/pipeline-service.js";
import {
  CouncilProductService,
  type AgentCandidate,
  type CreateRunOptions,
  type PublicApprovalInput,
  type PublicRoundInput,
} from "./product-service.js";

export type {
  EphemeralAgentBinding,
  EphemeralAgentFactory,
  PublicAgentCapability,
  RegisteredAgentAdapter,
} from "./agent-registry.js";
export { AVAILABILITY_TTL_MS } from "./agent-registry.js";
export type {
  CreateRunOptions,
  PublicApprovalInput,
  PublicRoundInput,
} from "./product-service.js";

export class CouncilOrchestrationService {
  readonly audit: RuntimeAuditStore;
  readonly attention: WorkAttentionStore;
  readonly orchestrator: CouncilOrchestrator;
  readonly manager: RunExecutionManager;
  readonly #store: SQLiteCouncilStore;
  readonly #fallbackRouterStore?: ModelRouterStore;
  readonly #processInstanceId = `council_${randomUUID()}`;
  readonly #registry: AgentRegistry;
  readonly #cycles: CycleDriver;
  /** 产品接线在聚合根装配完成后才构造；manager/CycleDriver 的回调都是延迟取用，不会提前触发。 */
  readonly #product: CouncilProductService;
  /** 决策写入器需要 CouncilDatabase，晚于本服务构造；开局时校验已挂载。 */
  #decisions: CycleDecisionWriter | undefined;
  #reviewLedger: ReviewLedgerWriter | undefined;
  /** P3 流水线用例；生产工厂在构造后挂载，测试/嵌入场景可缺省（路由返回 503）。 */
  #pipelines: PipelineService | undefined;
  #configurationTail = Promise.resolve();
  #runtimeBindingIdleTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  #runtimeBindingIdleSweep: Promise<void> | null = null;

  constructor(
    private readonly config: CouncilHttpConfig,
    registrations: readonly RegisteredAgentAdapter[],
    readonly modelRouter?: ModelRouterService,
    readonly progressHub = new AgentProgressHub(MAX_MESSAGE_CHARS),
    ephemeralAgentFactory?: EphemeralAgentFactory,
    readonly delegationManager?: WorkItemDelegationManager,
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
    // 注册循环在这里执行：注册重复要在打开 attention/audit 之前抛出，与拆分前顺序一致。
    this.#registry = new AgentRegistry({
      store: this.#store,
      registrations,
      config,
      modelRouter,
      fallbackRouterStore: this.#fallbackRouterStore,
      ephemeralAgentFactory,
      orchestrator: () => this.orchestrator,
      closeRuntimeBinding: async (bindingId, reason) =>
        await this.#product.closeRuntimeBinding(bindingId, reason),
    });
    this.attention = new WorkAttentionStore(config.databasePath, config.sqliteBusyTimeoutMs);
    this.audit = new RuntimeAuditStore(config.databasePath, config.sqliteBusyTimeoutMs);
    this.orchestrator = new CouncilOrchestrator(
      this.#store,
      registrations.map((registration) => registration.adapter),
      {
        runtimeEvents: { emit: (event) => { progressHub.emit(event); this.audit.emit(event); } },
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
        this.#product.advanceCycleAfterRun(runId);
      },
    });
    const runner: CycleRunner = {
      createRun: async (topicId, plan) => await this.#product.createRun(topicId, plan),
      startRun: async (runId) => await this.#product.start(runId),
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
      reviewLedger: () => this.#reviewLedger,
      now: () => new Date().toISOString(),
    });
    this.#product = new CouncilProductService({
      config,
      store: this.#store,
      orchestrator: this.orchestrator,
      manager: this.manager,
      cycles: this.#cycles,
      registry: this.#registry,
      processInstanceId: this.#processInstanceId,
      modelRouter,
      fallbackRouterStore: this.#fallbackRouterStore,
      delegationManager,
      decisionWriter: () => this.#decisions,
      withConfigurationLock: async <T>(operation: () => Promise<T> | T): Promise<T> =>
        await this.#withConfigurationLock(operation),
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

  /**
   * 挂载审核账本写入器。与决策写入器同理由事后注入；
   * 未挂载时修复互审仍能跑，只是审出的问题不会自动落成任务。
   */
  attachReviewLedger(ledger: ReviewLedgerWriter): void {
    this.#reviewLedger = ledger;
  }

  /** 挂载流水线用例；它依赖本服务的一次性调用与委派转发，只能在构造后注入。 */
  attachPipelines(pipelines: PipelineService): void {
    this.#pipelines = pipelines;
  }

  get pipelines(): PipelineService | undefined {
    return this.#pipelines;
  }

  invokeOneShot(input: Parameters<CouncilProductService["invokeOneShot"]>[0]): Promise<{ actorId: string; content: string }> {
    return this.#product.invokeOneShot(input);
  }

  listAgentCandidates(): Promise<AgentCandidate[]> {
    return this.#product.listAgentCandidates();
  }

  async startCycle(input: {
    topicId: string;
    participants: readonly string[];
    roundBudget?: number;
    kind?: DiscussionCycleKind;
    reviewScope?: CycleReviewScope;
    taskRequirements?: CycleTaskRequirements;
  }): Promise<DiscussionCycleView> {
    return await this.#product.startCycle(input);
  }

  readCycle(topicId: string): DiscussionCycleView | undefined { return this.#product.readCycle(topicId); }

  readLatestCycle(topicId: string): DiscussionCycleView | undefined {
    return this.#product.readLatestCycle(topicId);
  }

  async answerCycleQuestion(input: {
    topicId: string;
    questionMessageId: string;
    answerMessageId: string;
  }): Promise<DiscussionCycleView | undefined> {
    return await this.#product.answerCycleQuestion(input);
  }

  async submitFixes(input: { topicId: string }): Promise<DiscussionCycleView | undefined> {
    return await this.#product.submitFixes(input);
  }

  abandonCycle(topicId: string): DiscussionCycleView | undefined { return this.#product.abandonCycle(topicId); }

  // ---- Agent 名册与可用性 ----

  capabilities(): object { return this.#registry.capabilities(); }

  async capabilitiesFresh(): Promise<object> { return await this.#registry.capabilitiesFresh(); }

  // ---- Run 生命周期 ----

  async createRun(
    topicId: string,
    plan: readonly PublicRoundInput[],
    options?: CreateRunOptions,
  ): Promise<OrchestrationRun> {
    return await this.#product.createRun(topicId, plan, options);
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

  async getRun(runId: string): Promise<OrchestrationRun> { return await this.#product.getRun(runId); }

  async listRuns(topicId: string, limit: number, offset: number): Promise<PaginatedRuns> {
    return await this.#product.listRuns(topicId, limit, offset);
  }

  async start(runId: string): Promise<OrchestrationRun> { return await this.#product.start(runId); }

  async generateWorkItemPlan(input: {
    topicId: string;
    adapterId: string;
    instruction: string;
    contextMessage: string;
    signal?: AbortSignal;
  }): Promise<{ actorId: string; content: string }> {
    return await this.#product.generateWorkItemPlan(input);
  }

  async approve(runId: string, input: PublicApprovalInput): Promise<ApproveGateResult> {
    return await this.#product.approve(runId, input);
  }

  async cancel(runId: string): Promise<OrchestrationRun> { return await this.#product.cancel(runId); }

  async recover(runId: string): Promise<OrchestrationRun> { return await this.#product.recover(runId); }

  // ---- RuntimeBinding 生命周期 ----

  async listRuntimeBindings(topicId: string, includeClosed?: boolean): Promise<readonly RuntimeBinding[]> {
    return await this.#product.listRuntimeBindings(topicId, includeClosed);
  }

  async closeRuntimeBinding(bindingId: string, reason?: string): Promise<RuntimeBinding> {
    return await this.#product.closeRuntimeBinding(bindingId, reason);
  }

  async closeTopicRuntimeBindings(topicId: string, reason?: string): Promise<readonly RuntimeBinding[]> {
    return await this.#product.closeTopicRuntimeBindings(topicId, reason);
  }

  async closeAllRuntimeBindings(reason?: string): Promise<readonly RuntimeBinding[]> {
    return await this.#product.closeAllRuntimeBindings(reason);
  }

  async reopenRuntimeBinding(bindingId: string): Promise<RuntimeBinding> {
    return await this.#product.reopenRuntimeBinding(bindingId);
  }

  // ---- Model Router 设置 ----

  async getModelRouter(): Promise<ModelRouterSnapshot> { return await this.#product.getModelRouter(); }

  async createProvider(input: CreateProviderInput): Promise<PublicProviderProfile> {
    return await this.#product.createProvider(input);
  }

  async updateProvider(id: string, input: UpdateProviderInput): Promise<PublicProviderProfile> {
    return await this.#product.updateProvider(id, input);
  }

  async removeProvider(id: string): Promise<PublicProviderProfile> {
    return await this.#product.removeProvider(id);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    return await this.#product.createAgent(input);
  }

  async updateAgent(id: string, input: UpdateAgentDefinitionInput): Promise<AgentDefinition> {
    return await this.#product.updateAgent(id, input);
  }

  async removeAgent(id: string): Promise<AgentDefinition> { return await this.#product.removeAgent(id); }

  async testAgent(id: string): Promise<ModelRouterConnectionTest> { return await this.#product.testAgent(id); }

  async listProviderModels(id: string): Promise<ProviderModels> {
    return await this.#product.listProviderModels(id);
  }

  // ---- 任务委派转发 ----

  listWorkItemDelegations(topicId: string): WorkItemDelegation[] {
    return this.#product.listWorkItemDelegations(topicId);
  }

  listTaskDelegations(workItemId: string): WorkItemDelegation[] {
    return this.#product.listTaskDelegations(workItemId);
  }

  startWorkItemDelegation(input: StartWorkItemDelegationInput): Promise<WorkItemDelegation> {
    return this.#product.startWorkItemDelegation(input);
  }

  startWorkItemDelegationBatch(input: StartWorkItemDelegationBatchInput): WorkItemDelegation[] {
    return this.#product.startWorkItemDelegationBatch(input);
  }

  async resumeWorkItemDelegation(id: string, expectedVersion: number, requestedPermission?: WorkItemDelegation["permissionProfile"]): Promise<WorkItemDelegation> {
    return await this.#product.resumeWorkItemDelegation(id, expectedVersion, requestedPermission);
  }

  cancelWorkItemDelegation(id: string): WorkItemDelegation { return this.#product.cancelWorkItemDelegation(id); }

  // ---- 生命周期 ----

  async initialize(): Promise<void> {
    this.delegationManager?.initialize();
    await this.#store.markRuntimeBindingsInterrupted(this.#processInstanceId);
    await this.#closeIdleRuntimeBindings();
    await this.#registry.syncDynamicAgents();
    await this.#registry.ensureFreshAvailability(true);
    await this.manager.recoverOnStartup();
    // 委派管理器已恢复：流水线订阅终态并对账上次停在 running 的阶段。
    await this.#pipelines?.initialize();
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

  get activeTaskCount(): number {
    return this.manager.activeTaskCount + (this.delegationManager?.activeTaskCount ?? 0);
  }

  async shutdown(): Promise<void> {
    if (this.#runtimeBindingIdleTimer) {
      globalThis.clearInterval(this.#runtimeBindingIdleTimer);
      this.#runtimeBindingIdleTimer = undefined;
    }
    await this.#runtimeBindingIdleSweep;
    this.#pipelines?.shutdown();
    await this.delegationManager?.shutdown();
    await this.manager.shutdown();
    const bindings = await this.#store.listOpenRuntimeBindings();
    await Promise.allSettled(
      bindings.map(async (binding) =>
        await this.orchestrator.closeAdapterBinding(binding.agentId, binding.id)),
    );
  }

  close(): void {
    this.attention.close();
    this.audit.close();
    this.#pipelines?.close();
    this.delegationManager?.close();
    this.#store.close();
    this.#fallbackRouterStore?.close();
    this.modelRouter?.close();
  }
}

function acpDefinitionForProvider(
  provider: ProviderProfile,
  registry: AcpRuntimeRegistry,
): AcpRuntimeDefinition {
  if (provider.protocol !== "acp" || !provider.runtimeDefinitionId) {
    throw new OrchestrationConfigError(
      `Provider ${provider.slug} 没有绑定 ACP RuntimeDefinition。`,
    );
  }
  return registry.require(provider.runtimeDefinitionId);
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
  const acpRegistry = createProductionAcpRuntimeRegistry(councilConfig);
  const acpRuntime = new AcpDelegatedRuntime(councilConfig);
  const remoteModelClient = new OpenAICompatibleModelClient(
    councilConfig.maxOutputChars,
    httpConfig.orchestrationDefaultAgentTimeoutMs,
  );
  const remoteAgentLoop = new ReadOnlyAgentLoop(remoteModelClient, councilConfig);

  modelRouter.registerModelLister((baseUrl, apiKey) => remoteModelClient.listModels(baseUrl, apiKey));
  modelRouter.registerTester(createModelRouterProbe({ claude: claudeRuntime, codex: codexRuntime, remote: remoteModelClient,
    claudeModel: councilConfig.claudeModel, codexModel: councilConfig.codexModel,
    acp: async (provider, cwd, model) => {
      const definition = acpDefinitionForProvider(provider, acpRegistry);
      const granted = grantRuntimeCapabilities(definition.declaredCapabilities, defaultPolicyCapabilitiesForTransport("acp"));
      await acpRuntime.probe(definition, cwd, model, granted);
    },
  }));

  const factory: EphemeralAgentFactory = (agent, provider) => {
    if (provider.protocol === "claude-cli") {
      return {
        adapter: new ClaudeAgentAdapter(claudeRuntime, {
          adapterId: agent.id,
          maxContextChars: councilConfig.maxContextChars,
          getModel: () => modelRouter.getAgent(agent.id)?.model || councilConfig.claudeModel,
        }),
        // 与 Codex 同形：声明 image_input，P3 流水线 brief/review 阶段据此读取参考图与产物。
        checkAvailability: async () => {
          const availability = await claudeRuntime.checkAvailability();
          return {
            available: await modelRouter.isAgentReady(agent.id)
              && availability.available
              && availability.authenticated,
            runtimeCapabilities: declaredCapabilitiesForTransport("claude-resume"),
          };
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
        // 生图探针随可用性一起刷新：只有探针通过才声明 image_generate/image_input。
        checkAvailability: async () => {
          const availability = await codexRuntime.checkAvailability();
          return {
            available: await modelRouter.isAgentReady(agent.id)
              && availability.available
              && availability.authenticated,
            runtimeCapabilities: declaredCapabilitiesForTransport("codex-resume", {
              imageGeneration: availability.imageGeneration.available,
            }),
          };
        },
        limitationWhenUnavailable:
          "Codex CLI 当前不可用或未登录；请检查本机安装和登录状态。",
      };
    }
    if (provider.protocol === "acp") {
      const definition = acpDefinitionForProvider(provider, acpRegistry);
      const grantedCapabilities = grantRuntimeCapabilities(
        definition.declaredCapabilities,
        defaultPolicyCapabilitiesForTransport("acp"),
      );
      return {
        adapter: new AcpDelegatedAgentAdapter(
          agent.id,
          acpRuntime,
          definition,
          grantedCapabilities,
          modelRouter,
          councilConfig.maxContextChars,
        ),
        checkAvailability: async () => {
          const availability = await acpRuntime.checkAvailability(definition);
          return await modelRouter.isAgentReady(agent.id)
            && availability.available
            && availability.authenticated;
        },
        limitationWhenUnavailable: definition.limitationWhenUnavailable,
        runtimeCapabilities: definition.declaredCapabilities,
      };
    }
    return {
      adapter: new OpenAICompatibleAgentAdapter(
        agent.id,
        remoteAgentLoop,
        modelRouter,
        councilConfig.maxContextChars,
      ),
      checkAvailability: async () => await modelRouter.isAgentReady(agent.id),
      limitationWhenUnavailable:
        `请在设置中完成 ${provider.displayName} 的连接与 Agent 模型配置。`,
    };
  };

  const delegationManager = WorkItemDelegationManager.fromConfig(
    httpConfig,
    councilConfig,
    modelRouter,
    claudeRuntime,
    codexRuntime,
  );
  const service = new CouncilOrchestrationService(
    httpConfig,
    [],
    modelRouter,
    progressHub,
    factory,
    delegationManager,
  );
  // P3 流水线：独立数据库连接（schema 已由委派管理器的连接校验），一次性调用与委派都走本服务的转发，
  // 因而复用配置锁与生图执行者探针校验。
  service.attachPipelines(new PipelineService({
    database: new CouncilDatabase(councilConfig.databasePath, councilConfig.sqliteBusyTimeoutMs),
    agents: {
      invokeOneShot: async (input) => await service.invokeOneShot(input),
      listAgentCandidates: async () => await service.listAgentCandidates(),
      actorIdOf: (agentId) => modelRouter.getAgent(agentId)?.actorId,
    },
    delegations: {
      start: async (input) => await service.startWorkItemDelegation(input),
      cancel: (id) => service.cancelWorkItemDelegation(id),
      get: (id) => delegationManager.get(id),
      onSettled: (listener) => delegationManager.onSettled(listener),
      stageProjectInputs: async (root, assetIds, signal) =>
        await delegationManager.stageProjectInputs(root, assetIds, signal),
    },
    limits: {
      maxStages: councilConfig.pipelineMaxStages ?? 6,
      maxRevisions: councilConfig.pipelineMaxRevisions ?? 3,
    },
  }));
  return service;
}
