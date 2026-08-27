/**
 * @input  依赖：DesktopBridge 编排命令、OrchestrationRepository 协议与可注入的 HTTP 委托工厂
 * @output 导出：DesktopOrchestrationRepository、AI 实施计划、离线快照构造与桥接子接口
 * @pos    桌面模式的自动轮次接入层——探测本地 Agent 服务并在其可达时切换为 HTTP 直连，
 *         不可达时保持诚实的离线快照并周期重试，服务起来后自动转 LIVE，无需重启应用
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  DesktopOrchestrationConfig,
  DesktopOrchestrationHealth,
} from "./desktop-bridge";
import type {
  AnswerCycleQuestionInput,
  SubmitFixesInput,
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  GenerateWorkItemsInput,
  GenerateWorkItemsResult,
  OrchestrationRun,
  OrchestrationSnapshot,
  RuntimeBinding,
  StartCycleInput,
} from "../types/orchestration";
import type {
  AgentConnectionTest,
  AgentDefinition,
  CreateAgentInput,
  CreateProviderInput,
  ModelRouterSnapshot,
  ProviderProfile,
  UpdateAgentInput,
  UpdateProviderInput,
} from "../types/model-router";
import type {
  OrchestrationListener,
  OrchestrationRepository,
} from "./orchestration-repository";

/** 仅暴露编排接入所需的桥接命令，方便测试注入替身。 */
export interface DesktopOrchestrationBridge {
  getOrchestrationConfig(): Promise<DesktopOrchestrationConfig>;
  checkOrchestrationService(): Promise<DesktopOrchestrationHealth>;
  startOrchestrationService(): Promise<void>;
}

export interface DesktopOrchestrationRepositoryOptions {
  bridge: DesktopOrchestrationBridge;
  /** 服务可达时创建真正的 HTTP 编排仓储；由工厂集中注入配置。 */
  createDelegate: (baseUrl: string) => OrchestrationRepository;
  /** 离线状态下的健康探测重试间隔（毫秒）。 */
  healthCheckIntervalMs: number;
}

export function buildOfflineLimitation(baseUrl: string | undefined): string {
  return baseUrl
    ? `内置 Agent 服务暂未就绪（${baseUrl}）。Council 正在自动重试；持续失败请查看本地服务日志。`
    : "尚未获取本地 Agent 服务地址，正在重试读取桌面设置。";
}

/** 服务不可达时面板展示的诚实快照：能力条目存在但不可调用，附带可执行指引。 */
export function buildOfflineOrchestrationSnapshot(
  baseUrl: string | undefined,
  activeTopicId?: string,
): OrchestrationSnapshot {
  return {
    capabilities: {
      adapters: [{
        id: "local-agent-service",
        actorId: "council",
        label: "本地 Agent 服务",
        available: false,
        runtimeCapabilities: [],
        limitation: buildOfflineLimitation(baseUrl),
      }],
      defaultPolicy: {
        maxRounds: 1,
        agentIdleTimeoutMs: 1,
        agentTimeoutMs: 1,
        maxAttemptsPerRound: 1,
        maxManualRecoveries: 0,
        confirmation: { beforeRounds: [], beforeCompletion: true },
      },
    },
    ...(activeTopicId ? { activeTopicId } : {}),
    runs: [],
    sync: { status: "offline", label: "本地 Agent 服务未连接" },
  };
}

export class DesktopOrchestrationRepository implements OrchestrationRepository {
  readonly #bridge: DesktopOrchestrationBridge;
  readonly #createDelegate: (baseUrl: string) => OrchestrationRepository;
  readonly #healthCheckIntervalMs: number;
  readonly #listeners = new Set<OrchestrationListener>();
  #delegate: OrchestrationRepository | undefined;
  #delegateUnsubscribe: (() => void) | undefined;
  #baseUrl: string | undefined;
  #autostartConfigured = false;
  #autostartAttempted = false;
  #activeTopicId: string | undefined;
  #timer: ReturnType<typeof globalThis.setInterval> | undefined;
  #promotionPromise: Promise<OrchestrationRepository | undefined> | undefined;
  #lastOfflineKey: string | undefined;

  constructor(options: DesktopOrchestrationRepositoryOptions) {
    if (
      !Number.isSafeInteger(options.healthCheckIntervalMs)
      || options.healthCheckIntervalMs <= 0
    ) {
      throw new Error("healthCheckIntervalMs 必须是正整数");
    }
    this.#bridge = options.bridge;
    this.#createDelegate = options.createDelegate;
    this.#healthCheckIntervalMs = options.healthCheckIntervalMs;
  }

  async loadCapabilities(): Promise<OrchestrationSnapshot> {
    const delegate = await this.#tryPromote();
    if (!delegate) {
      this.#ensureTimer();
      return this.#publishOffline();
    }
    return delegate.loadCapabilities();
  }

  async selectTopic(topicId: string): Promise<OrchestrationSnapshot> {
    const normalizedTopicId = topicId.trim();
    if (!normalizedTopicId) {
      throw new Error("topicId 不能为空");
    }
    this.#activeTopicId = normalizedTopicId;
    const delegate = await this.#tryPromote();
    if (!delegate) {
      this.#ensureTimer();
      return this.#publishOffline();
    }
    return delegate.selectTopic(normalizedTopicId);
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    return (await this.#requireLive()).getRun(runId);
  }

  async createRun(input: CreateOrchestrationRunInput): Promise<OrchestrationRun> {
    return (await this.#requireLive()).createRun(input);
  }

  async generateWorkItems(input: GenerateWorkItemsInput): Promise<GenerateWorkItemsResult> {
    return (await this.#requireLive()).generateWorkItems(input);
  }

  async startRun(runId: string): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).startRun(runId);
  }

  async approveRun(input: ApproveOrchestrationRunInput): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).approveRun(input);
  }

  async startCycle(input: StartCycleInput): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).startCycle(input);
  }

  async answerCycleQuestion(
    input: AnswerCycleQuestionInput,
  ): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).answerCycleQuestion(input);
  }

  async submitFixes(input: SubmitFixesInput): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).submitFixes(input);
  }

  async abandonCycle(topicId: string): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).abandonCycle(topicId);
  }

  async cancelRun(runId: string): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).cancelRun(runId);
  }

  async recoverRun(runId: string): Promise<OrchestrationSnapshot> {
    return (await this.#requireLive()).recoverRun(runId);
  }

  async closeRuntimeBinding(bindingId: string): Promise<RuntimeBinding> {
    return (await this.#requireLive()).closeRuntimeBinding(bindingId);
  }

  async reopenRuntimeBinding(bindingId: string): Promise<RuntimeBinding> {
    return (await this.#requireLive()).reopenRuntimeBinding(bindingId);
  }

  async getModelRouter(): Promise<ModelRouterSnapshot> {
    return (await this.#requireLive()).getModelRouter();
  }

  async createProvider(input: CreateProviderInput): Promise<ProviderProfile> {
    return (await this.#requireLive()).createProvider(input);
  }

  async updateProvider(input: UpdateProviderInput): Promise<ProviderProfile> {
    return (await this.#requireLive()).updateProvider(input);
  }

  async removeProvider(providerId: string): Promise<ProviderProfile> {
    return (await this.#requireLive()).removeProvider(providerId);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    return (await this.#requireLive()).createAgent(input);
  }

  async updateAgent(input: UpdateAgentInput): Promise<AgentDefinition> {
    return (await this.#requireLive()).updateAgent(input);
  }

  async removeAgent(agentId: string): Promise<AgentDefinition> {
    return (await this.#requireLive()).removeAgent(agentId);
  }

  async testAgent(agentId: string): Promise<AgentConnectionTest> {
    return (await this.#requireLive()).testAgent(agentId);
  }

  subscribe(listener: OrchestrationListener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      const delegate = this.#delegate;
      if (delegate) {
        this.#attachDelegate(delegate);
      } else {
        this.#ensureTimer();
      }
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#detachDelegate();
        this.#stopTimer();
      }
    };
  }

  /** 写操作必须在 LIVE 状态执行；离线时抛出与面板一致的诚实指引。 */
  async #requireLive(): Promise<OrchestrationRepository> {
    const delegate = await this.#tryPromote();
    if (!delegate) {
      this.#ensureTimer();
      throw new Error(buildOfflineLimitation(this.#baseUrl));
    }
    return delegate;
  }

  /** 串行化的接入尝试：已 LIVE 直接返回，正在尝试则等待同一结果。 */
  async #tryPromote(): Promise<OrchestrationRepository | undefined> {
    if (this.#delegate) {
      return this.#delegate;
    }
    if (this.#promotionPromise) {
      return this.#promotionPromise;
    }
    const promise = this.#performPromotion();
    this.#promotionPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#promotionPromise === promise) {
        this.#promotionPromise = undefined;
      }
    }
  }

  async #performPromotion(): Promise<OrchestrationRepository | undefined> {
    try {
      if (this.#baseUrl === undefined) {
        const config = await this.#bridge.getOrchestrationConfig();
        this.#baseUrl = config.baseUrl;
        this.#autostartConfigured = config.autostartConfigured;
      }
      const health = await this.#bridge.checkOrchestrationService();
      if (!health.reachable) {
        await this.#maybeAutostart();
        return undefined;
      }
    } catch {
      // 桥接失败（配置无效、探测异常）与服务离线同样处理：保持离线并周期重试。
      return undefined;
    }
    const baseUrl = this.#baseUrl;
    if (baseUrl === undefined) {
      return undefined;
    }
    const delegate = this.#createDelegate(baseUrl);
    try {
      if (this.#listeners.size > 0) {
        this.#attachDelegate(delegate);
      }
      await delegate.loadCapabilities();
    } catch {
      // 探测通过但真实加载失败（服务刚退出等竞态）：拆除委托，回到离线重试。
      this.#detachDelegate();
      return undefined;
    }
    this.#delegate = delegate;
    this.#lastOfflineKey = undefined;
    this.#stopTimer();
    if (this.#activeTopicId !== undefined) {
      try {
        await delegate.selectTopic(this.#activeTopicId);
      } catch {
        // 选题校准失败不回退 LIVE；SSE 与后续显式选题会继续校准。
      }
    }
    return delegate;
  }

  async #maybeAutostart(): Promise<void> {
    if (!this.#autostartConfigured || this.#autostartAttempted) {
      return;
    }
    this.#autostartAttempted = true;
    try {
      await this.#bridge.startOrchestrationService();
    } catch {
      // 拉起失败保持离线；周期探测在服务被手动启动后仍会自动转 LIVE。
    }
  }

  #attachDelegate(delegate: OrchestrationRepository): void {
    this.#delegateUnsubscribe ??= delegate.subscribe((snapshot) => {
      for (const listener of this.#listeners) {
        listener(structuredClone(snapshot));
      }
    });
  }

  #detachDelegate(): void {
    this.#delegateUnsubscribe?.();
    this.#delegateUnsubscribe = undefined;
  }

  #ensureTimer(): void {
    if (this.#timer !== undefined || this.#listeners.size === 0 || this.#delegate) {
      return;
    }
    this.#timer = globalThis.setInterval(() => {
      void this.#pollHealth();
    }, this.#healthCheckIntervalMs);
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) {
      globalThis.clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #pollHealth(): Promise<void> {
    if (this.#delegate || this.#promotionPromise) {
      return;
    }
    const delegate = await this.#tryPromote();
    if (!delegate) {
      this.#publishOffline();
    }
  }

  /** 发布离线快照；内容未变化时跳过重复通知，避免无意义的界面重渲染。 */
  #publishOffline(): OrchestrationSnapshot {
    const snapshot = buildOfflineOrchestrationSnapshot(this.#baseUrl, this.#activeTopicId);
    const key = `${this.#baseUrl ?? ""}|${this.#activeTopicId ?? ""}`;
    if (key !== this.#lastOfflineKey) {
      this.#lastOfflineKey = key;
      for (const listener of this.#listeners) {
        listener(structuredClone(snapshot));
      }
    }
    return snapshot;
  }
}
