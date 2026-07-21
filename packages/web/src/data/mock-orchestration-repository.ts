/**
 * @input  依赖：自动轮次仓储契约、领域类型与浏览器随机 ID
 * @output 导出：MockOrchestrationRepository 交互式原型实现
 * @pos    mock 模式下独立模拟创建、启动、批准、取消和恢复
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  OrchestrationCapabilities,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";
import type {
  AgentConnectionTest,
  AgentSetting,
  UpdateAgentSettingInput,
} from "../types/agent-settings";
import type {
  OrchestrationListener,
  OrchestrationRepository,
} from "./orchestration-repository";

const MOCK_DELAY_MS = 80;

const CAPABILITIES: OrchestrationCapabilities = {
  adapters: [
    {
      id: "claude-code",
      publicAuthor: "claude",
      label: "Claude Code",
      available: true,
    },
    {
      id: "codex-shared",
      publicAuthor: "codex",
      label: "Codex",
      available: false,
      limitation: "当前仅自动共享回帖，不会从 Web 主动唤醒。",
    },
  ],
  defaultPolicy: {
    maxRounds: 4,
    agentTimeoutMs: 180_000,
    maxAttemptsPerRound: 1,
    maxManualRecoveries: 1,
    confirmation: { beforeRounds: [], beforeCompletion: true },
  },
};

const MOCK_AGENT_SETTINGS: AgentSetting[] = [
  {
    id: "claude",
    label: "Claude Code",
    kind: "claude-cli",
    model: "claude-opus-4-8",
    enabled: true,
    requiresApiKey: false,
    hasApiKey: false,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "codex",
    label: "Codex CLI",
    kind: "codex-cli",
    model: "",
    enabled: true,
    requiresApiKey: false,
    hasApiKey: false,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    model: "",
    enabled: false,
    requiresApiKey: true,
    hasApiKey: false,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "kimi",
    label: "Kimi",
    kind: "openai-compatible",
    model: "",
    enabled: false,
    requiresApiKey: true,
    hasApiKey: false,
    updatedAt: new Date(0).toISOString(),
  },
];

function cloneSnapshot(snapshot: OrchestrationSnapshot): OrchestrationSnapshot {
  return structuredClone(snapshot);
}

function waitForMock(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, MOCK_DELAY_MS));
}

export class MockOrchestrationRepository implements OrchestrationRepository {
  readonly #listeners = new Set<OrchestrationListener>();
  readonly #runs: OrchestrationRun[] = [];
  readonly #agentSettings = structuredClone(MOCK_AGENT_SETTINGS);
  #snapshot: OrchestrationSnapshot = {
    capabilities: structuredClone(CAPABILITIES),
    activeTopicId: "topic-idempotency",
    runs: [],
    sync: { status: "connected", label: "Mock 自动轮次" },
  };

  async loadCapabilities(): Promise<OrchestrationSnapshot> {
    await waitForMock();
    return cloneSnapshot(this.#snapshot);
  }

  async selectTopic(topicId: string): Promise<OrchestrationSnapshot> {
    await waitForMock();
    this.#snapshot.activeTopicId = topicId;
    this.#snapshot.runs = this.#runs.filter((run) => run.topicId === topicId);
    return this.#publish();
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    await waitForMock();
    return structuredClone(this.#findRun(runId));
  }

  async createRun(input: CreateOrchestrationRunInput): Promise<OrchestrationRun> {
    await waitForMock();
    const adapters = this.#snapshot.capabilities?.adapters ?? [];
    const now = new Date().toISOString();
    const run: OrchestrationRun = {
      id: `run_${crypto.randomUUID()}`,
      topicId: input.topicId,
      status: "idle",
      plan: input.plan.map((round) => {
        const adapter = adapters.find((candidate) => candidate.id === round.adapterId);
        if (!adapter?.available) {
          throw new Error("所选 Agent 当前不能由 Web 主动调用");
        }
        return { ...round, publicAuthor: adapter.publicAuthor };
      }),
      policy: structuredClone(CAPABILITIES.defaultPolicy),
      nextRoundIndex: 0,
      currentAttempt: 0,
      manualRecoveriesUsed: 0,
      confirmedGates: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#snapshot.activeTopicId = input.topicId;
    this.#runs.unshift(run);
    this.#syncVisibleRuns();
    this.#publish();
    return structuredClone(run);
  }

  async startRun(runId: string): Promise<OrchestrationSnapshot> {
    await waitForMock();
    const run = this.#findRun(runId);
    if (run.status !== "idle") {
      throw new Error("只有 idle 运行可以启动");
    }
    run.status = "waiting_agent";
    run.activeAgentId = run.plan[0]?.adapterId;
    run.currentAttempt = 1;
    this.#advance(run);
    return this.#publish();
  }

  async approveRun(input: ApproveOrchestrationRunInput): Promise<OrchestrationSnapshot> {
    await waitForMock();
    const run = this.#findRun(input.runId);
    if (
      run.status !== "waiting_user"
      || run.pendingGateId !== input.expectedGateId
      || run.version !== input.expectedVersion
    ) {
      throw new Error("确认门或运行版本已经变化");
    }
    run.status = "running";
    run.confirmedGates.push(input.expectedGateId);
    delete run.pendingGateId;
    this.#advance(run);
    return this.#publish();
  }

  async cancelRun(runId: string): Promise<OrchestrationSnapshot> {
    await waitForMock();
    const run = this.#findRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return cloneSnapshot(this.#snapshot);
    }
    run.status = "cancelled";
    delete run.activeAgentId;
    delete run.pendingGateId;
    this.#advance(run);
    return this.#publish();
  }

  async recoverRun(runId: string): Promise<OrchestrationSnapshot> {
    await waitForMock();
    const run = this.#findRun(runId);
    if (run.status !== "failed") {
      throw new Error("只有 failed 运行可以恢复");
    }
    if (run.manualRecoveriesUsed >= run.policy.maxManualRecoveries) {
      throw new Error("自动轮次的人工恢复预算已经耗尽");
    }
    run.status = "running";
    run.manualRecoveriesUsed += 1;
    delete run.failure;
    this.#advance(run);
    return this.#publish();
  }

  async listAgentSettings(): Promise<AgentSetting[]> {
    await waitForMock();
    return structuredClone(this.#agentSettings);
  }

  async updateAgentSetting(input: UpdateAgentSettingInput): Promise<AgentSetting> {
    await waitForMock();
    const setting = this.#agentSettings.find((candidate) => candidate.id === input.agentId);
    if (!setting) {
      throw new Error("Agent 设置不存在");
    }
    setting.model = input.model;
    setting.baseUrl = input.baseUrl;
    setting.enabled = input.enabled;
    setting.hasApiKey = input.clearApiKey ? false : Boolean(input.apiKey) || setting.hasApiKey;
    setting.updatedAt = new Date().toISOString();
    return structuredClone(setting);
  }

  async testAgentSetting(_agentId: string): Promise<AgentConnectionTest> {
    await waitForMock();
    return { ok: true, latencyMs: MOCK_DELAY_MS };
  }

  subscribe(listener: OrchestrationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #findRun(runId: string): OrchestrationRun {
    const run = this.#runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error("自动轮次运行不存在");
    }
    return run;
  }

  #advance(run: OrchestrationRun): void {
    run.version += 1;
    run.updatedAt = new Date().toISOString();
  }

  #publish(): OrchestrationSnapshot {
    this.#syncVisibleRuns();
    const snapshot = cloneSnapshot(this.#snapshot);
    for (const listener of this.#listeners) {
      listener(cloneSnapshot(snapshot));
    }
    return snapshot;
  }

  #syncVisibleRuns(): void {
    const topicId = this.#snapshot.activeTopicId;
    this.#snapshot.runs = topicId
      ? this.#runs.filter((run) => run.topicId === topicId)
      : [];
  }
}
