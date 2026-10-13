/**
 * @input  依赖：界面语言、流水线详情、AssetRepository、忙碌动作与写操作回调（均由 use-pipeline-detail 提供，内部带父任务 version）；
 *         features/tasks 的 BriefEditor 与 brief-form、data/tasks 的 parseCouncilBrief、AssetCompare
 * @output 导出：StageControls —— 当前阶段的人工操作区：
 *         brief 等待处理 → BriefEditor 编辑 draftBrief 后「确认简报」；select 等待处理 → AssetCompare 勾选 1–3 张后「选定」；
 *         failed → 「恢复」；未结束 → 两步确认的「取消流水线」；不在运行（含已取消、已完成）→ 两步确认的「删除流水线」
 * @pos    流水线详情的唯一写入口；本地 brief 校验不过不提交，服务端错误由详情页统一展示
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Ban, Check, CheckCheck, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { parseCouncilBrief, type BriefIssue } from "../../data/tasks/council-brief";
import { useI18n } from "../../i18n/I18nProvider";
import type { PipelineDetail } from "../../types/pipelines";
import { BriefEditor } from "../tasks/BriefEditor";
import { createBriefDraft, resolveBriefDraft, type BriefDraft } from "../tasks/brief-form";
import { AssetCompare } from "./AssetCompare";
import type { PipelineAction } from "./use-pipeline-detail";

/** 契约：final 至少 1 张、至多 3 张。 */
const MAX_FINAL = 3;

export interface StageControlsProps {
  detail: PipelineDetail;
  assetRepository: AssetRepository;
  busyAction: PipelineAction | null;
  onConfirmBrief: (brief: Record<string, unknown>) => Promise<boolean>;
  onSelectFinal: (assetIds: string[]) => Promise<boolean>;
  onResume: () => Promise<boolean>;
  onCancel: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}

/** 已取消，或全部阶段完成，即视为结束：只剩删除，不再提供推进类写操作。 */
export function isPipelineFinished(detail: PipelineDetail): boolean {
  const { document } = detail;
  if (document.status === "cancelled") return true;
  return document.stages.length > 0 && document.stages.every((stage) => stage.status === "completed");
}

function BriefConfirm({ detail, busy, onConfirm }: { detail: PipelineDetail; busy: boolean; onConfirm: StageControlsProps["onConfirmBrief"] }) {
  const { t } = useI18n();
  // 草稿只在进入该阶段时从 draftBrief 初始化；后续重读不覆盖用户正在编辑的内容。
  const [draft, setDraft] = useState<BriefDraft>(() => createBriefDraft(parseCouncilBrief(detail.document.draftBrief)));
  const [issues, setIssues] = useState<BriefIssue[]>([]);

  async function confirm() {
    const resolved = resolveBriefDraft(draft);
    setIssues(resolved.issues);
    if (!resolved.brief) return;
    await onConfirm(resolved.brief as unknown as Record<string, unknown>);
  }

  return (
    <section className="task-detail-section pipeline-controls" data-pipeline-control="brief">
      <h2>{t("确认简报")}</h2>
      <p className="task-muted">{t("Agent 已起草简报。可直接修改，确认后进入出图。")}</p>
      <BriefEditor draft={draft} onChange={setDraft} issues={issues} disabled={busy} />
      <div className="pipeline-controls-actions">
        <button className="primary-button" type="button" disabled={busy} onClick={() => void confirm()}>
          {busy ? <LoaderCircle className="spinning" size={15} /> : <Check size={15} />}
          {t("确认简报")}
        </button>
      </div>
    </section>
  );
}

function FinalSelect({ detail, assetRepository, busy, onSelect }: {
  detail: PipelineDetail;
  assetRepository: AssetRepository;
  busy: boolean;
  onSelect: StageControlsProps["onSelectFinal"];
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (assetId: string, checked: boolean) => setSelected((current) =>
    checked ? [...current.filter((id) => id !== assetId), assetId].slice(0, MAX_FINAL) : current.filter((id) => id !== assetId));

  return (
    <section className="task-detail-section pipeline-controls" data-pipeline-control="select">
      <h2>{t("挑选最终稿")}</h2>
      <p className="task-muted">{t("对比候选图，勾选 1–{max} 张作为最终稿。", { max: MAX_FINAL })}</p>
      <AssetCompare
        repository={assetRepository}
        assetIds={detail.outputAssetIds}
        selected={selected}
        maxSelected={MAX_FINAL}
        disabled={busy}
        onToggle={toggle}
      />
      <div className="pipeline-controls-actions">
        <span className="task-muted">{t("已选 {count} 张", { count: selected.length })}</span>
        <button className="primary-button" type="button" disabled={busy || selected.length === 0}
          onClick={() => void onSelect(selected)}>
          {busy ? <LoaderCircle className="spinning" size={15} /> : <CheckCheck size={15} />}
          {t("选定")}
        </button>
      </div>
    </section>
  );
}

export function StageControls({
  detail,
  assetRepository,
  busyAction,
  onConfirmBrief,
  onSelectFinal,
  onResume,
  onCancel,
  onDelete,
}: StageControlsProps) {
  const { t } = useI18n();
  // 取消与删除共用一个两步确认位，同一时刻只展开一个。
  const [confirming, setConfirming] = useState<"cancel" | "delete" | null>(null);

  const { document } = detail;
  const finished = isPipelineFinished(detail);
  const current = document.stages.find((stage) => stage.id === document.currentStageId);
  const busy = busyAction !== null;
  // 运行中的阶段还会写回记录，服务端也会拒绝（409），先取消再删。
  const deletable = finished || current?.status !== "running";

  const deleteControl = confirming === "delete" ? (
    <>
      <span className="task-muted">{t("删除后流水线与子任务记录不可恢复，生成的图片仍留在资产库。确定吗？")}</span>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirming(null)}>
        {t("保留")}
      </button>
      <button className="secondary-button is-danger" type="button" disabled={busy}
        onClick={() => void onDelete().then(() => setConfirming(null))}>
        {busyAction === "delete" ? <LoaderCircle className="spinning" size={15} /> : <Trash2 size={15} />}
        {t("确认删除")}
      </button>
    </>
  ) : (
    <button className="secondary-button is-danger" type="button" disabled={busy} onClick={() => setConfirming("delete")}>
      <Trash2 size={15} />{t("删除流水线")}
    </button>
  );

  if (finished) {
    return <div className="pipeline-controls-actions pipeline-global-actions">{deleteControl}</div>;
  }

  return (
    <>
      {current?.id === "brief" && current.status === "waiting_human" ? (
        <BriefConfirm key={`brief-${String(detail.task.version)}`} detail={detail} busy={busy} onConfirm={onConfirmBrief} />
      ) : null}
      {current?.id === "select" && current.status === "waiting_human" ? (
        <FinalSelect detail={detail} assetRepository={assetRepository} busy={busy} onSelect={onSelectFinal} />
      ) : null}
      <div className="pipeline-controls-actions pipeline-global-actions">
        {current?.status === "failed" ? (
          <button className="primary-button" type="button" disabled={busy} onClick={() => void onResume()}>
            {busyAction === "resume" ? <LoaderCircle className="spinning" size={15} /> : <RotateCcw size={15} />}
            {t("恢复")}
          </button>
        ) : null}
        {confirming === "cancel" ? (
          <>
            <span className="task-muted">{t("取消后流水线不可继续，确定吗？")}</span>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirming(null)}>
              {t("保留")}
            </button>
            <button className="secondary-button is-danger" type="button" disabled={busy}
              onClick={() => void onCancel().then(() => setConfirming(null))}>
              {busyAction === "cancel" ? <LoaderCircle className="spinning" size={15} /> : <Ban size={15} />}
              {t("确认取消")}
            </button>
          </>
        ) : confirming === null ? (
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirming("cancel")}>
            <Ban size={15} />{t("取消流水线")}
          </button>
        ) : null}
        {deletable && confirming !== "cancel" ? deleteControl : null}
      </div>
    </>
  );
}
