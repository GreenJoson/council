/**
 * @input  依赖：OrchestrationRepository 的 ModelRouter CRUD、BrandGlyph 与单项编辑器
 * @output 导出：ModelRouterDialog 固定高度模型路由台与系统/模板身份判定
 * @pos    Council 桌面/Web 的 Provider 连接、受控品牌身份、Agent 模型和 @alias 管理入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Bot,
  Check,
  ChevronRight,
  Cloud,
  LoaderCircle,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import type {
  AgentDefinition,
  BrandAsset,
  ModelRouterSnapshot,
  ProviderCatalogEntry,
  ProviderProfile,
} from "../types/model-router";
import { BrandGlyph } from "./BrandGlyph";
import {
  AgentDefinitionEditor,
  type AgentDefinitionDraft,
  ProviderProfileEditor,
  type ProviderProfileDraft,
} from "./ModelRouterEditor";

export interface ModelRouterDialogProps {
  isOpen: boolean;
  repository: OrchestrationRepository;
  onClose: () => void;
  onChanged: () => void;
}

type Selection =
  | { kind: "agent"; id: string }
  | { kind: "provider"; id: string }
  | { kind: "new-agent"; providerId: string }
  | { kind: "new-provider"; templateId: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "模型路由操作失败";
}

function providerProtocolLabel(protocol: ProviderCatalogEntry["protocol"]): string {
  if (protocol === "acp") {
    return "本机 ACP Agent 连接";
  }
  if (protocol === "openai-compatible") {
    return "OpenAI 兼容连接";
  }
  return "本机 CLI 连接";
}

function agentDraft(agent: AgentDefinition): AgentDefinitionDraft {
  return {
    displayName: agent.displayName,
    slug: agent.slug,
    model: agent.model,
    mentionAlias: agent.mentionAlias,
    enabled: agent.enabled,
  };
}

function providerDraft(provider: ProviderProfile): ProviderProfileDraft {
  return {
    displayName: provider.displayName,
    slug: provider.slug,
    baseUrl: provider.baseUrl ?? "",
    brandAssetId: provider.brandAssetId,
    active: provider.status === "active",
    apiKey: "",
    clearApiKey: false,
  };
}

function newAgentDraft(provider: ProviderProfile): AgentDefinitionDraft {
  const base = provider.slug.replace(/[^a-z0-9-]/gu, "");
  return {
    displayName: `${provider.displayName} Agent`,
    slug: `${base}-agent`,
    model: "",
    mentionAlias: base,
    enabled: provider.status === "active",
  };
}

function newProviderDraft(template: ProviderCatalogEntry): ProviderProfileDraft {
  return {
    displayName: template.displayName,
    slug: template.slug,
    baseUrl: template.baseUrl ?? "",
    brandAssetId: template.brandAssetId,
    active: true,
    apiKey: "",
    clearApiKey: false,
  };
}

function findBrand(snapshot: ModelRouterSnapshot, provider: ProviderProfile | undefined): BrandAsset | undefined {
  return provider
    ? snapshot.brands.find((brand) => brand.id === provider.brandAssetId)
    : undefined;
}

function sameAgentDraft(agent: AgentDefinition, draft: AgentDefinitionDraft): boolean {
  return agent.displayName === draft.displayName
    && agent.model === draft.model
    && agent.mentionAlias === draft.mentionAlias
    && agent.enabled === draft.enabled;
}

function sameProviderDraft(provider: ProviderProfile, draft: ProviderProfileDraft): boolean {
  return provider.displayName === draft.displayName
    && (provider.baseUrl ?? "") === draft.baseUrl
    && provider.brandAssetId === draft.brandAssetId
    && (provider.status === "active") === draft.active
    && !draft.apiKey
    && !draft.clearApiKey;
}

export function isSystemProviderProfile(provider: ProviderProfile): boolean {
  return provider.protocol === "claude-cli" || provider.protocol === "codex-cli";
}

export function isSystemAgentDefinition(agent: AgentDefinition): boolean {
  return agent.actorId === "claude" || agent.actorId === "codex";
}

export function isKnownProviderTemplate(
  template: ProviderCatalogEntry | undefined,
): boolean {
  return Boolean(template && template.templateId !== "custom");
}

function RouterListButton({
  title,
  detail,
  brand,
  selected,
  active,
  onClick,
}: {
  title: string;
  detail: string;
  brand?: BrandAsset;
  selected: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`model-router-list-item ${selected ? "is-selected" : ""}`}
      type="button"
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="model-router-list-icon"><BrandGlyph brand={brand} size={18} /></span>
      <span className="model-router-list-copy"><strong>{title}</strong><small>{detail}</small></span>
      <span className={`model-router-list-state ${active ? "is-enabled" : ""}`}>
        <i aria-hidden="true" />{active ? "ON" : "OFF"}
      </span>
      <ChevronRight className="model-router-list-chevron" size={15} />
    </button>
  );
}

export function ModelRouterDialog({
  isOpen,
  repository,
  onClose,
  onChanged,
}: ModelRouterDialogProps) {
  const [snapshot, setSnapshot] = useState<ModelRouterSnapshot | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [agentForm, setAgentForm] = useState<AgentDefinitionDraft | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderProfileDraft | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [removeConfirming, setRemoveConfirming] = useState(false);
  const [busyAction, setBusyAction] = useState<"save" | "test" | "remove" | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setLoading(true);
    setErrorMessage(null);
    void repository.getModelRouter()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        const first = next.agents.find((agent) => !agent.deletedAt);
        if (first) {
          setSelection({ kind: "agent", id: first.id });
          setAgentForm(agentDraft(first));
        }
      })
      .catch((error: unknown) => active && setErrorMessage(getErrorMessage(error)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [isOpen, repository]);

  const activeProviders = useMemo(
    () => snapshot?.providers.filter((provider) => provider.status !== "deleted") ?? [],
    [snapshot],
  );
  const activeAgents = useMemo(
    () => snapshot?.agents.filter((agent) => !agent.deletedAt) ?? [],
    [snapshot],
  );
  const selectedAgent = selection?.kind === "agent"
    ? activeAgents.find((agent) => agent.id === selection.id)
    : undefined;
  const selectedProvider = selection?.kind === "provider"
    ? activeProviders.find((provider) => provider.id === selection.id)
    : selection?.kind === "new-agent"
      ? activeProviders.find((provider) => provider.id === selection.providerId)
      : undefined;
  const selectedTemplate = selection?.kind === "new-provider"
    ? snapshot?.catalog.providers.find((template) => template.templateId === selection.templateId)
    : undefined;
  const agentProvider = selectedProvider ?? activeProviders.find(
    (provider) => provider.id === selectedAgent?.providerId,
  );

  if (!isOpen) return null;

  async function reload(preferred?: Selection): Promise<ModelRouterSnapshot> {
    const next = await repository.getModelRouter();
    setSnapshot(next);
    if (preferred) setSelection(preferred);
    onChanged();
    return next;
  }

  function selectAgent(agent: AgentDefinition): void {
    setSelection({ kind: "agent", id: agent.id });
    setAgentForm(agentDraft(agent));
    setProviderForm(null);
    setCatalogOpen(false);
    setRemoveConfirming(false);
    setErrorMessage(null);
    setResultMessage(null);
  }

  function selectProvider(provider: ProviderProfile): void {
    setSelection({ kind: "provider", id: provider.id });
    setProviderForm(providerDraft(provider));
    setAgentForm(null);
    setCatalogOpen(false);
    setRemoveConfirming(false);
    setErrorMessage(null);
    setResultMessage(null);
  }

  function beginProvider(template: ProviderCatalogEntry): void {
    setSelection({ kind: "new-provider", templateId: template.templateId });
    setProviderForm(newProviderDraft(template));
    setAgentForm(null);
    setCatalogOpen(false);
    setRemoveConfirming(false);
  }

  function beginAgent(provider: ProviderProfile): void {
    setSelection({ kind: "new-agent", providerId: provider.id });
    setAgentForm(newAgentDraft(provider));
    setProviderForm(null);
    setRemoveConfirming(false);
  }

  function cancelEdit(): void {
    const first = activeAgents[0];
    if (first) selectAgent(first);
    else {
      setSelection(null);
      setAgentForm(null);
      setProviderForm(null);
    }
  }

  async function saveAgent(): Promise<void> {
    if (!snapshot || !agentForm || !selectedProvider && !selectedAgent) return;
    const provider = selectedProvider
      ?? activeProviders.find((item) => item.id === selectedAgent?.providerId);
    if (!provider) return;
    setBusyAction("save");
    setErrorMessage(null);
    try {
      const saved = selection?.kind === "new-agent"
        ? await repository.createAgent({
            providerId: provider.id,
            slug: agentForm.slug,
            displayName: agentForm.displayName,
            model: agentForm.model,
            mentionAlias: agentForm.mentionAlias,
            enabled: agentForm.enabled,
          })
        : await repository.updateAgent({
            agentId: selectedAgent?.id ?? "",
            displayName: agentForm.displayName,
            model: agentForm.model,
            mentionAlias: agentForm.mentionAlias,
            enabled: agentForm.enabled,
          });
      await reload({ kind: "agent", id: saved.id });
      setAgentForm(agentDraft(saved));
      setResultMessage(`${saved.displayName} 已保存，@${saved.mentionAlias} 立即生效。`);
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveProvider(): Promise<void> {
    if (!providerForm) return;
    setBusyAction("save");
    setErrorMessage(null);
    try {
      const saved = selection?.kind === "new-provider" && selectedTemplate
        ? await repository.createProvider({
            templateId: selectedTemplate.templateId,
            slug: providerForm.slug,
            displayName: providerForm.displayName,
            ...(providerForm.baseUrl ? { baseUrl: providerForm.baseUrl } : {}),
            brandAssetId: providerForm.brandAssetId,
            ...(providerForm.apiKey ? { apiKey: providerForm.apiKey } : {}),
            active: providerForm.active,
          })
        : await repository.updateProvider({
            providerId: selectedProvider?.id ?? "",
            displayName: providerForm.displayName,
            ...(providerForm.baseUrl ? { baseUrl: providerForm.baseUrl } : {}),
            brandAssetId: providerForm.brandAssetId,
            active: providerForm.active,
            ...(providerForm.apiKey ? { apiKey: providerForm.apiKey } : {}),
            ...(providerForm.clearApiKey ? { clearApiKey: true } : {}),
          });
      await reload({ kind: "provider", id: saved.id });
      setProviderForm(providerDraft(saved));
      setResultMessage(`${saved.displayName} 连接已保存。`);
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function removeSelection(): Promise<void> {
    setBusyAction("remove");
    setErrorMessage(null);
    try {
      if (selectedAgent) {
        await repository.removeAgent(selectedAgent.id);
        setResultMessage(`${selectedAgent.displayName} 已移除。`);
      } else if (selectedProvider) {
        await repository.removeProvider(selectedProvider.id);
        setResultMessage(`${selectedProvider.displayName} 连接和 Keychain 凭据已移除。`);
      }
      const next = await reload();
      const first = next.agents.find((agent) => !agent.deletedAt);
      if (first) {
        setSelection({ kind: "agent", id: first.id });
        setAgentForm(agentDraft(first));
      } else {
        setSelection(null);
      }
      setRemoveConfirming(false);
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function testAgent(): Promise<void> {
    if (!selectedAgent) return;
    setBusyAction("test");
    setErrorMessage(null);
    try {
      const result = await repository.testAgent(selectedAgent.id);
      setResultMessage(`${selectedAgent.displayName} 连接测试通过 · ${String(result.latencyMs)} ms`);
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  const selectedBrand = snapshot
    ? selection?.kind === "new-provider"
      ? snapshot.brands.find((brand) => brand.id === selectedTemplate?.brandAssetId)
        : findBrand(snapshot, agentProvider)
    : undefined;
  const providerTemplate = selectedTemplate ?? (
    selectedProvider
      ? snapshot?.catalog.providers.find(
          (template) =>
            template.slug === selectedProvider.slug
            && template.protocol === selectedProvider.protocol,
        )
      : undefined
  );
  const agentDirty = Boolean(
    agentForm && (selection?.kind === "new-agent" || selectedAgent && !sameAgentDraft(selectedAgent, agentForm)),
  );
  const providerDirty = Boolean(
    providerForm && (
      selection?.kind === "new-provider"
      || selectedProvider && !sameProviderDraft(selectedProvider, providerForm)
    ),
  );

  return (
    <div className="dialog-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog model-router-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-router-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="model-router-header">
          <div>
            <span className="settings-kicker">MODEL ROUTER</span>
            <h2 id="model-router-title">Provider 与 Agent</h2>
            <p>Provider 管连接，Agent 管模型、身份和 @alias；同一连接可创建多个独立 Agent。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭模型路由" onClick={onClose}><X size={19} /></button>
        </header>
        <div className="model-router-body">
          {loading || !snapshot ? (
            <div className="settings-loading"><LoaderCircle className="spinner" size={22} />正在读取模型路由…</div>
          ) : (
            <>
              <aside className="model-router-nav" aria-label="Provider 与 Agent">
                <div className="model-router-nav-summary">
                  <span><strong>{String(activeAgents.length)}</strong> Agents</span>
                  <small>{String(activeProviders.length)} 个 Provider 连接</small>
                </div>
                <div className="model-router-nav-section">
                  <span className="model-router-nav-label">AGENTS</span>
                  <div className="model-router-list">
                    {activeAgents.map((agent) => {
                      const provider = activeProviders.find((item) => item.id === agent.providerId);
                      return (
                        <RouterListButton
                          key={agent.id}
                          title={agent.displayName}
                          detail={`@${agent.mentionAlias} · ${provider?.displayName ?? "未连接"}`}
                          brand={findBrand(snapshot, provider)}
                          selected={selection?.kind === "agent" && selection.id === agent.id}
                          active={agent.enabled}
                          onClick={() => selectAgent(agent)}
                        />
                      );
                    })}
                  </div>
                </div>
                <div className="model-router-nav-section">
                  <span className="model-router-nav-label">PROVIDER CONNECTIONS</span>
                  <div className="model-router-list">
                    {activeProviders.map((provider) => (
                      <RouterListButton
                        key={provider.id}
                        title={provider.displayName}
                        detail={`${activeAgents.filter((agent) => agent.providerId === provider.id).length} Agents`}
                        brand={findBrand(snapshot, provider)}
                        selected={selection?.kind === "provider" && selection.id === provider.id}
                        active={provider.status === "active"}
                        onClick={() => selectProvider(provider)}
                      />
                    ))}
                  </div>
                </div>
                <div className="agent-provider-catalog">
                  <button className="agent-provider-add-button" type="button" aria-expanded={catalogOpen} onClick={() => setCatalogOpen((open) => !open)}>
                    <Plus size={16} /><span>连接 Provider</span><em>{String(snapshot.catalog.providers.length)}</em>
                  </button>
                  {catalogOpen ? (
                    <div className="agent-provider-catalog-list">
                      <span>AVAILABLE</span>
                      {snapshot.catalog.providers.map((template) => {
                        const brand = snapshot.brands.find((item) => item.id === template.brandAssetId);
                        return (
                          <button key={template.templateId} type="button" onClick={() => beginProvider(template)}>
                            <span><BrandGlyph brand={brand} size={17} /></span>
                            <span>
                              <strong>{template.displayName}</strong>
                              <small>{providerProtocolLabel(template.protocol)}</small>
                            </span>
                            <Plus size={15} />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                <div className="model-router-security-note"><ShieldCheck size={15} /><span>API Key 只进入系统 Keychain</span></div>
              </aside>
              <main className="model-router-workbench">
                {agentForm && agentProvider ? (
                  <AgentDefinitionEditor
                    agent={selectedAgent}
                    provider={agentProvider}
                    brand={selectedBrand}
                    draft={agentForm}
                    busyAction={busyAction}
                    isAdding={selection?.kind === "new-agent"}
                    isDirty={agentDirty}
                    identityLocked={Boolean(
                      selectedAgent && isSystemAgentDefinition(selectedAgent),
                    )}
                    removable={Boolean(
                      selectedAgent && !isSystemAgentDefinition(selectedAgent),
                    )}
                    removeConfirming={removeConfirming}
                    onDraftChange={(patch) => setAgentForm((current) => current ? { ...current, ...patch } : current)}
                    onSave={() => void saveAgent()}
                    onTest={() => void testAgent()}
                    onCancel={cancelEdit}
                    onRequestRemove={() => setRemoveConfirming(true)}
                    onCancelRemove={() => setRemoveConfirming(false)}
                    onRemove={() => void removeSelection()}
                  />
                ) : providerForm && (selectedProvider || selectedTemplate) ? (
                  <ProviderProfileEditor
                    provider={selectedProvider}
                    template={providerTemplate}
                    brand={selectedBrand}
                    draft={providerForm}
                    busyAction={busyAction}
                    isAdding={selection?.kind === "new-provider"}
                    isDirty={providerDirty}
                    identityLocked={
                      isKnownProviderTemplate(providerTemplate)
                      || Boolean(
                        selectedProvider && isSystemProviderProfile(selectedProvider),
                      )
                    }
                    removable={Boolean(
                      selectedProvider && !isSystemProviderProfile(selectedProvider),
                    )}
                    removeConfirming={removeConfirming}
                    onDraftChange={(patch) => setProviderForm((current) => current ? { ...current, ...patch } : current)}
                    onSave={() => void saveProvider()}
                    onAddAgent={() => selectedProvider && beginAgent(selectedProvider)}
                    onCancel={cancelEdit}
                    onRequestRemove={() => setRemoveConfirming(true)}
                    onCancelRemove={() => setRemoveConfirming(false)}
                    onRemove={() => void removeSelection()}
                  />
                ) : (
                  <div className="model-router-empty"><Bot size={22} />选择 Agent 或 Provider 开始配置</div>
                )}
              </main>
            </>
          )}
        </div>
        {(errorMessage || resultMessage) ? (
          <footer className={`settings-result ${errorMessage ? "is-error" : "is-success"}`}>
            {errorMessage ? <X size={16} /> : <Check size={16} />}{errorMessage ?? resultMessage}
          </footer>
        ) : null}
      </section>
    </div>
  );
}
