/**
 * @input  依赖：单个公开 Agent 设置、编辑草稿与保存/测试回调
 * @output 导出：本机或远程 Provider 的独立设置卡片
 * @pos    AgentSettingsDialog 的可复用展示单元，隔离字段、凭据状态和操作按钮
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
} from "lucide-react";
import type { AgentSetting } from "../types/agent-settings";

export interface AgentSettingCardDraft {
  model: string;
  baseUrl: string;
  enabled: boolean;
  apiKey: string;
  clearApiKey: boolean;
}

interface AgentSettingCardProps {
  setting: AgentSetting;
  draft: AgentSettingCardDraft;
  busyAction: "save" | "test" | null;
  onDraftChange: (patch: Partial<AgentSettingCardDraft>) => void;
  onSave: () => void;
  onTest: () => void;
}

function kindLabel(setting: AgentSetting): string {
  if (setting.kind === "claude-cli") {
    return "本机 Claude CLI";
  }
  if (setting.kind === "codex-cli") {
    return "本机 Codex CLI";
  }
  return "OpenAI 兼容 API";
}

function ProviderIcon({ setting }: { setting: AgentSetting }) {
  return setting.kind === "openai-compatible" ? <Cloud size={20} /> : <TerminalSquare size={20} />;
}

export function AgentSettingCard({
  setting,
  draft,
  busyAction,
  onDraftChange,
  onSave,
  onTest,
}: AgentSettingCardProps) {
  const isRemote = setting.kind === "openai-compatible";
  const isBusy = busyAction !== null;
  return (
    <article className={`agent-setting-card ${draft.enabled ? "is-enabled" : ""}`}>
      <div className="agent-setting-card-head">
        <span className="agent-setting-icon"><ProviderIcon setting={setting} /></span>
        <span>
          <strong>{setting.label}</strong>
          <small>{kindLabel(setting)}</small>
        </span>
        <label className="setting-switch">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onDraftChange({ enabled: event.target.checked })}
          />
          <span aria-hidden="true" />
          <em>{draft.enabled ? "启用" : "停用"}</em>
        </label>
      </div>

      <div className="agent-setting-fields">
        <label>
          <span>模型 ID</span>
          <input
            value={draft.model}
            placeholder={setting.kind === "codex-cli" ? "留空使用 CLI 默认模型" : "填写 Provider 公布的模型 ID"}
            onChange={(event) => onDraftChange({ model: event.target.value })}
            spellCheck={false}
          />
        </label>
        {isRemote ? (
          <>
            <label>
              <span>API Base URL</span>
              <input
                value={draft.baseUrl}
                placeholder="填写兼容 API 的 Base URL（通常以 /v1 结尾）"
                onChange={(event) => onDraftChange({ baseUrl: event.target.value })}
                spellCheck={false}
              />
            </label>
            <label>
              <span>API Key</span>
              <div className="secret-input-shell">
                <KeyRound size={16} />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  disabled={draft.clearApiKey}
                  placeholder={setting.hasApiKey ? "已保存在系统 Keychain；留空保持不变" : "输入后保存到系统 Keychain"}
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

      <div className="agent-setting-card-foot">
        <span className={`credential-state ${!setting.requiresApiKey || setting.hasApiKey ? "is-ready" : ""}`}>
          {!setting.requiresApiKey ? <Bot size={14} /> : <ShieldCheck size={14} />}
          {!setting.requiresApiKey
            ? "使用本机登录"
            : setting.hasApiKey
              ? "Keychain 已保存"
              : "尚未保存 API Key"}
        </span>
        <div>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={isBusy}
            onClick={onTest}
          >
            {busyAction === "test" ? <LoaderCircle className="spinner" size={15} /> : <TestTube2 size={15} />}
            测试
          </button>
          <button
            className="primary-button compact-button"
            type="button"
            disabled={isBusy}
            onClick={onSave}
          >
            {busyAction === "save" ? <LoaderCircle className="spinner" size={15} /> : <Save size={15} />}
            保存
          </button>
        </div>
      </div>
    </article>
  );
}
