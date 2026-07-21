/**
 * @input  依赖：OrchestrationRepository、Agent 设置类型与弹窗控制回调
 * @output 导出：模型切换、远程 Provider、Keychain 凭据和连接测试界面
 * @pos    Council 桌面/Web 的统一模型控制台；绝不读取或回显已保存 API Key
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Check,
  Cloud,
  LoaderCircle,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import type { AgentSetting, UpdateAgentSettingInput } from "../types/agent-settings";
import { AgentSettingCard, type AgentSettingCardDraft } from "./AgentSettingCard";

export interface AgentSettingsDialogProps {
  isOpen: boolean;
  repository: OrchestrationRepository;
  onClose: () => void;
  onChanged: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "设置操作失败";
}

function draftFromSetting(setting: AgentSetting): AgentSettingCardDraft {
  return {
    model: setting.model,
    baseUrl: setting.baseUrl ?? "",
    enabled: setting.enabled,
    apiKey: "",
    clearApiKey: false,
  };
}

export function AgentSettingsDialog({
  isOpen,
  repository,
  onClose,
  onChanged,
}: AgentSettingsDialogProps) {
  const [settings, setSettings] = useState<AgentSetting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AgentSettingCardDraft>>({});
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
    void repository.listAgentSettings()
      .then((agents) => {
        if (!active) {
          return;
        }
        setSettings(agents);
        setDrafts(Object.fromEntries(agents.map((agent) => [agent.id, draftFromSetting(agent)])));
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

  const grouped = useMemo(() => ({
    local: settings.filter((setting) => setting.kind !== "openai-compatible"),
    remote: settings.filter((setting) => setting.kind === "openai-compatible"),
  }), [settings]);

  if (!isOpen) {
    return null;
  }

  function updateDraft(id: string, patch: Partial<AgentSettingCardDraft>): void {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id] as AgentSettingCardDraft, ...patch },
    }));
  }

  async function handleSave(setting: AgentSetting): Promise<void> {
    const draft = drafts[setting.id];
    if (!draft) {
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

  function renderCard(setting: AgentSetting) {
    const draft = drafts[setting.id];
    if (!draft) {
      return null;
    }
    return (
      <AgentSettingCard
        key={setting.id}
        setting={setting}
        draft={draft}
        busyAction={busyId === `save:${setting.id}`
          ? "save"
          : busyId === `test:${setting.id}`
            ? "test"
            : null}
        onDraftChange={(patch) => updateDraft(setting.id, patch)}
        onSave={() => void handleSave(setting)}
        onTest={() => void handleTest(setting)}
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
            <p>新轮次读取当前设置；历史消息和 API Key 不会被复制进配置响应。</p>
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
              <section className="settings-section">
                <div className="settings-section-title">
                  <TerminalSquare size={17} />
                  <span><strong>本机 Agent</strong><small>复用 Claude Code / Codex 登录，无需 API Key</small></span>
                </div>
                <div className="agent-settings-grid">{grouped.local.map(renderCard)}</div>
              </section>
              <section className="settings-section">
                <div className="settings-section-title">
                  <Cloud size={17} />
                  <span><strong>远程 Provider</strong><small>兼容 Chat Completions；模型 ID 可自由填写，无需升级 Council</small></span>
                </div>
                <div className="agent-settings-grid">{grouped.remote.map(renderCard)}</div>
              </section>
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
