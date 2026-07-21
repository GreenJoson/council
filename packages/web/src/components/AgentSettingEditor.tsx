/**
 * @input  依赖：当前 Agent 设置、编辑草稿、添加/移除状态与保存/测试回调
 * @output 导出：一次只编辑一个模型或 Provider 的工作台表单
 * @pos    AgentSettingsDialog 右侧唯一详情编辑器，避免列表项重复展开完整表单
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Bot,
  Cloud,
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
  TerminalSquare,
  TestTube2,
  Trash2,
  X,
} from "lucide-react";
import type { AgentSetting } from "../types/agent-settings";

export interface AgentSettingDraft {
  model: string;
  baseUrl: string;
  enabled: boolean;
  apiKey: string;
  clearApiKey: boolean;
}

interface AgentSettingEditorProps {
  setting: AgentSetting;
  draft: AgentSettingDraft;
  busyAction: "save" | "test" | "remove" | null;
  isAdding: boolean;
  isDirty: boolean;
  removeConfirming: boolean;
  onDraftChange: (patch: Partial<AgentSettingDraft>) => void;
  onSave: () => void;
  onTest: () => void;
  onCancelAdd: () => void;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

function kindLabel(setting: AgentSetting): string {
  if (setting.kind === "claude-cli") {
    return "本机 Claude CLI";
  }
  if (setting.kind === "codex-cli") {
    return "本机 Codex CLI";
  }
  return "OpenAI Chat Completions 兼容 API";
}

function ProviderIcon({ setting }: { setting: AgentSetting }) {
  return setting.kind === "openai-compatible"
    ? <Cloud size={21} />
    : <TerminalSquare size={21} />;
}

export function AgentSettingEditor({
  setting,
  draft,
  busyAction,
  isAdding,
  isDirty,
  removeConfirming,
  onDraftChange,
  onSave,
  onTest,
  onCancelAdd,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: AgentSettingEditorProps) {
  const isRemote = setting.kind === "openai-compatible";
  const isBusy = busyAction !== null;
  const credentialReady = !setting.requiresApiKey || setting.hasApiKey || Boolean(draft.apiKey);
  return (
    <article className="agent-setting-editor">
      <header className="agent-setting-editor-head">
        <span className="agent-setting-editor-icon"><ProviderIcon setting={setting} /></span>
        <span className="agent-setting-editor-title">
          <span>
            <strong>{isAdding ? `添加 ${setting.label}` : setting.label}</strong>
            {isAdding ? <em>NEW</em> : null}
          </span>
          <small>{kindLabel(setting)}</small>
        </span>
        <label className="setting-switch">
          <input
            type="checkbox"
            checked={draft.enabled}
            aria-label={`${draft.enabled ? "停用" : "启用"} ${setting.label}`}
            onChange={(event) => onDraftChange({ enabled: event.target.checked })}
          />
          <span aria-hidden="true" />
          <em>{draft.enabled ? "启用" : "停用"}</em>
        </label>
      </header>

      <div className="agent-setting-editor-fields">
        <label>
          <span>模型 ID</span>
          <small>{setting.kind === "codex-cli" ? "可以留空并跟随 Codex CLI 默认模型" : "使用 Provider 公布的精确模型标识"}</small>
          <input
            value={draft.model}
            placeholder={setting.kind === "codex-cli" ? "留空使用 CLI 默认模型" : "例如：provider-model-id"}
            onChange={(event) => onDraftChange({ model: event.target.value })}
            spellCheck={false}
          />
        </label>
        {isRemote ? (
          <>
            <label>
              <span>API Base URL</span>
              <small>兼容 Chat Completions 的 HTTPS 地址，本地模型可使用 loopback HTTP</small>
              <input
                value={draft.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => onDraftChange({ baseUrl: event.target.value })}
                spellCheck={false}
              />
            </label>
            <label>
              <span>API Key</span>
              <small>只保存到系统 Keychain，Council 不会回显已保存的密钥</small>
              <div className="secret-input-shell">
                <KeyRound size={16} />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  disabled={draft.clearApiKey}
                  placeholder={setting.hasApiKey ? "已保存；留空保持不变" : "输入 Provider API Key"}
                  onChange={(event) => onDraftChange({ apiKey: event.target.value })}
                />
              </div>
            </label>
            {setting.hasApiKey ? (
              <label className="clear-secret-row">
                <input
                  type="checkbox"
                  checked={draft.clearApiKey}
                  onChange={(event) => onDraftChange({
                    clearApiKey: event.target.checked,
                    apiKey: "",
                  })}
                />
                清除已保存的 API Key
              </label>
            ) : null}
          </>
        ) : null}
      </div>

      {removeConfirming ? (
        <div className="agent-setting-remove-confirm" role="alert">
          <span><Trash2 size={16} />将移除 {setting.label}，并清除系统 Keychain 中对应的 API Key。</span>
          <div>
            <button className="secondary-button compact-button" type="button" disabled={isBusy} onClick={onCancelRemove}>
              取消
            </button>
            <button className="danger-button compact-button" type="button" disabled={isBusy} onClick={onRemove}>
              {busyAction === "remove" ? <LoaderCircle className="spinner" size={15} /> : <Trash2 size={15} />}
              确认移除
            </button>
          </div>
        </div>
      ) : null}

      <footer className="agent-setting-editor-foot">
        <span className={`credential-state ${credentialReady ? "is-ready" : ""}`}>
          {!setting.requiresApiKey ? <Bot size={14} /> : <ShieldCheck size={14} />}
          {!setting.requiresApiKey
            ? "使用本机登录"
            : credentialReady
              ? setting.hasApiKey ? "Keychain 已保存" : "新密钥待保存"
              : "需要 API Key"}
        </span>
        <div className="agent-setting-editor-actions">
          {isAdding ? (
            <button className="secondary-button compact-button" type="button" disabled={isBusy} onClick={onCancelAdd}>
              <X size={15} />取消
            </button>
          ) : isRemote ? (
            <button className="text-danger-button compact-button" type="button" disabled={isBusy} onClick={onRequestRemove}>
              <Trash2 size={15} />移除
            </button>
          ) : null}
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={isBusy || isAdding || isDirty}
            title={isAdding || isDirty ? "请先保存当前设置" : "测试已保存的设置"}
            onClick={onTest}
          >
            {busyAction === "test" ? <LoaderCircle className="spinner" size={15} /> : <TestTube2 size={15} />}
            测试
          </button>
          <button className="primary-button compact-button" type="button" disabled={isBusy || !isDirty} onClick={onSave}>
            {busyAction === "save" ? <LoaderCircle className="spinner" size={15} /> : <Save size={15} />}
            {isAdding ? "添加" : "保存"}
          </button>
        </div>
      </footer>
    </article>
  );
}
