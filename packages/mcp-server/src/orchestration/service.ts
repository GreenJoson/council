/**
 * @input  依赖：HTTP/Agent 配置、SQLiteCouncilStore、模型设置、Agent 注册、
 *         增量草稿中心与 ExecutionManager
 * @output 导出：编排产品服务、安全模型设置入口及临时 Agent 草稿流
 * @pos    REST/SSE 契约使用的编排聚合根与生产依赖工厂
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  CouncilOrchestrator,
  OrchestrationConfigError,
  RunNotFoundError,
  SQLiteCouncilStore,
  type AgentAdapter,
  type ApproveGateResult,
  type MessageKind,
  type OrchestrationRun,
  type PaginatedRuns,
  type PublicAuthor,
} from "council-orchestrator";
import {
  AgentSettingsService,
  type PublicAgentSetting,
  type UpdateAgentSettingInput,
} from "../agent-settings-service.js";
import { AgentSettingsStore } from "../agent-settings-store.js";
import { MAX_MESSAGE_CHARS } from "../constants.js";
import { ClaudeRuntime } from "../claude-runtime.js";
import { CodexRuntime } from "../codex-runtime.js";
import { CouncilNotFoundError } from "../errors.js";
import {
  MacOsKeychainSecretStore,
  UnavailableSecretStore,
} from "../keychain-secret-store.js";
import { OpenAICompatibleRuntime } from "../openai-compatible-runtime.js";
import type { CouncilConfig, CouncilHttpConfig } from "../types.js";
import { ClaudeAgentAdapter } from "./claude-agent-adapter.js";
import { CodexAgentAdapter } from "./codex-agent-adapter.js";
import { RunExecutionManager } from "./execution-manager.js";
import { AgentProgressHub } from "./agent-progress-hub.js";
import { OpenAICompatibleAgentAdapter } from "./openai-compatible-agent-adapter.js";

export interface RegisteredAgentAdapter {
  adapter: AgentAdapter;
  publicAuthor: PublicAuthor;
  label?: string;
  available?: boolean;
  limitation?: string;
  /** 可用性检查失败时展示的可执行提示；未提供则回退到通用不可用说明。 */
  limitationWhenUnavailable?: string;
  checkAvailability?: () => Promise<boolean>;
}

export interface PublicRoundInput {
  adapterId: string;
  messageKind: MessageKind;
  instruction: string;
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

/** 可用性检测缓存时长：CLI 登录状态变化最迟这么久反映到 capabilities，无需重启服务。 */
export const AVAILABILITY_TTL_MS = 30_000;

export class CouncilOrchestrationService {
  readonly orchestrator: CouncilOrchestrator;
  readonly manager: RunExecutionManager;
  readonly #store: SQLiteCouncilStore;
  readonly #authors = new Map<string, PublicAuthor>();
  readonly #capabilities: Array<{
    id: string;
    label: string;
    available: boolean;
    publicAuthor: PublicAuthor;
    limitation?: string;
  }> = [];
  readonly #availabilityChecks = new Map<string, () => Promise<boolean>>();
  readonly #unavailableLimitations = new Map<string, string>();
  readonly #baseLimitations = new Map<string, string | undefined>();
  #availabilityCheckedAt = 0;
  #availabilityRefresh: Promise<void> | null = null;

  constructor(
    private readonly config: CouncilHttpConfig,
    registrations: readonly RegisteredAgentAdapter[],
    readonly agentSettings?: AgentSettingsService,
    readonly progressHub = new AgentProgressHub(MAX_MESSAGE_CHARS),
  ) {
    this.#store = new SQLiteCouncilStore(
      config.databasePath,
      config.sqliteBusyTimeoutMs,
      Date.now,
      config.defaultMessageLimit,
    );
    for (const registration of registrations) {
      if (this.#authors.has(registration.adapter.adapterId)) {
        this.#store.close();
        throw new Error("编排 Agent 注册重复。");
      }
      this.#authors.set(registration.adapter.adapterId, registration.publicAuthor);
      this.#capabilities.push({
        id: registration.adapter.adapterId,
        label: registration.label ?? registration.adapter.adapterId,
        available: registration.available ?? true,
        publicAuthor: registration.publicAuthor,
        ...(registration.limitation ? { limitation: registration.limitation } : {}),
      });
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
    );
    this.manager = new RunExecutionManager(this.orchestrator, {
      leaseTtlMs: config.orchestrationLeaseTtlMs,
      leaseRenewMs: config.orchestrationLeaseRenewMs,
      sweepIntervalMs: config.orchestrationSweepIntervalMs,
      runPageLimit: config.orchestrationRunPageLimit,
      startupScanLimit: config.orchestrationStartupScanLimit,
      shutdownTimeoutMs: config.orchestrationShutdownTimeoutMs,
    });
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
        "V1 不恢复 Agent session。",
        "只有已注册的后台适配器可以自动执行。",
      ],
    };
  }

  async createRun(
    topicId: string,
    plan: readonly PublicRoundInput[],
    options: CreateRunOptions = {},
  ): Promise<OrchestrationRun> {
    const hasUnavailableTarget = plan.some((round) => {
      const capability = this.#capabilities.find((item) => item.id === round.adapterId);
      return capability !== undefined && !capability.available;
    });
    if (hasUnavailableTarget) {
      // 用户明确点名了被标记不可用的适配器：强制复检而非等 TTL，让 CLI 刚登录立即可用
      await this.#ensureFreshAvailability(true);
    }
    const rounds = plan.map((round) => {
      const publicAuthor = this.#authors.get(round.adapterId);
      if (!publicAuthor) {
        throw new OrchestrationConfigError("计划包含未注册的 Agent 适配器。");
      }
      const capability = this.#capabilities.find((item) => item.id === round.adapterId);
      if (!capability?.available) {
        throw new OrchestrationConfigError("计划包含当前不可用的 Agent 适配器。");
      }
      return { ...round, publicAuthor };
    });
    return await this.orchestrator.createRun({
      topicId,
      plan: rounds,
      policy: {
        maxRounds: this.config.orchestrationDefaultMaxRounds,
        allowedAgents: [...this.#authors.keys()],
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
    return await this.manager.start(runId);
  }

  async approve(runId: string, input: PublicApprovalInput): Promise<ApproveGateResult> {
    return await this.manager.approve({
      runId,
      expectedGateId: input.expectedGateId,
      expectedVersion: input.expectedVersion,
      approvalId: input.approvalId,
      approvedBy: "human",
    });
  }

  async cancel(runId: string): Promise<OrchestrationRun> {
    return await this.manager.cancel(runId);
  }

  async recover(runId: string): Promise<OrchestrationRun> {
    return await this.manager.recover(runId);
  }

  async listAgentSettings(): Promise<PublicAgentSetting[]> {
    if (!this.agentSettings) {
      return [];
    }
    return await this.agentSettings.list();
  }

  async updateAgentSetting(
    id: string,
    input: UpdateAgentSettingInput,
  ): Promise<PublicAgentSetting> {
    if (!this.agentSettings) {
      throw new OrchestrationConfigError("模型设置服务未启用。");
    }
    const setting = await this.agentSettings.update(id, input);
    this.#availabilityCheckedAt = 0;
    await this.#ensureFreshAvailability(true);
    return setting;
  }

  async testAgentSetting(id: string): Promise<{ ok: true; latencyMs: number }> {
    if (!this.agentSettings) {
      throw new OrchestrationConfigError("模型设置服务未启用。");
    }
    return await this.agentSettings.test(id);
  }

  async initialize(): Promise<void> {
    await this.#ensureFreshAvailability(true);
    await this.manager.recoverOnStartup();
  }

  /** 返回 capabilities 前按 TTL 重新检测可用性，让 CLI 登录状态变化无需重启即可生效。 */
  async capabilitiesFresh(): Promise<object> {
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

  async shutdown(): Promise<void> {
    await this.manager.shutdown();
  }

  close(): void {
    this.#store.close();
    this.agentSettings?.close();
  }
}

export function createProductionOrchestrationService(
  httpConfig: CouncilHttpConfig,
  councilConfig: CouncilConfig,
): CouncilOrchestrationService {
  const progressHub = new AgentProgressHub(MAX_MESSAGE_CHARS);
  const settingsStore = new AgentSettingsStore(
    httpConfig.databasePath,
    httpConfig.sqliteBusyTimeoutMs,
    [
      {
        id: "claude",
        label: "Claude Code",
        kind: "claude-cli",
        model: councilConfig.claudeModel ?? "",
        enabled: true,
        requiresApiKey: false,
      },
      {
        id: "codex",
        label: "Codex CLI",
        kind: "codex-cli",
        model: councilConfig.codexModel ?? "",
        enabled: true,
        requiresApiKey: false,
      },
      {
        id: "deepseek",
        label: "DeepSeek",
        kind: "openai-compatible",
        model: "",
        enabled: false,
        requiresApiKey: true,
      },
      {
        id: "kimi",
        label: "Kimi",
        kind: "openai-compatible",
        model: "",
        enabled: false,
        requiresApiKey: true,
      },
    ],
  );
  const secretStore = councilConfig.keychainCommand
    ? new MacOsKeychainSecretStore(councilConfig.keychainCommand)
    : new UnavailableSecretStore();
  const agentSettings = new AgentSettingsService(settingsStore, secretStore);
  const claudeRuntime = new ClaudeRuntime(councilConfig);
  const claude = new ClaudeAgentAdapter(claudeRuntime, {
    maxContextChars: councilConfig.maxContextChars,
    getModel: () => agentSettings.get("claude")?.model || undefined,
    progress: progressHub,
  });
  const codexRuntime = new CodexRuntime(councilConfig);
  const codex = new CodexAgentAdapter(codexRuntime, {
    maxContextChars: councilConfig.maxContextChars,
    getModel: () => agentSettings.get("codex")?.model || undefined,
    progress: progressHub,
  });
  const remoteRuntime = new OpenAICompatibleRuntime(
    councilConfig.maxOutputChars,
    httpConfig.orchestrationDefaultAgentTimeoutMs,
  );
  const deepseek = new OpenAICompatibleAgentAdapter(
    "deepseek",
    remoteRuntime,
    agentSettings,
    councilConfig.maxContextChars,
    progressHub,
  );
  const kimi = new OpenAICompatibleAgentAdapter(
    "kimi",
    remoteRuntime,
    agentSettings,
    councilConfig.maxContextChars,
    progressHub,
  );

  agentSettings.registerTester("claude", async () => {
    await claudeRuntime.generate({
      prompt: "只回复 OK",
      cwd: process.cwd(),
      ...(agentSettings.get("claude")?.model
        ? { model: agentSettings.get("claude")?.model }
        : {}),
    });
  });
  agentSettings.registerTester("codex", async () => {
    await codexRuntime.generate({
      prompt: "只回复 OK",
      cwd: process.cwd(),
      ...(agentSettings.get("codex")?.model
        ? { model: agentSettings.get("codex")?.model }
        : {}),
    });
  });
  for (const id of ["deepseek", "kimi"] as const) {
    agentSettings.registerTester(id, async () => {
      const setting = agentSettings.get(id);
      const apiKey = await agentSettings.getApiKey(id);
      if (!setting?.baseUrl || !setting.model || !apiKey) {
        throw new Error("远程 Provider 配置不完整。");
      }
      await remoteRuntime.generate({
        baseUrl: setting.baseUrl,
        model: setting.model,
        apiKey,
        prompt: "只回复 OK",
      });
    });
  }

  return new CouncilOrchestrationService(httpConfig, [
    {
      adapter: claude,
      publicAuthor: "claude",
      label: "Claude Code",
      checkAvailability: async () => {
        const availability = await claudeRuntime.checkAvailability();
        return await agentSettings.isReady("claude")
          && availability.available
          && availability.authenticated;
      },
    },
    {
      adapter: codex,
      publicAuthor: "codex",
      label: "Codex CLI",
      limitationWhenUnavailable:
        "Codex CLI 当前不可用或未登录；请安装 codex 并运行 codex login 后重试。",
      checkAvailability: async () => {
        const availability = await codexRuntime.checkAvailability();
        return await agentSettings.isReady("codex")
          && availability.available
          && availability.authenticated;
      },
    },
    {
      adapter: deepseek,
      publicAuthor: "other",
      label: "DeepSeek",
      limitationWhenUnavailable: "请在设置中配置 DeepSeek 的模型、API 地址和 API Key。",
      checkAvailability: async () => await agentSettings.isReady("deepseek"),
    },
    {
      adapter: kimi,
      publicAuthor: "other",
      label: "Kimi",
      limitationWhenUnavailable: "请在设置中配置 Kimi 的模型、API 地址和 API Key。",
      checkAvailability: async () => await agentSettings.isReady("kimi"),
    },
  ], agentSettings, progressHub);
}
