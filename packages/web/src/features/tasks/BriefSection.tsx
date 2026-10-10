/**
 * @input  依赖：界面语言、当前任务、保存回调与忙碌/错误态；data/tasks/council-brief 解析、brief-form、BriefEditor
 * @output 导出：BriefSection —— 任务详情的「简报」区：council-brief 结构化展示（目标、交付物、风格、参考资产、验收），
 *         非 council-brief 的旧简报回退为键值列表；「编辑简报」展开 BriefEditor，经 PUT /tasks/:id 的 brief 保存
 * @pos    任务详情的子区块；保存成功后收起，失败时保留草稿并显示服务端/本地校验错误
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, FilePenLine, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { buildHash } from "../../app/routes";
import { parseCouncilBrief, type BriefIssue } from "../../data/tasks/council-brief";
import { useI18n } from "../../i18n/I18nProvider";
import type { CouncilWorkItem } from "../../types/council";
import type { CouncilBrief } from "../../types/assets";
import { BRIEF_KIND_LABELS, BriefEditor } from "./BriefEditor";
import { createBriefDraft, resolveBriefDraft, type BriefDraft } from "./brief-form";

export interface BriefSectionProps {
  task: CouncilWorkItem;
  isSaving: boolean;
  disabled: boolean;
  /** 保存失败的服务端文案（已翻译前的原文）。 */
  saveError?: string;
  onSave: (brief: Record<string, unknown>) => Promise<boolean>;
}

/** 旧简报结构由来源决定，前端不解释字段：字符串原样显示，其余值序列化成紧凑 JSON。 */
function briefValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function CouncilBriefView({ brief }: { brief: CouncilBrief }) {
  const { t } = useI18n();
  return (
    <div className="brief-view">
      <p><strong>{t(BRIEF_KIND_LABELS[brief.kind])}</strong> · {brief.goal}</p>
      <h3>{t("交付物")}</h3>
      <ul>
        {brief.deliverables.map((entry) => (
          <li key={entry.id}>
            <code>{entry.id}</code> {entry.description}
            {entry.size ? ` · ${entry.size}` : ""}
            {entry.transparent ? ` · ${t("透明背景")}` : ""}
            {entry.count !== undefined ? ` · ×${String(entry.count)}` : ""}
          </li>
        ))}
      </ul>
      {brief.style.constraints?.length ? (
        <>
          <h3>{t("风格约束")}</h3>
          <ul>{brief.style.constraints.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
        </>
      ) : null}
      {brief.style.palette?.length ? (
        <p><span className="task-muted">{t("配色")}</span> {brief.style.palette.join(" · ")}</p>
      ) : null}
      {brief.style.references?.length ? (
        <>
          <h3>{t("参考资产")}</h3>
          <ul>
            {brief.style.references.map((assetId) => (
              <li key={assetId}><a href={buildHash({ view: "assets", assetId })}><code>{assetId}</code></a></li>
            ))}
          </ul>
        </>
      ) : null}
      {brief.acceptance.length > 0 ? (
        <>
          <h3>{t("验收条目")}</h3>
          <ul>{brief.acceptance.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
        </>
      ) : null}
      {brief.nextStage ? <p className="task-muted">{t("下一阶段：原型")} · {brief.nextStage.notes}</p> : null}
    </div>
  );
}

export function BriefSection({ task, isSaving, disabled, saveError, onSave }: BriefSectionProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [issues, setIssues] = useState<BriefIssue[]>([]);
  const councilBrief = task.brief ? parseCouncilBrief(task.brief) : null;
  const rawEntries = task.brief && !councilBrief ? Object.entries(task.brief) : [];

  async function save() {
    if (!draft) return;
    const result = resolveBriefDraft(draft);
    setIssues(result.issues);
    if (!result.brief) return;
    const saved = await onSave(result.brief as unknown as Record<string, unknown>);
    if (saved) setDraft(null);
  }

  return (
    <section className="task-detail-section" aria-labelledby="task-brief-heading">
      <h2 id="task-brief-heading">{t("简报")}</h2>
      {draft ? (
        <>
          {saveError ? (
            <p className="task-notice is-danger" role="alert"><AlertTriangle size={13} />{t("简报保存失败：{message}", { message: t(saveError) })}</p>
          ) : null}
          <BriefEditor draft={draft} onChange={setDraft} issues={issues} disabled={isSaving} />
          <div className="brief-editor-actions">
            <button type="button" disabled={isSaving} onClick={() => { setDraft(null); setIssues([]); }}>{t("取消")}</button>
            <button className="primary-button" type="button" disabled={isSaving || disabled} onClick={() => void save()}>
              {isSaving ? <LoaderCircle className="spinning" size={13} /> : null}
              {isSaving ? t("保存中…") : t("保存简报")}
            </button>
          </div>
        </>
      ) : (
        <>
          {councilBrief ? <CouncilBriefView brief={councilBrief} /> : null}
          {rawEntries.length > 0 ? (
            <>
              <p className="task-muted">{t("这份简报不是 council-brief 格式，按原始字段显示；编辑后会替换为 council-brief。")}</p>
              <dl className="task-brief">
                {rawEntries.map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{briefValue(value)}</dd></div>
                ))}
              </dl>
            </>
          ) : null}
          {!task.brief ? <p className="task-muted">{t("还没有简报。")}</p> : null}
          <div className="brief-editor-actions">
            <button
              type="button"
              disabled={disabled}
              onClick={() => { setIssues([]); setDraft(createBriefDraft(councilBrief)); }}
            >
              <FilePenLine size={13} />{task.brief ? t("编辑简报") : t("编写简报")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
