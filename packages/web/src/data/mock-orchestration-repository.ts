/**
 * @input  依赖：自动轮次仓储契约、领域类型与浏览器随机 ID
 * @output 导出：MockOrchestrationRepository 运行、AI 实施计划与持久会话交互原型
 * @pos    mock 模式下模拟创建、启动、会话复用、关闭、增量草稿、取消和恢复
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AnswerCycleQuestionInput,
  SubmitFixesInput,
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  GenerateWorkItemsInput,
  GenerateWorkItemsResult,
  OrchestrationCapabilities,
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

const MOCK_DELAY_MS = 80;

const CAPABILITIES: OrchestrationCapabilities = {
  adapters: [
    {
      id: "claude-code",
      actorId: "claude",
      label: "Claude",
      available: true,
      runtimeCapabilities: [
        "text",
        "repository_read",
        "shell_read",
        "git_diff",
        "session_resume",
      ],
    },
    {
      id: "codex-shared",
      actorId: "codex",
      label: "Codex",
      available: false,
      runtimeCapabilities: [
        "text",
        "repository_read",
        "shell_read",
        "git_diff",
        "session_resume",
      ],
      limitation: "当前仅自动共享回帖，不会从 Web 主动唤醒。",
    },
  ],
  defaultPolicy: {
    maxRounds: 4,
    agentIdleTimeoutMs: 60_000,
    agentTimeoutMs: 180_000,
    maxAttemptsPerRound: 1,
    maxManualRecoveries: 1,
    confirmation: { beforeRounds: [], beforeCompletion: false },
  },
};

const MOCK_TIME = new Date(0).toISOString();
const MOCK_MODEL_ROUTER: ModelRouterSnapshot = {
  brands: [
    ["brand-claude", "claude", "Claude", "simple-icons-claude", "brand-claude"],
    ["brand-openai", "openai", "OpenAI", "simple-icons-openai", "brand-openai"],
    ["brand-kimi", "kimi", "Kimi", "simple-icons-kimi", "brand-kimi"],
    ["brand-deepseek", "deepseek", "DeepSeek", "simple-icons-deepseek", "brand-deepseek"],
    ["brand-grok", "grok", "Grok", "grok-feb-2025", "brand-grok"],
    ["brand-gemini", "gemini", "Gemini", "simple-icons-googlegemini", "brand-gemini"],
    ["brand-custom", "custom", "Custom", "generic-network", "brand-custom"],
  ].map(([id, slug, displayName, glyphId, colorToken]) => ({
    id: id as string,
    slug: slug as string,
    displayName: displayName as string,
    glyphId: glyphId as string,
    colorToken: colorToken as string,
    sourceKind: "project-curated" as const,
    sourceLabel: "Mock catalog",
    status: "active" as const,
    createdAt: MOCK_TIME,
    updatedAt: MOCK_TIME,
  })),
  providers: [
    {
      id: "provider-claude",
      slug: "claude",
      displayName: "Claude",
      protocol: "claude-cli",
      requiresApiKey: false,
      hasApiKey: false,
      brandAssetId: "brand-claude",
      status: "active",
      createdAt: MOCK_TIME,
      updatedAt: MOCK_TIME,
    },
    {
      id: "provider-codex",
      slug: "openai-codex",
      displayName: "OpenAI Codex",
      protocol: "codex-cli",
      requiresApiKey: false,
      hasApiKey: false,
      brandAssetId: "brand-openai",
      status: "active",
      createdAt: MOCK_TIME,
      updatedAt: MOCK_TIME,
    },
  ],
  agents: [
    {
      id: "claude-code",
      actorId: "claude",
      providerId: "provider-claude",
      slug: "claude-code",
      displayName: "Claude",
      model: "claude-opus-4-8",
      mentionAlias: "claude",
      enabled: true,
      createdAt: MOCK_TIME,
      updatedAt: MOCK_TIME,
    },
    {
      id: "codex-shared",
      actorId: "codex",
      providerId: "provider-codex",
      slug: "codex-shared",
      displayName: "Codex",
      model: "",
      mentionAlias: "codex",
      enabled: true,
      createdAt: MOCK_TIME,
      updatedAt: MOCK_TIME,
    },
  ],
  catalog: {
    providers: [
      ...[
        ["openai", "openai", "OpenAI", "brand-openai"],
        ["kimi", "kimi", "Kimi", "brand-kimi"],
        ["deepseek", "deepseek", "DeepSeek", "brand-deepseek"],
        ["grok", "grok", "Grok", "brand-grok"],
        ["custom", "custom", "Custom Provider", "brand-custom"],
      ].map(([templateId, slug, displayName, brandAssetId]) => ({
        templateId: templateId as string,
        slug: slug as string,
        displayName: displayName as string,
        protocol: "openai-compatible" as const,
        requiresApiKey: true,
        brandAssetId: brandAssetId as string,
        modelCandidates: [],
      })),
      {
      templateId: "kimi-code",
      slug: "kimi-code",
      displayName: "Kimi Code",
      protocol: "acp",
      runtimeDefinitionId: "kimi-code",
      requiresApiKey: false,
      brandAssetId: "brand-kimi",
      modelCandidates: ["kimi-code/k3", "kimi-code/k3-256k"],
    },
    {
      templateId: "gemini-cli-acp",
      slug: "gemini-cli",
      displayName: "Gemini CLI",
      protocol: "acp",
      runtimeDefinitionId: "gemini-cli",
      requiresApiKey: false,
      brandAssetId: "brand-gemini",
      modelCandidates: [],
    },
    {
      templateId: "grok-build-acp",
      slug: "grok-build",
      displayName: "Grok Build",
      protocol: "acp",
      runtimeDefinitionId: "grok-build",
      requiresApiKey: false,
      brandAssetId: "brand-grok",
      modelCandidates: [],
    },
    {
      templateId: "codex-acp",
      slug: "codex-acp",
      displayName: "OpenAI Codex ACP",
      protocol: "acp",
      runtimeDefinitionId: "codex-agent",
      requiresApiKey: false,
      brandAssetId: "brand-openai",
      modelCandidates: [],
    },
    {
      templateId: "claude-agent-acp",
      slug: "claude-agent-acp",
      displayName: "Claude Agent ACP",
      protocol: "acp",
      runtimeDefinitionId: "claude-agent",
      requiresApiKey: false,
      brandAssetId: "brand-claude",
      modelCandidates: [],
      },
    ],
  },
};

function cloneSnapshot(snapshot: OrchestrationSnapshot): OrchestrationSnapshot {
  return structuredClone(snapshot);
}

function waitForMock(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, MOCK_DELAY_MS));
}

export class MockOrchestrationRepository implements OrchestrationRepository {
  readonly #listeners = new Set<OrchestrationListener>();
  readonly #runs: OrchestrationRun[] = [];
  readonly #bindings: RuntimeBinding[] = [];
  readonly #modelRouter = structuredClone(MOCK_MODEL_ROUTER);
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
    this.#snapshot.runtimeBindings = this.#bindings.filter(
      (binding) => binding.topicId === topicId,
    );
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
        return { ...round, actorId: adapter.actorId };
      }),
      policy: {
        ...structuredClone(CAPABILITIES.defaultPolicy),
        confirmation: {
          ...CAPABILITIES.defaultPolicy.confirmation,
          beforeCompletion:
            input.confirmationBeforeCompletion
            ?? CAPABILITIES.defaultPolicy.confirmation.beforeCompletion,
        },
      },
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
    this.#ensureBinding(input.topicId, input.plan[0]?.adapterId);
    this.#syncVisibleRuns();
    this.#publish();
    return structuredClone(run);
  }

  async generateWorkItems(_input: GenerateWorkItemsInput): Promise<GenerateWorkItemsResult> {
    await waitForMock();
    return { createdCount: 3 };
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
    this.#snapshot.agentOutputs = [{
      runId: run.id,
      topicId: run.topicId,
      adapterId: run.activeAgentId ?? "claude-code",
      sequence: 1,
      content: "正在审查状态机边界",
    }];
    const snapshot = this.#publish();
    globalThis.setTimeout(() => {
      const output = this.#snapshot.agentOutputs?.find(
        (candidate) => candidate.runId === run.id,
      );
      if (!output || run.status !== "waiting_agent") {
        return;
      }
      output.sequence += 1;
      output.content += "，并整理可回滚的最小修复方案。";
      this.#publish();
    }, MOCK_DELAY_MS);
    return snapshot;
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

  /**
   * Mock 只演示"开局 → 提案人被召唤"这一段，后续交接由真实编排层驱动。
   * 这里不复刻状态机：复刻一份必然与 convergence.ts 漂移，反而误导 UI 调试。
   */
  async startCycle(input: StartCycleInput): Promise<OrchestrationSnapshot> {
    await waitForMock();
    const proposer = input.participants[0];
    if (!proposer) {
      throw new Error("参与名册不能为空");
    }
    const reviewScope = input.reviewScope
      ?? (input.kind === "fix_review" ? "commit" : "discussion");
    const kind = input.kind
      ?? (reviewScope === "commit" ? "fix_review" : "discussion");
    this.#snapshot.cycle = {
      cycle: {
        id: `cycle_${crypto.randomUUID()}`,
        topicId: input.topicId,
        stage: "proposal",
        status: "active",
        participants: [...input.participants],
        kind,
        requirements: {
          schemaVersion: 1,
          cycleKind: kind,
          reviewScope,
          task: {
            all: reviewScope === "workspace" ? ["repository_read"] : [],
            proposer: [],
            reviewers: [],
          },
          byParticipant: Object.fromEntries(
            input.participants.map((participant) => [
              participant,
              reviewScope === "workspace" ? ["text", "repository_read"] : ["text"],
            ]),
          ),
        },
        runtimeCapabilities: input.participants.map((adapterId) => {
          const adapter = CAPABILITIES.adapters.find(
            (candidate) => candidate.id === adapterId,
          );
          return {
            schemaVersion: 1,
            adapterId,
            actorId: adapter?.actorId ?? adapterId,
            agentConfigRevision: 1,
            providerId: adapter?.providerId ?? `provider-${adapterId}`,
            providerConfigRevision: 1,
            bindingRevision: `mock-${adapterId}`,
            transportKind: "mock",
            declared: adapter?.runtimeCapabilities ?? ["text"],
            granted: adapter?.runtimeCapabilities ?? ["text"],
          };
        }),
        turns: [],
        roundBudget: input.roundBudget ?? 3,
        currentRound: 1,
      },
    };
    const run = await this.createRun({
      topicId: input.topicId,
      plan: [{
        adapterId: proposer,
        messageKind: "proposal",
        instruction: input.kind === "fix_review"
          ? "先自审并提交，回帖时附上 commit 引用。"
          : "给出可执行方案，并说明失败条件与验证方式。",
      }],
    });
    return await this.startRun(run.id);
  }

  async answerCycleQuestion(
    input: AnswerCycleQuestionInput,
  ): Promise<OrchestrationSnapshot> {
    await waitForMock();
    const view = this.#snapshot.cycle;
    if (!view?.openQuestion || view.openQuestion.questionMessageId !== input.questionMessageId) {
      return cloneSnapshot(this.#snapshot);
    }
    this.#snapshot.cycle = { cycle: { ...view.cycle, stage: "critique" } };
    return this.#publish();
  }

  async submitFixes(_input: SubmitFixesInput): Promise<OrchestrationSnapshot> {
    await waitForMock();
    const view = this.#snapshot.cycle;
    if (!view || view.action?.kind !== "await_fix") {
      return cloneSnapshot(this.#snapshot);
    }
    // 与服务端同口径：提交只推进轮次，条目是否关闭由复审判定。
    this.#snapshot.cycle = {
      ...view,
      cycle: {
        ...view.cycle,
        stage: "critique",
        currentRound: view.cycle.currentRound + 1,
        roundBudget: Math.max(view.cycle.roundBudget, view.cycle.currentRound + 1),
      },
      action: { kind: "invoke" },
    };
    return this.#publish();
  }

  async abandonCycle(_topicId: string): Promise<OrchestrationSnapshot> {
    await waitForMock();
    delete this.#snapshot.cycle;
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
    this.#snapshot.agentOutputs = (this.#snapshot.agentOutputs ?? [])
      .filter((output) => output.runId !== run.id);
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

  async closeRuntimeBinding(bindingId: string): Promise<RuntimeBinding> {
    await waitForMock();
    const binding = this.#findBinding(bindingId);
    binding.status = "closed";
    binding.closeReason = "manual-close";
    binding.closedAt = new Date().toISOString();
    binding.updatedAt = binding.closedAt;
    binding.stateVersion += 1;
    this.#syncVisibleBindings();
    this.#publish();
    return structuredClone(binding);
  }

  async reopenRuntimeBinding(bindingId: string): Promise<RuntimeBinding> {
    await waitForMock();
    const previous = this.#findBinding(bindingId);
    if (previous.status !== "closed") {
      return structuredClone(previous);
    }
    const now = new Date().toISOString();
    const binding: RuntimeBinding = {
      ...previous,
      id: `binding_${crypto.randomUUID()}`,
      status: "idle",
      hasSession: false,
      stateVersion: 1,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    delete binding.closeReason;
    delete binding.closedAt;
    this.#bindings.push(binding);
    this.#syncVisibleBindings();
    this.#publish();
    return structuredClone(binding);
  }

  async getModelRouter(): Promise<ModelRouterSnapshot> {
    await waitForMock();
    return structuredClone(this.#modelRouter);
  }

  async createProvider(input: CreateProviderInput): Promise<ProviderProfile> {
    await waitForMock();
    const template = this.#modelRouter.catalog.providers.find(
      (candidate) => candidate.templateId === input.templateId,
    );
    if (!template) throw new Error("Provider 模板不存在");
    const provider: ProviderProfile = {
      id: `provider-${crypto.randomUUID()}`,
      slug: input.slug,
      displayName: input.displayName,
      protocol: template.protocol,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      requiresApiKey: template.requiresApiKey,
      hasApiKey: Boolean(input.apiKey),
      brandAssetId: input.brandAssetId ?? template.brandAssetId,
      ...(template.runtimeDefinitionId
        ? { runtimeDefinitionId: template.runtimeDefinitionId }
        : {}),
      status: input.active ? "active" : "inactive",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#modelRouter.providers.push(provider);
    return structuredClone(provider);
  }

  async updateProvider(input: UpdateProviderInput): Promise<ProviderProfile> {
    await waitForMock();
    const provider = this.#findProvider(input.providerId);
    provider.displayName = input.displayName;
    provider.baseUrl = input.baseUrl;
    provider.brandAssetId = input.brandAssetId;
    provider.status = input.active ? "active" : "inactive";
    provider.hasApiKey = input.clearApiKey ? false : Boolean(input.apiKey) || provider.hasApiKey;
    provider.updatedAt = new Date().toISOString();
    return structuredClone(provider);
  }

  async removeProvider(providerId: string): Promise<ProviderProfile> {
    await waitForMock();
    const provider = this.#findProvider(providerId);
    provider.status = "deleted";
    provider.updatedAt = new Date().toISOString();
    for (const agent of this.#modelRouter.agents) {
      if (agent.providerId === providerId) {
        agent.enabled = false;
        agent.deletedAt = provider.updatedAt;
      }
    }
    return structuredClone(provider);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    await waitForMock();
    this.#findProvider(input.providerId);
    const now = new Date().toISOString();
    const agent: AgentDefinition = {
      id: `agent-${crypto.randomUUID()}`,
      actorId: `actor-${crypto.randomUUID()}`,
      providerId: input.providerId,
      slug: input.slug,
      displayName: input.displayName,
      model: input.model,
      mentionAlias: input.mentionAlias,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
    this.#modelRouter.agents.push(agent);
    return structuredClone(agent);
  }

  async updateAgent(input: UpdateAgentInput): Promise<AgentDefinition> {
    await waitForMock();
    const agent = this.#findAgent(input.agentId);
    if (
      (agent.actorId === "claude" || agent.actorId === "codex") &&
      (
        input.displayName !== agent.displayName ||
        input.mentionAlias !== agent.mentionAlias
      )
    ) {
      throw new Error("Claude/Codex 系统 Agent 的名称与 @alias 不能修改");
    }
    agent.displayName = input.displayName;
    agent.model = input.model;
    agent.mentionAlias = input.mentionAlias;
    agent.enabled = input.enabled;
    agent.updatedAt = new Date().toISOString();
    return structuredClone(agent);
  }

  async removeAgent(agentId: string): Promise<AgentDefinition> {
    await waitForMock();
    const agent = this.#findAgent(agentId);
    if (agent.actorId === "claude" || agent.actorId === "codex") {
      throw new Error("Claude/Codex 系统 Agent 不能删除");
    }
    agent.enabled = false;
    agent.deletedAt = new Date().toISOString();
    agent.updatedAt = agent.deletedAt;
    return structuredClone(agent);
  }

  async testAgent(_agentId: string): Promise<AgentConnectionTest> {
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

  #findBinding(bindingId: string): RuntimeBinding {
    const binding = this.#bindings.find((candidate) => candidate.id === bindingId);
    if (!binding) {
      throw new Error("持久会话不存在");
    }
    return binding;
  }

  #ensureBinding(topicId: string, agentId: string | undefined): void {
    if (!agentId || this.#bindings.some(
      (binding) =>
        binding.topicId === topicId
        && binding.agentId === agentId
        && binding.status !== "closed",
    )) {
      return;
    }
    const agent = this.#findAgent(agentId);
    const provider = this.#findProvider(agent.providerId);
    const now = new Date().toISOString();
    this.#bindings.push({
      id: `binding_${crypto.randomUUID()}`,
      topicId,
      agentId,
      actorId: agent.actorId,
      providerId: provider.id,
      transportKind: provider.protocol === "claude-cli"
        ? "claude-resume"
        : provider.protocol === "codex-cli"
          ? "codex-resume"
          : provider.protocol === "acp"
            ? "acp"
            : "openai-tool-loop",
      status: "idle",
      hasSession: false,
      stateVersion: 1,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    this.#syncVisibleBindings();
  }

  #findProvider(providerId: string): ProviderProfile {
    const provider = this.#modelRouter.providers.find(
      (candidate) => candidate.id === providerId,
    );
    if (!provider) throw new Error("Provider 不存在");
    return provider;
  }

  #findAgent(agentId: string): AgentDefinition {
    const agent = this.#modelRouter.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error("Agent 不存在");
    return agent;
  }

  #advance(run: OrchestrationRun): void {
    run.version += 1;
    run.updatedAt = new Date().toISOString();
  }

  #publish(): OrchestrationSnapshot {
    this.#syncVisibleRuns();
    this.#syncVisibleBindings();
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

  #syncVisibleBindings(): void {
    const topicId = this.#snapshot.activeTopicId;
    this.#snapshot.runtimeBindings = topicId
      ? this.#bindings.filter((binding) => binding.topicId === topicId)
      : [];
  }
}
