/**
 * @input  依赖：OrchestrationRepository、Agent 设置类型与弹窗控制回调
 * @output 导出：按需添加 Provider、紧凑模型列表与单项编辑工作台
 * @pos    Council 桌面/Web 的统一模型路由台；绝不读取或回显已保存 API Key
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Check,
  ChevronRight,
  Cloud,
  LoaderCircle,
  Plus,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import type { AgentSetting, UpdateAgentSettingInput } from "../types/agent-settings";
import { AgentSettingEditor, type AgentSettingDraft } from "./AgentSettingEditor";

export interface AgentSettingsDialogProps {
  isOpen: boolean;
  repository: OrchestrationRepository;
  onClose: () => void;
  onChanged: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "设置操作失败";
}

function draftFromSetting(setting: AgentSetting): AgentSettingDraft {
  return {
    model: setting.model,
    baseUrl: setting.baseUrl ?? "",
    enabled: setting.enabled,
    apiKey: "",
    clearApiKey: false,
  };
}

export function isAddedAgentSetting(setting: AgentSetting): boolean {
  return setting.kind !== "openai-compatible"
    || setting.enabled
    || Boolean(setting.model.trim() || setting.baseUrl?.trim() || setting.hasApiKey);
}

function draftChanged(setting: AgentSetting, draft: AgentSettingDraft): boolean {
  return setting.model !== draft.model
    || (setting.baseUrl ?? "") !== draft.baseUrl
    || setting.enabled !== draft.enabled
    || Boolean(draft.apiKey)
    || draft.clearApiKey;
}

interface SettingListButtonProps {
  setting: AgentSetting;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}

function SettingListButton({ setting, selected, disabled, onClick }: SettingListButtonProps) {
  const remote = setting.kind === "openai-compatible";
  const modelLabel = setting.model || (setting.kind === "codex-cli" ? "CLI 默认模型" : "待配置模型");
  return (
    <button
      className={`agent-setting-list-item ${selected ? "is-selected" : ""}`}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="agent-setting-list-icon">
        {remote ? <Cloud size={17} /> : <TerminalSquare size={17} />}
      </span>
      <span className="agent-setting-list-copy">
        <strong>{setting.label}</strong>
        <small>{modelLabel}</small>
      </span>
      <span className={`agent-setting-list-state ${setting.enabled ? "is-enabled" : ""}`}>
        <i aria-hidden="true" />
        {setting.enabled ? "ON" : "OFF"}
      </span>
      <ChevronRight className="agent-setting-list-chevron" size={15} />
    </button>
  );
}

export function AgentSettingsDialog({
  isOpen,
  repository,
  onClose,
  onChanged,
}: AgentSettingsDialogProps) {
  const [settings, setSettings] = useState<AgentSetting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AgentSettingDraft>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let active = true;
    setLoading(true);
    setErrorMessage(null);
    setResultMessage(null);
    setAddingId(null);
    setCatalogOpen(false);
    setRemoveConfirmId(null);
    void repository.listAgentSettings()
      .then((agents) => {
        if (!active) {
          return;
        }
        const visible = agents.filter(isAddedAgentSetting);
        setSettings(agents);
        setDrafts(Object.fromEntries(agents.map((agent) => [agent.id, draftFromSetting(agent)])));
        setSelectedId((current) => visible.some((agent) => agent.id === current)
          ? current
          : visible[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (active) {
          setErrorMessage(getErrorMessage(error));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [isOpen, repository]);

  const groups = useMemo(() => {
    const local = settings.filter((setting) => setting.kind !== "openai-compatible");
    const remote = settings.filter((setting) => setting.kind === "openai-compatible");
    return {
      local,
      addedRemote: remote.filter(isAddedAgentSetting),
      availableRemote: remote.filter((setting) => !isAddedAgentSetting(setting)),
    };
  }, [settings]);
  const selectedSetting = settings.find((setting) => setting.id === selectedId);
  const selectedDraft = selectedId ? drafts[selectedId] : undefined;
  const isBusy = busyId !== null;

  if (!isOpen) {
    return null;
  }

  function updateDraft(id: string, patch: Partial<AgentSettingDraft>): void {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id] as AgentSettingDraft, ...patch },
    }));
    setErrorMessage(null);
    setResultMessage(null);
  }

  function selectSetting(id: string): void {
    if (addingId && addingId !== id) {
      const addingSetting = settings.find((setting) => setting.id === addingId);
      if (addingSetting) {
        setDrafts((current) => ({ ...current, [addingId]: draftFromSetting(addingSetting) }));
      }
    }
    setAddingId(null);
    setCatalogOpen(false);
    setRemoveConfirmId(null);
    setSelectedId(id);
  }

  function beginAdd(setting: AgentSetting): void {
    setDrafts((current) => ({
      ...current,
      [setting.id]: { ...draftFromSetting(setting), enabled: true },
    }));
    setAddingId(setting.id);
    setSelectedId(setting.id);
    setCatalogOpen(false);
    setRemoveConfirmId(null);
    setErrorMessage(null);
    setResultMessage(null);
  }

  function cancelAdd(): void {
    if (!addingId) {
      return;
    }
    const setting = settings.find((item) => item.id === addingId);
    if (setting) {
      setDrafts((current) => ({ ...current, [addingId]: draftFromSetting(setting) }));
    }
    setAddingId(null);
    setSelectedId(groups.local[0]?.id ?? groups.addedRemote[0]?.id ?? null);
  }

  async function handleSave(setting: AgentSetting): Promise<void> {
    const draft = drafts[setting.id];
    if (!draft) {
      return;
    }
    if (
      addingId === setting.id
      && setting.kind === "openai-compatible"
      && (!draft.model.trim() || !draft.baseUrl.trim() || (!setting.hasApiKey && !draft.apiKey.trim()))
    ) {
      setErrorMessage("添加远程 Provider 前，请完整填写模型 ID、API Base URL 和 API Key。");
      return;
    }
    setBusyId(`save:${setting.id}`);
    setErrorMessage(null);
    setResultMessage(null);
    const input: UpdateAgentSettingInput = {
      agentId: setting.id,
      model: draft.model,
      ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
      enabled: draft.enabled,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      ...(draft.clearApiKey ? { clearApiKey: true } : {}),
    };
    try {
      const saved = await repository.updateAgentSetting(input);
      setSettings((current) => current.map((item) => item.id === saved.id ? saved : item));
      setDrafts((current) => ({ ...current, [saved.id]: draftFromSetting(saved) }));
      setAddingId(null);
      setResultMessage(`${saved.label} 已保存；后续新轮次立即使用 ${saved.model || "CLI 默认模型"}。`);
      onChanged();
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(setting: AgentSetting): Promise<void> {
    setBusyId(`test:${setting.id}`);
    setErrorMessage(null);
    setResultMessage(null);
    try {
      const result = await repository.testAgentSetting(setting.id);
      setResultMessage(`${setting.label} 连接测试通过 · ${String(result.latencyMs)} ms`);
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(setting: AgentSetting): Promise<void> {
    setBusyId(`remove:${setting.id}`);
    setErrorMessage(null);
    setResultMessage(null);
    try {
      const saved = await repository.updateAgentSetting({
        agentId: setting.id,
        model: "",
        enabled: false,
        ...(setting.hasApiKey ? { clearApiKey: true } : {}),
      });
      setSettings((current) => current.map((item) => item.id === saved.id ? saved : item));
      setDrafts((current) => ({ ...current, [saved.id]: draftFromSetting(saved) }));
      setRemoveConfirmId(null);
      setSelectedId(groups.local[0]?.id ?? null);
      setResultMessage(`${setting.label} 已从模型路由中移除。`);
      onChanged();
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  function renderList(setting: AgentSetting) {
    return (
      <SettingListButton
        key={setting.id}
        setting={setting}
        selected={selectedId === setting.id}
        disabled={isBusy}
        onClick={() => selectSetting(setting.id)}
      />
    );
  }

  return (
    <div className="dialog-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog agent-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="agent-settings-header">
          <div>
            <span className="settings-kicker">MODEL ROUTER</span>
            <h2 id="agent-settings-title">模型与 Provider</h2>
            <p>只添加实际参与议事的模型；一次编辑一项，列表长度不再撑高窗口。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭模型设置" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="agent-settings-body">
          {loading ? (
            <div className="settings-loading"><LoaderCircle className="spinner" size={22} />正在读取模型设置…</div>
          ) : (
            <>
              <aside className="agent-settings-nav" aria-label="已添加模型">
                <div className="agent-settings-nav-summary">
                  <span><strong>{String(groups.local.length + groups.addedRemote.length)}</strong> 已添加</span>
                  <small>{String(groups.addedRemote.filter((item) => item.enabled).length)} 个远程 Provider 在线</small>
                </div>

                <div className="agent-settings-nav-section">
                  <span className="agent-settings-nav-label">SYSTEM AGENTS</span>
                  <div className="agent-settings-list">{groups.local.map(renderList)}</div>
                </div>

                {groups.addedRemote.length > 0 ? (
                  <div className="agent-settings-nav-section">
                    <span className="agent-settings-nav-label">ADDED PROVIDERS</span>
                    <div className="agent-settings-list">{groups.addedRemote.map(renderList)}</div>
                  </div>
                ) : null}

                <div className="agent-provider-catalog">
                  <button
                    className="agent-provider-add-button"
                    type="button"
                    disabled={isBusy || groups.availableRemote.length === 0}
                    aria-expanded={catalogOpen}
                    onClick={() => setCatalogOpen((current) => !current)}
                  >
                    <Plus size={16} />
                    <span>{groups.availableRemote.length > 0 ? "添加 Provider" : "已添加全部 Provider"}</span>
                    {groups.availableRemote.length > 0 ? <em>{String(groups.availableRemote.length)}</em> : <Check size={15} />}
                  </button>
                  {catalogOpen ? (
                    <div className="agent-provider-catalog-list">
                      <span>AVAILABLE</span>
                      {groups.availableRemote.map((setting) => (
                        <button key={setting.id} type="button" onClick={() => beginAdd(setting)}>
                          <span><Cloud size={16} /></span>
                          <span><strong>{setting.label}</strong><small>兼容 Chat Completions</small></span>
                          <Plus size={15} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="agent-settings-security-note">
                  <ShieldCheck size={15} />
                  <span>API Key 只进入系统 Keychain</span>
                </div>
              </aside>

              <main className="agent-settings-workbench">
                {selectedSetting && selectedDraft ? (
                  <AgentSettingEditor
                    setting={selectedSetting}
                    draft={selectedDraft}
                    busyAction={busyId === `save:${selectedSetting.id}`
                      ? "save"
                      : busyId === `test:${selectedSetting.id}`
                        ? "test"
                        : busyId === `remove:${selectedSetting.id}`
                          ? "remove"
                          : null}
                    isAdding={addingId === selectedSetting.id}
                    isDirty={draftChanged(selectedSetting, selectedDraft)}
                    removeConfirming={removeConfirmId === selectedSetting.id}
                    onDraftChange={(patch) => updateDraft(selectedSetting.id, patch)}
                    onSave={() => void handleSave(selectedSetting)}
                    onTest={() => void handleTest(selectedSetting)}
                    onCancelAdd={cancelAdd}
                    onRequestRemove={() => setRemoveConfirmId(selectedSetting.id)}
                    onCancelRemove={() => setRemoveConfirmId(null)}
                    onRemove={() => void handleRemove(selectedSetting)}
                  />
                ) : (
                  <div className="agent-settings-empty"><Cloud size={22} />选择一个模型开始配置</div>
                )}
              </main>
            </>
          )}
        </div>

        {(errorMessage || resultMessage) ? (
          <footer className={`settings-result ${errorMessage ? "is-error" : "is-success"}`}>
            {errorMessage ? <X size={16} /> : <Check size={16} />}
            {errorMessage ?? resultMessage}
          </footer>
        ) : null}
      </section>
    </div>
  );
}
