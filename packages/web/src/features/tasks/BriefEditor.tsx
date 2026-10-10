/**
 * @input  依赖：界面语言、受控的 BriefDraft 与变更回调、外部传入的校验问题；brief-form 的双模式转换
 * @output 导出：BriefEditor —— council-brief 编辑器：表单（类型、目标、交付物 id/描述/尺寸/透明/数量、配色、风格约束、验收条目）
 *         与 JSON 直接编辑两种模式；BRIEF_KIND_LABELS 简报类型文案表；BriefIssueList 问题列表
 * @pos    任务详情的「编辑简报」与新建任务对话框共用；只负责编辑，保存/提交按钮由调用方提供；
 *         输入上限取自 data/tasks/council-brief 的 BRIEF_LIMITS（与服务端 brief-protocol 对齐）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { BRIEF_LIMITS, type BriefIssue } from "../../data/tasks/council-brief";
import { useI18n } from "../../i18n/I18nProvider";
import { COUNCIL_BRIEF_KINDS, type CouncilBriefKind } from "../../types/assets";
import {
  briefDraftFromJson,
  briefDraftToJson,
  emptyDeliverable,
  type BriefDeliverableDraft,
  type BriefDraft,
} from "./brief-form";

export const BRIEF_KIND_LABELS: Record<CouncilBriefKind, string> = {
  "app-mockup": "应用界面稿",
  "game-sprite": "游戏精灵图",
  "game-tileset": "游戏图块集",
  "concept-sheet": "概念设定稿",
  "icon-set": "图标组",
  custom: "自定义",
};

export function BriefIssueList({ issues }: { issues: BriefIssue[] }) {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <ul className="task-notice is-danger brief-issues" role="alert">
      {issues.map((issue, index) => <li key={index}>{t(issue.message, issue.params)}</li>)}
    </ul>
  );
}

export interface BriefEditorProps {
  draft: BriefDraft;
  onChange: (draft: BriefDraft) => void;
  /** 调用方提交时的校验结果；模式切换失败的问题由编辑器自己展示。 */
  issues?: BriefIssue[];
  disabled?: boolean;
}

export function BriefEditor({ draft, onChange, issues = [], disabled = false }: BriefEditorProps) {
  const { t } = useI18n();
  const [switchIssues, setSwitchIssues] = useState<BriefIssue[]>([]);
  const { form } = draft;

  function setForm(patch: Partial<BriefDraft["form"]>) {
    onChange({ ...draft, form: { ...form, ...patch } });
  }

  function setDeliverable(index: number, patch: Partial<BriefDeliverableDraft>) {
    setForm({ deliverables: form.deliverables.map((entry, at) => at === index ? { ...entry, ...patch } : entry) });
  }

  function switchMode(mode: BriefDraft["mode"]) {
    if (mode === draft.mode) return;
    if (mode === "json") {
      setSwitchIssues([]);
      onChange(briefDraftToJson(draft));
      return;
    }
    const result = briefDraftFromJson(draft);
    setSwitchIssues(result.issues);
    if (result.issues.length === 0) onChange(result.draft);
  }

  return (
    <div className="brief-editor">
      <div className="brief-editor-modes" role="group" aria-label={t("简报编辑方式")}>
        <button type="button" aria-pressed={draft.mode === "form"} disabled={disabled} onClick={() => switchMode("form")}>{t("表单")}</button>
        <button type="button" aria-pressed={draft.mode === "json"} disabled={disabled} onClick={() => switchMode("json")}>JSON</button>
      </div>

      {draft.mode === "json" ? (
        <label>
          <span>{t("council-brief JSON")}</span>
          <textarea
            className="brief-json"
            aria-label={t("council-brief JSON")}
            spellCheck={false}
            disabled={disabled}
            value={draft.json}
            onChange={(event) => { setSwitchIssues([]); onChange({ ...draft, json: event.target.value }); }}
          />
        </label>
      ) : (
        <>
          <label>
            <span>{t("简报类型")}</span>
            <select value={form.kind} disabled={disabled} onChange={(event) => setForm({ kind: event.target.value as CouncilBriefKind })}>
              {COUNCIL_BRIEF_KINDS.map((kind) => <option key={kind} value={kind}>{t(BRIEF_KIND_LABELS[kind])}</option>)}
            </select>
          </label>
          <label>
            <span>{t("目标")}</span>
            <input
              value={form.goal}
              maxLength={BRIEF_LIMITS.maxShortText}
              disabled={disabled}
              placeholder={t("一句话说明这批图要解决什么")}
              onChange={(event) => setForm({ goal: event.target.value })}
            />
          </label>
          <fieldset>
            <legend>{t("交付物")}</legend>
            {form.deliverables.map((entry, index) => (
              <div className="brief-deliverable" key={index}>
                <label>
                  <span>id</span>
                  <input value={entry.id} maxLength={BRIEF_LIMITS.maxDeliverableIdLength} disabled={disabled} onChange={(event) => setDeliverable(index, { id: event.target.value })} />
                </label>
                <label>
                  <span>{t("描述")}</span>
                  <input value={entry.description} maxLength={BRIEF_LIMITS.maxLongText} disabled={disabled} onChange={(event) => setDeliverable(index, { description: event.target.value })} />
                </label>
                <label>
                  <span>{t("尺寸")}</span>
                  <input value={entry.size} disabled={disabled} placeholder="1024x1024" onChange={(event) => setDeliverable(index, { size: event.target.value })} />
                </label>
                <label>
                  <span>{t("数量")}</span>
                  <input value={entry.count} disabled={disabled} inputMode="numeric" placeholder="1" onChange={(event) => setDeliverable(index, { count: event.target.value })} />
                </label>
                <label className="brief-checkbox">
                  <input type="checkbox" checked={entry.transparent} disabled={disabled} onChange={(event) => setDeliverable(index, { transparent: event.target.checked })} />
                  <span>{t("透明背景")}</span>
                </label>
                <button
                  type="button"
                  className="brief-row-button"
                  aria-label={t("移除交付物 {index}", { index: index + 1 })}
                  disabled={disabled || form.deliverables.length <= 1}
                  onClick={() => setForm({ deliverables: form.deliverables.filter((_, at) => at !== index) })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="brief-row-button"
              disabled={disabled || form.deliverables.length >= BRIEF_LIMITS.maxDeliverables}
              onClick={() => setForm({ deliverables: [...form.deliverables, emptyDeliverable(form.deliverables.length)] })}
            >
              <Plus size={12} />{t("添加交付物")}
            </button>
          </fieldset>
          <label>
            <span>{t("配色")}</span>
            <input
              value={form.palette}
              maxLength={BRIEF_LIMITS.maxShortText}
              disabled={disabled}
              placeholder={t("如 #008080、#FFFFFF 为主")}
              onChange={(event) => setForm({ palette: event.target.value })}
            />
          </label>
          <label>
            <span>{t("风格约束（每行一条）")}</span>
            <textarea rows={3} value={form.constraints} disabled={disabled} onChange={(event) => setForm({ constraints: event.target.value })} />
          </label>
          <label>
            <span>{t("验收条目（每行一条）")}</span>
            <textarea rows={3} value={form.acceptance} disabled={disabled} onChange={(event) => setForm({ acceptance: event.target.value })} />
          </label>
          {form.references?.length ? (
            <p className="task-muted">{t("保留 {count} 个参考资产引用（在 JSON 模式中编辑）。", { count: form.references.length })}</p>
          ) : null}
        </>
      )}
      <BriefIssueList issues={switchIssues.length > 0 ? switchIssues : issues} />
    </div>
  );
}
