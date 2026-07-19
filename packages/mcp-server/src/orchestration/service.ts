/**
 * @input  依赖：HTTP/Claude 配置、SQLiteCouncilStore、Agent 注册与 ExecutionManager
 * @output 导出：浏览器不可伪造身份和策略的编排产品服务
 * @pos    REST 契约使用的编排聚合根与生产依赖工厂
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
import { ClaudeRuntime } from "../claude-runtime.js";
import { CouncilNotFoundError } from "../errors.js";
import type { CouncilConfig, CouncilHttpConfig } from "../types.js";
import { ClaudeAgentAdapter } from "./claude-agent-adapter.js";
import { RunExecutionManager } from "./execution-manager.js";

export interface RegisteredAgentAdapter {
  adapter: AgentAdapter;
  publicAuthor: PublicAuthor;
  label?: string;
  available?: boolean;
  limitation?: string;
  checkAvailability?: () => Promise<boolean>;
}

export interface PublicRoundInput {
  adapterId: string;
  messageKind: MessageKind;
  instruction: string;
}

export interface PublicApprovalInput {
  expectedGateId: string;
  expectedVersion: number;
  approvalId: string;
}

function missingRun(error: unknown): boolean {
  return error instanceof RunNotFoundError;
}

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

  constructor(
    private readonly config: CouncilHttpConfig,
    registrations: readonly RegisteredAgentAdapter[],
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

  async createRun(topicId: string, plan: readonly PublicRoundInput[]): Promise<OrchestrationRun> {
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
          beforeCompletion: this.config.orchestrationConfirmCompletion,
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

  async initialize(): Promise<void> {
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
      if (!capability.available && !capability.limitation) {
        capability.limitation = "本地 Agent 自动调用当前不可用。";
      }
    }));
    await this.manager.recoverOnStartup();
  }

  async shutdown(): Promise<void> {
    await this.manager.shutdown();
  }

  close(): void {
    this.#store.close();
  }
}

export function createProductionOrchestrationService(
  httpConfig: CouncilHttpConfig,
  councilConfig: CouncilConfig,
): CouncilOrchestrationService {
  const runtime = new ClaudeRuntime(councilConfig);
  const claude = new ClaudeAgentAdapter(runtime, {
    maxContextChars: councilConfig.maxContextChars,
    ...(councilConfig.claudeModel ? { model: councilConfig.claudeModel } : {}),
  });
  return new CouncilOrchestrationService(httpConfig, [
    {
      adapter: claude,
      publicAuthor: "claude",
      label: "Claude Code",
      checkAvailability: async () => {
        const availability = await runtime.checkAvailability();
        return availability.available && availability.authenticated;
      },
    },
  ]);
}
