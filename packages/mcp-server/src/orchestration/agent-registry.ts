/**
 * @input  依赖：SQLiteCouncilStore（Actor 别名解析）、CouncilOrchestrator（适配器注册与绑定修订）、
 *         模型路由服务与回退路由仓库、Agent 临时工厂、HTTP 编排默认策略配置
 * @output 导出：AgentRegistry —— 静态/动态 Agent 名册、按 TTL 复检的可用性缓存、Runtime 能力冻结快照、
 *         capabilities 公开视图；以及注册类型、AVAILABILITY_TTL_MS 与 Provider 协议到传输类型的映射
 * @pos    编排服务的 Agent 注册与可用性单一真源；不创建 Run、不直接关闭持久会话（关闭经产品服务回调）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createHash } from "node:crypto";
import {
  type CouncilOrchestrator,
  OrchestrationConfigError,
  type SQLiteCouncilStore,
  type AgentAdapter,
  declaredCapabilitiesForTransport,
  defaultPolicyCapabilitiesForTransport,
  grantRuntimeCapabilities,
  type RuntimeCapabilityKey,
  type RuntimeCapabilitySnapshot,
  type RuntimeTransportKind,
} from "council-orchestrator";
import type { ModelRouterService } from "../model-router-service.js";
import type {
  AgentDefinition,
  ModelRouterStore,
  ProviderProfile,
} from "../model-router-store.js";
import type { CouncilHttpConfig } from "../types.js";

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
  runtimeCapabilities?: readonly RuntimeCapabilityKey[];
}

export type EphemeralAgentFactory = (
  agent: AgentDefinition,
  provider: ProviderProfile,
) => EphemeralAgentBinding;

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
  permissionProfile?: AgentDefinition["permissionProfile"];
  executionRole?: AgentDefinition["executionRole"];
  brand?: {
    glyphId: string;
    colorToken: string;
    displayName: string;
  };
}

/** 可用性检测缓存时长：CLI 登录状态变化最迟这么久反映到 capabilities，无需重启服务。 */
export const AVAILABILITY_TTL_MS = 30_000;

export function transportKindForProtocol(
  protocol: ProviderProfile["protocol"],
): RuntimeTransportKind {
  return protocol === "claude-cli"
    ? "claude-resume"
    : protocol === "codex-cli"
      ? "codex-resume"
      : protocol === "acp"
        ? "acp"
        : "openai-tool-loop";
}

export interface AgentRegistryDependencies {
  store: SQLiteCouncilStore;
  registrations: readonly RegisteredAgentAdapter[];
  config: CouncilHttpConfig;
  modelRouter?: ModelRouterService;
  fallbackRouterStore?: ModelRouterStore;
  ephemeralAgentFactory?: EphemeralAgentFactory;
  /**
   * 编排器在注册表之后构造：注册重复必须在打开其余 SQLite 句柄之前抛出，
   * 而编排器自身也会校验重复并给出不同文案，所以这里只能延迟取用。
   */
  orchestrator: () => CouncilOrchestrator;
  /** 关闭持久会话的实现在产品服务里；动态 Agent 配置变更或下线时经此回调。 */
  closeRuntimeBinding: (bindingId: string, reason: string) => Promise<unknown>;
}

export class AgentRegistry {
  readonly #store: SQLiteCouncilStore;
  readonly #config: CouncilHttpConfig;
  readonly #modelRouter: ModelRouterService | undefined;
  readonly #fallbackRouterStore: ModelRouterStore | undefined;
  readonly #ephemeralAgentFactory: EphemeralAgentFactory | undefined;
  readonly #orchestrator: () => CouncilOrchestrator;
  readonly #closeRuntimeBinding: (bindingId: string, reason: string) => Promise<unknown>;
  readonly #actors = new Map<string, string>();
  readonly #agentAdapters = new Map<string, AgentAdapter>();
  readonly #capabilities: PublicAgentCapability[] = [];
  readonly #availabilityChecks = new Map<string, () => Promise<boolean>>();
  readonly #unavailableLimitations = new Map<string, string>();
  readonly #baseLimitations = new Map<string, string | undefined>();
  readonly #staticAdapterIds = new Set<string>();
  readonly #dynamicAdapterFingerprints = new Map<string, string>();
  readonly #runtimeCapabilityOverrides = new Map<string, readonly RuntimeCapabilityKey[]>();
  #availabilityCheckedAt = 0;
  #availabilityRefresh: Promise<void> | null = null;

  constructor(dependencies: AgentRegistryDependencies) {
    this.#store = dependencies.store;
    this.#config = dependencies.config;
    this.#modelRouter = dependencies.modelRouter;
    this.#fallbackRouterStore = dependencies.fallbackRouterStore;
    this.#ephemeralAgentFactory = dependencies.ephemeralAgentFactory;
    this.#orchestrator = dependencies.orchestrator;
    this.#closeRuntimeBinding = dependencies.closeRuntimeBinding;
    for (const registration of dependencies.registrations) {
      if (this.#actors.has(registration.adapter.adapterId)) {
        this.#store.close();
        throw new Error("编排 Agent 注册重复。");
      }
      const actorId = this.#store.resolveActorAlias(registration.actorAlias);
      this.#actors.set(registration.adapter.adapterId, actorId);
      this.#agentAdapters.set(registration.adapter.adapterId, registration.adapter);
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
  }

  // ---- 名册查询 ----

  /** 适配器绑定的 Actor；未注册返回 undefined。 */
  actorId(adapterId: string): string | undefined {
    return this.#actors.get(adapterId);
  }

  hasAdapter(adapterId: string): boolean {
    return this.#actors.has(adapterId);
  }

  /** 当前全部已注册适配器 id（静态 + 动态），供 Run 策略的 allowedAgents 使用。 */
  adapterIds(): string[] {
    return [...this.#actors.keys()];
  }

  adapter(adapterId: string): AgentAdapter | undefined {
    return this.#agentAdapters.get(adapterId);
  }

  /** 返回公开能力的活对象：可用性与 Runtime 能力会随刷新/冻结就地更新，调用方只读。 */
  capability(adapterId: string): PublicAgentCapability | undefined {
    return this.#capabilities.find((capability) => capability.id === adapterId);
  }

  /** 配置面变更后让 TTL 缓存立即失效，下一次非强制刷新也会重新检测。 */
  invalidateAvailability(): void {
    this.#availabilityCheckedAt = 0;
  }

  // ---- 公开视图 ----

  capabilities(): object {
    return {
      adapters: this.#capabilities.map((capability) => ({ ...capability })),
      defaultPolicy: {
        maxRounds: this.#config.orchestrationDefaultMaxRounds,
        agentIdleTimeoutMs: this.#config.orchestrationDefaultAgentIdleTimeoutMs,
        agentTimeoutMs: this.#config.orchestrationDefaultAgentTimeoutMs,
        maxAttemptsPerRound: this.#config.orchestrationDefaultMaxAttempts,
        maxManualRecoveries: this.#config.orchestrationDefaultMaxRecoveries,
        confirmation: {
          beforeRounds: [],
          beforeCompletion: this.#config.orchestrationConfirmCompletion,
        },
      },
      limitations: [
        "Claude/Codex 通过议题级逻辑绑定恢复 session；兼容远程 Provider 保持无状态。",
        "只有已注册的后台适配器可以自动执行。",
      ],
    };
  }

  /** 返回 capabilities 前按 TTL 重新检测可用性，让 CLI 登录状态变化无需重启即可生效。 */
  async capabilitiesFresh(): Promise<object> {
    await this.syncDynamicAgents();
    await this.ensureFreshAvailability();
    return this.capabilities();
  }

  // ---- Runtime 能力冻结 ----

  freezeRuntimeCapabilities(adapterId: string): RuntimeCapabilitySnapshot {
    const actorId = this.#actors.get(adapterId);
    const agent =
      this.#modelRouter?.getAgent(adapterId)
      ?? this.#fallbackRouterStore?.getAgent(adapterId)
      ?? (actorId ? this.#fallbackRouterStore?.getAgent(actorId) : undefined);
    const provider = agent
      ? this.#modelRouter?.getProvider(agent.providerId)
        ?? this.#fallbackRouterStore?.getProvider(agent.providerId)
      : undefined;
    const bindingRevision = this.#orchestrator().adapterBindingRevision(adapterId);
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

  // ---- 可用性刷新 ----

  async ensureFreshAvailability(force = false): Promise<void> {
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

  // ---- 动态 Agent 同步 ----

  async syncDynamicAgents(): Promise<void> {
    if (!this.#modelRouter || !this.#ephemeralAgentFactory) {
      return;
    }
    const snapshot = await this.#modelRouter.snapshot();
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
          permissionProfile: agent.permissionProfile,
          executionRole: agent.executionRole,
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
        if (this.#dynamicAdapterFingerprints.has(agent.id)) {
          await this.#closeAgentRuntimeBindings(agent.id, "configuration-changed");
        }
        binding = this.#ephemeralAgentFactory(agent, provider);
        this.#orchestrator().upsertAdapter(binding.adapter, fingerprint);
        this.#agentAdapters.set(agent.id, binding.adapter);
        this.#dynamicAdapterFingerprints.set(agent.id, fingerprint);
        if (binding.runtimeCapabilities) {
          this.#runtimeCapabilityOverrides.set(
            agent.id,
            binding.runtimeCapabilities,
          );
        } else {
          this.#runtimeCapabilityOverrides.delete(agent.id);
        }
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
        permissionProfile: agent.permissionProfile,
        executionRole: agent.executionRole,
        runtimeCapabilities: grantRuntimeCapabilities(
          this.#runtimeCapabilityOverrides.get(agent.id)
            ?? declaredCapabilitiesForTransport(transportKindForProtocol(provider.protocol)),
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
      await this.#closeAgentRuntimeBindings(capability.id, "configuration-changed");
      this.#capabilities.splice(this.#capabilities.indexOf(capability), 1);
      this.#orchestrator().removeAdapter(capability.id);
      this.#agentAdapters.delete(capability.id);
      this.#actors.delete(capability.id);
      this.#dynamicAdapterFingerprints.delete(capability.id);
      this.#availabilityChecks.delete(capability.id);
      this.#baseLimitations.delete(capability.id);
      this.#unavailableLimitations.delete(capability.id);
      this.#runtimeCapabilityOverrides.delete(capability.id);
    }
  }

  async #closeAgentRuntimeBindings(agentId: string, reason: string): Promise<void> {
    const bindings = await this.#store.listOpenRuntimeBindings();
    for (const binding of bindings) {
      if (binding.agentId === agentId) {
        await this.#closeRuntimeBinding(binding.id, reason);
      }
    }
  }
}
