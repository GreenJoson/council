/**
 * @input  依赖：界面语言、当前任务、保存回调与忙碌/错误态；data/tasks/council-brief 解析、brief-form、BriefEditor、
 *         components/FoldableContent 的区块搜索与折叠
 * @output 导出：BriefSection —— 任务详情的「简报」区：council-brief 结构化展示（目标、交付物、风格、参考资产、验收），
 *         非 council-brief 的旧简报回退为键值列表（对象值格式化成多行 JSON）；标题栏带区块内搜索（过滤并高亮命中条目）
 *         与整区收起/展开，长列表、长目标与长字段值默认折叠；「编辑简报」展开 BriefEditor，经 PUT /tasks/:id 的 brief 保存。
 *         流水线父任务的 brief 字段是流水线文档：默认收起、指向流水线页、不提供编辑（编辑会把文档替换成 council-brief）
 * @pos    任务详情的子区块；保存成功后收起，失败时保留草稿并显示服务端/本地校验错误
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, ChevronDown, ChevronRight, FilePenLine, LoaderCircle, Workflow } from "lucide-react";
import { useState } from "react";
import { buildHash } from "../../app/routes";
import { FoldList, FoldText, Highlight, SectionSearch, normalizeQuery, textMatches } from "../../components/FoldableContent";
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

/** 旧简报结构由来源决定，前端不解释字段：字符串原样显示，其余值格式化成多行 JSON，便于折叠与搜索。 */
function briefValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

type Deliverable = CouncilBrief["deliverables"][number];

type Translate = (text: string) => string;

/**
 * 按查询过滤 council-brief 各块；空查询原样返回，matchCount 只在有查询时有意义。
 * 查询命中块标题（如「风格约束」）时整块保留——用户常按块名找内容，条目本身不含块名。
 */
function filterCouncilBrief(brief: CouncilBrief, query: string, t: Translate) {
  const pick = <T,>(label: string, items: readonly T[], match: (entry: T) => boolean): T[] =>
    textMatches(query, t(label)) ? [...items] : items.filter(match);
  const deliverables = pick("交付物", brief.deliverables, (entry) => textMatches(query, entry.id, entry.description, entry.size));
  const constraints = pick("风格约束", brief.style?.constraints ?? [], (entry) => textMatches(query, entry));
  const references = pick("参考资产", brief.style?.references ?? [], (entry) => textMatches(query, entry));
  const acceptance = pick("验收条目", brief.acceptance, (entry) => textMatches(query, entry));
  const goal = textMatches(query, brief.goal);
  const palette = Boolean(brief.style?.palette) && textMatches(query, brief.style?.palette);
  const nextStage = Boolean(brief.nextStage) && textMatches(query, brief.nextStage?.notes);
  const matchCount = deliverables.length + constraints.length + references.length + acceptance.length
    + Number(goal) + Number(palette) + Number(nextStage);
  return { deliverables, constraints, references, acceptance, goal, palette, nextStage, matchCount };
}

function CouncilBriefView({ brief, query }: { brief: CouncilBrief; query: string }) {
  const { t } = useI18n();
  const searching = Boolean(normalizeQuery(query));
  const view = filterCouncilBrief(brief, query, t);
  const renderDeliverable = (entry: Deliverable) => (
    <>
      <code><Highlight text={entry.id} query={query} /></code> <Highlight text={entry.description} query={query} />
      {entry.size ? <> · <Highlight text={entry.size} query={query} /></> : null}
      {entry.transparent ? ` · ${t("透明背景")}` : ""}
      {entry.count !== undefined ? ` · ×${String(entry.count)}` : ""}
    </>
  );
  return (
    <div className="brief-view">
      {view.goal ? (
        <div className="brief-goal">
          <strong>{t(BRIEF_KIND_LABELS[brief.kind])}</strong>
          <FoldText text={brief.goal} query={query} maxLines={3} maxChars={160} />
        </div>
      ) : null}
      {view.deliverables.length > 0 ? (
        <>
          <h3>{t("交付物")} <small>{view.deliverables.length}</small></h3>
          <FoldList items={view.deliverables} getKey={(entry) => entry.id} renderItem={renderDeliverable} forceOpen={searching} />
        </>
      ) : null}
      {view.constraints.length > 0 ? (
        <>
          <h3>{t("风格约束")} <small>{view.constraints.length}</small></h3>
          <FoldList items={view.constraints} getKey={(_, index) => index} forceOpen={searching}
            renderItem={(entry) => <Highlight text={entry} query={query} />} />
        </>
      ) : null}
      {view.palette && brief.style?.palette ? (
        <p><span className="task-muted">{t("配色")}</span> <Highlight text={brief.style.palette} query={query} /></p>
      ) : null}
      {view.references.length > 0 ? (
        <>
          <h3>{t("参考资产")} <small>{view.references.length}</small></h3>
          <FoldList items={view.references} getKey={(assetId) => assetId} forceOpen={searching}
            renderItem={(assetId) => <a href={buildHash({ view: "assets", assetId })}><code><Highlight text={assetId} query={query} /></code></a>} />
        </>
      ) : null}
      {view.acceptance.length > 0 ? (
        <>
          <h3>{t("验收条目")} <small>{view.acceptance.length}</small></h3>
          <FoldList items={view.acceptance} getKey={(_, index) => index} forceOpen={searching}
            renderItem={(entry) => <Highlight text={entry} query={query} />} />
        </>
      ) : null}
      {view.nextStage && brief.nextStage ? (
        <p className="task-muted">{t("下一阶段：原型")} · <Highlight text={brief.nextStage.notes} query={query} /></p>
      ) : null}
      {searching && view.matchCount === 0 ? <p className="task-muted">{t("没有匹配的内容。")}</p> : null}
    </div>
  );
}

function RawBriefView({ entries, query }: { entries: [string, unknown][]; query: string }) {
  const { t } = useI18n();
  const rows = entries
    .map(([key, value]) => ({ key, text: briefValue(value) }))
    .filter((row) => textMatches(query, row.key, row.text));
  if (rows.length === 0) return <p className="task-muted">{t("没有匹配的内容。")}</p>;
  return (
    <dl className="task-brief">
      {rows.map((row) => (
        <div key={row.key}>
          <dt><Highlight text={row.key} query={query} /></dt>
          <dd><FoldText text={row.text} query={query} as="pre" maxLines={6} maxChars={320} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** 有查询时标题栏显示的命中数；旧简报按字段计。 */
function briefMatchCount(brief: CouncilBrief | null, rawEntries: [string, unknown][], query: string, t: Translate): number {
  if (brief) return filterCouncilBrief(brief, query, t).matchCount;
  return rawEntries.filter(([key, value]) => textMatches(query, key, briefValue(value))).length;
}

export function BriefSection({ task, isSaving, disabled, saveError, onSave }: BriefSectionProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [issues, setIssues] = useState<BriefIssue[]>([]);
  const isPipeline = task.kind === "pipeline";
  // 流水线父任务的 brief 是整份流水线文档，默认收起；普通任务的简报默认展开。
  const [open, setOpen] = useState(!isPipeline);
  const [query, setQuery] = useState("");
  const councilBrief = task.brief && !isPipeline ? parseCouncilBrief(task.brief) : null;
  const rawEntries = task.brief && !councilBrief ? Object.entries(task.brief) : [];
  const searching = Boolean(normalizeQuery(query));
  const showBody = open || searching;

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
      <div className="task-section-head">
        {task.brief && !draft ? (
          <button className="task-section-toggle" type="button" aria-expanded={showBody} onClick={() => setOpen((value) => !value)}>
            {showBody ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <h2 id="task-brief-heading">{isPipeline ? t("流水线文档") : t("简报")}</h2>
          </button>
        ) : (
          <h2 id="task-brief-heading">{t("简报")}</h2>
        )}
        {task.brief && !draft ? (
          <SectionSearch
            value={query}
            onChange={setQuery}
            label={t("在简报中搜索")}
            placeholder={t("搜索简报…")}
            status={searching ? t("{count} 项匹配", { count: briefMatchCount(councilBrief, rawEntries, query, t) }) : undefined}
          />
        ) : null}
      </div>
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
          {isPipeline ? (
            <p className="task-muted">
              {t("这是流水线父任务，这里是流水线文档原文，由流水线维护。")}{" "}
              <a href={buildHash({ view: "pipelines", pipelineId: task.id })}><Workflow size={12} />{t("打开流水线")}</a>
            </p>
          ) : null}
          {showBody && councilBrief ? <CouncilBriefView brief={councilBrief} query={query} /> : null}
          {showBody && rawEntries.length > 0 ? (
            <>
              {!isPipeline ? (
                <p className="task-muted">{t("这份简报不是 council-brief 格式，按原始字段显示；编辑后会替换为 council-brief。")}</p>
              ) : null}
              <RawBriefView entries={rawEntries} query={query} />
            </>
          ) : null}
          {!task.brief ? <p className="task-muted">{t("还没有简报。")}</p> : null}
          {!isPipeline ? (
            <div className="brief-editor-actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => { setIssues([]); setQuery(""); setDraft(createBriefDraft(councilBrief)); }}
              >
                <FilePenLine size={13} />{task.brief ? t("编辑简报") : t("编写简报")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
