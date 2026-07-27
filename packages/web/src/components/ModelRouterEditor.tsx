/**
 * @input  依赖：Model Router 的 Agent/Provider/Brand、编辑草稿与保存测试回调
 * @output 导出：AgentDefinitionEditor、锁定系统身份的 ProviderProfileEditor 和两类草稿
 * @pos    模型路由台右侧单项编辑器；Provider 连接、受控品牌与 Agent 身份/模型职责分离
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  AtSign,
  Bot,
  KeyRound,
  LoaderCircle,
  Plus,
  Save,
  ShieldCheck,
  TestTube2,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentDefinition,
  BrandAsset,
  ProviderCatalogEntry,
  ProviderProfile,
} from "../types/model-router";
import { BrandGlyph } from "./BrandGlyph";

export interface AgentDefinitionDraft {
  displayName: string;
  slug: string;
  model: string;
  mentionAlias: string;
  enabled: boolean;
}

export interface ProviderProfileDraft {
  displayName: string;
  slug: string;
  baseUrl: string;
  brandAssetId: string;
  active: boolean;
  apiKey: string;
  clearApiKey: boolean;
}

interface CommonEditorProps {
  brand?: BrandAsset;
  busyAction: "save" | "test" | "remove" | null;
  isDirty: boolean;
  removeConfirming: boolean;
  onCancel: () => void;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

interface AgentDefinitionEditorProps extends CommonEditorProps {
  agent?: AgentDefinition;
  provider: ProviderProfile;
  draft: AgentDefinitionDraft;
  isAdding: boolean;
  identityLocked: boolean;
  removable: boolean;
  onDraftChange: (patch: Partial<AgentDefinitionDraft>) => void;
  onSave: () => void;
  onTest: () => void;
}

interface ProviderProfileEditorProps extends CommonEditorProps {
  provider?: ProviderProfile;
  template?: ProviderCatalogEntry;
  draft: ProviderProfileDraft;
  isAdding: boolean;
  identityLocked: boolean;
  removable: boolean;
  onDraftChange: (patch: Partial<ProviderProfileDraft>) => void;
  onSave: () => void;
  onAddAgent: () => void;
}

function EditorHeader({
  brand,
  title,
  subtitle,
  isAdding,
  active,
  onActiveChange,
}: {
  brand?: BrandAsset;
  title: string;
  subtitle: string;
  isAdding: boolean;
  active: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  return (
    <header className="model-router-editor-head">
      <span className="model-router-editor-icon"><BrandGlyph brand={brand} size={22} /></span>
      <span className="model-router-editor-title">
        <span><strong>{title}</strong>{isAdding ? <em>NEW</em> : null}</span>
        <small>{subtitle}</small>
      </span>
      <label className="setting-switch">
        <input
          type="checkbox"
          checked={active}
          aria-label={active ? `停用 ${title}` : `启用 ${title}`}
          onChange={(event) => onActiveChange(event.target.checked)}
        />
        <span aria-hidden="true" />
        <em>{active ? "启用" : "停用"}</em>
      </label>
    </header>
  );
}

function RemoveConfirm({
  label,
  busy,
  onCancel,
  onRemove,
}: {
  label: string;
  busy: boolean;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="model-router-remove-confirm" role="alert">
      <span><Trash2 size={16} />将移除 {label}。进行中的调用不会被静默切换。</span>
      <div>
        <button className="secondary-button compact-button" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="danger-button compact-button" type="button" disabled={busy} onClick={onRemove}>
          {busy ? <LoaderCircle className="spinner" size={15} /> : <Trash2 size={15} />}确认移除
        </button>
      </div>
    </div>
  );
}

export function AgentDefinitionEditor({
  agent,
  provider,
  brand,
  draft,
  busyAction,
  isAdding,
  isDirty,
  identityLocked,
  removable,
  removeConfirming,
  onDraftChange,
  onSave,
  onTest,
  onCancel,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: AgentDefinitionEditorProps) {
  const isBusy = busyAction !== null;
  const modelOptional = provider.protocol === "codex-cli";
  return (
    <article className="model-router-editor">
      <EditorHeader
        brand={brand}
        title={isAdding ? `添加 ${provider.displayName} Agent` : agent?.displayName ?? "新 Agent"}
        subtitle={`${provider.displayName} · @${draft.mentionAlias || "alias"}`}
        isAdding={isAdding}
        active={draft.enabled}
        onActiveChange={(enabled) => onDraftChange({ enabled })}
      />
      <div className="model-router-editor-fields">
        <div className="model-router-field-grid">
          <label>
            <span>Agent 名称</span>
            <small>显示在消息卡和能力列表中的名称</small>
            <input
              value={draft.displayName}
              disabled={identityLocked}
              aria-readonly={identityLocked}
              onChange={(event) => onDraftChange({ displayName: event.target.value })}
            />
          </label>
          {isAdding ? (
            <label>
              <span>Agent slug</span>
              <small>稳定内部标识，创建后不再变化</small>
              <input value={draft.slug} spellCheck={false} onChange={(event) => onDraftChange({ slug: event.target.value })} />
            </label>
          ) : null}
        </div>
        <label>
          <span>模型 ID</span>
          <small>{modelOptional ? "可以留空并跟随 Codex CLI 默认模型" : "使用该供应商公布的精确模型标识"}</small>
          <input
            value={draft.model}
            placeholder={modelOptional ? "留空使用 CLI 默认模型" : "provider-model-id"}
            spellCheck={false}
            onChange={(event) => onDraftChange({ model: event.target.value })}
          />
        </label>
        <label>
          <span>召唤别名</span>
          <small>Composer 中直接使用；每个 Agent 必须唯一</small>
          <div className="secret-input-shell">
            <AtSign size={16} />
            <input
              value={draft.mentionAlias}
              disabled={identityLocked}
              aria-readonly={identityLocked}
              placeholder="agent-name"
              spellCheck={false}
              onChange={(event) => onDraftChange({ mentionAlias: event.target.value.replace(/^@/u, "") })}
            />
          </div>
        </label>
      </div>
      {removeConfirming ? (
        <RemoveConfirm
          label={agent?.displayName ?? draft.displayName}
          busy={busyAction === "remove"}
          onCancel={onCancelRemove}
          onRemove={onRemove}
        />
      ) : null}
      <footer className="model-router-editor-foot">
        <span className="credential-state is-ready"><Bot size={14} />Actor 独立 · @{draft.mentionAlias || "alias"}</span>
        <div className="model-router-editor-actions">
          {isAdding ? (
            <button className="secondary-button compact-button" type="button" disabled={isBusy} onClick={onCancel}>
              <X size={15} />取消
            </button>
          ) : removable ? (
            <button className="text-danger-button compact-button" type="button" disabled={isBusy} onClick={onRequestRemove}>
              <Trash2 size={15} />移除 Agent
            </button>
          ) : null}
          {!isAdding ? (
            <button className="secondary-button compact-button" type="button" disabled={isBusy || isDirty} onClick={onTest}>
              {busyAction === "test" ? <LoaderCircle className="spinner" size={15} /> : <TestTube2 size={15} />}测试
            </button>
          ) : null}
          <button className="primary-button compact-button" type="button" disabled={isBusy || !isDirty} onClick={onSave}>
            {busyAction === "save" ? <LoaderCircle className="spinner" size={15} /> : <Save size={15} />}
            {isAdding ? "添加 Agent" : "保存 Agent"}
          </button>
        </div>
      </footer>
    </article>
  );
}

export function ProviderProfileEditor({
  provider,
  template,
  brand,
  draft,
  busyAction,
  isAdding,
  isDirty,
  identityLocked,
  removable,
  removeConfirming,
  onDraftChange,
  onSave,
  onAddAgent,
  onCancel,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: ProviderProfileEditorProps) {
  const isBusy = busyAction !== null;
  const requiresKey = provider?.requiresApiKey ?? template?.requiresApiKey ?? false;
  const hasApiKey = provider?.hasApiKey ?? false;
  const protocol = provider?.protocol ?? template?.protocol ?? "openai-compatible";
  const credentialReady = !requiresKey || hasApiKey || Boolean(draft.apiKey);
  const title = isAdding ? `连接 ${template?.displayName ?? "Provider"}` : provider?.displayName ?? "Provider";
  return (
    <article className="model-router-editor">
      <EditorHeader
        brand={brand}
        title={title}
        subtitle={protocol === "openai-compatible"
          ? "OpenAI 兼容 API 连接"
          : protocol === "acp"
            ? "本机 ACP Agent 连接"
            : "本机 CLI 连接"}
        isAdding={isAdding}
        active={draft.active}
        onActiveChange={(active) => onDraftChange({ active })}
      />
      <div className="model-router-editor-fields">
        <div className="model-router-field-grid">
          <label>
            <span>Provider 名称</span>
            <small>供应商名称保持原名，不退化为 Other</small>
            <input
              value={draft.displayName}
              disabled={identityLocked}
              aria-readonly={identityLocked}
              onChange={(event) => onDraftChange({ displayName: event.target.value })}
            />
          </label>
          {isAdding ? (
            <label>
              <span>Provider slug</span>
              <small>稳定连接标识</small>
              <input
                value={draft.slug}
                disabled={identityLocked}
                aria-readonly={identityLocked}
                spellCheck={false}
                onChange={(event) => onDraftChange({ slug: event.target.value })}
              />
            </label>
          ) : null}
        </div>
        {protocol === "openai-compatible" ? (
          <>
            <label>
              <span>API Base URL</span>
              <small>兼容 Chat Completions 的 HTTPS 地址；本地模型可用 loopback HTTP</small>
              <input value={draft.baseUrl} spellCheck={false} onChange={(event) => onDraftChange({ baseUrl: event.target.value })} />
            </label>
            <label>
              <span>API Key</span>
              <small>只进入系统 Keychain，设置 API 永不回显</small>
              <div className="secret-input-shell">
                <KeyRound size={16} />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  disabled={draft.clearApiKey}
                  placeholder={hasApiKey ? "已保存；留空保持不变" : "输入 Provider API Key"}
                  onChange={(event) => onDraftChange({ apiKey: event.target.value })}
                />
              </div>
            </label>
            {hasApiKey ? (
              <label className="clear-secret-row">
                <input
                  type="checkbox"
                  checked={draft.clearApiKey}
                  onChange={(event) => onDraftChange({ clearApiKey: event.target.checked, apiKey: "" })}
                />
                清除已保存的 API Key
              </label>
            ) : null}
          </>
        ) : null}
      </div>
      {removeConfirming ? (
        <RemoveConfirm
          label={provider?.displayName ?? draft.displayName}
          busy={busyAction === "remove"}
          onCancel={onCancelRemove}
          onRemove={onRemove}
        />
      ) : null}
      <footer className="model-router-editor-foot">
        <span className={`credential-state ${credentialReady ? "is-ready" : ""}`}>
          <ShieldCheck size={14} />
          {requiresKey ? (hasApiKey ? "Keychain 已保存" : "需要 API Key") : "使用本机登录"}
        </span>
        <div className="model-router-editor-actions">
          {isAdding ? (
            <button className="secondary-button compact-button" type="button" disabled={isBusy} onClick={onCancel}>
              <X size={15} />取消
            </button>
          ) : (
            <>
              {removable ? (
                <button className="text-danger-button compact-button" type="button" disabled={isBusy} onClick={onRequestRemove}>
                  <Trash2 size={15} />移除连接
                </button>
              ) : null}
              <button className="secondary-button compact-button" type="button" disabled={isBusy} onClick={onAddAgent}>
                <Plus size={15} />添加 Agent
              </button>
            </>
          )}
          <button className="primary-button compact-button" type="button" disabled={isBusy || !isDirty} onClick={onSave}>
            {busyAction === "save" ? <LoaderCircle className="spinner" size={15} /> : <Save size={15} />}
            {isAdding ? "连接 Provider" : "保存连接"}
          </button>
        </div>
      </footer>
    </article>
  );
}
