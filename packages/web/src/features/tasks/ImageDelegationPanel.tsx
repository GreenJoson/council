/**
 * @input  依赖：界面语言、当前任务、可用 Agent 列表、最新图像委派、AssetRepository（列 reference 候选）、
 *         默认验收标准、忙碌键与发起/取消回调；components 的委派状态文案，features/assets 的 AssetThumbnail
 * @output 导出：ImageDelegationPanel —— 图像委派入口：执行者只列 granted 含 image_generate 的可用 Agent，不显示审核者；
 *         可勾选同项目 kind=image 的 reference 资产（最多 8 个）；提交 kind=image、inputAssetIds、human 验收、workspace_write
 * @pos    任务详情委派区在「图像」模式下的面板；已有图像委派时显示状态摘要、取消与重新委派入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, Bot, ImagePlus, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { delegationStatusLabel } from "../../components/DelegationExecutionProgress";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { getErrorMessage } from "../../data/error-message";
import { useI18n } from "../../i18n/I18nProvider";
import type { Asset } from "../../types/assets";
import type { CouncilWorkItem } from "../../types/council";
import type { OrchestrationAdapter, WorkItemDelegation } from "../../types/orchestration";
import { AssetThumbnail } from "../assets/AssetThumbnail";
import type { TaskDelegationStartInput } from "./use-task-detail";

/** 契约：图像委派的输入资产最多 8 个。 */
const MAX_REFERENCES = 8;
const ACTIVE = new Set<WorkItemDelegation["status"]>(["queued", "executing", "reviewing", "changes_requested"]);

export interface ImageDelegationPanelProps {
  item: CouncilWorkItem;
  adapters: OrchestrationAdapter[];
  delegation?: WorkItemDelegation;
  assetRepository: AssetRepository;
  defaultAcceptance: string;
  busyAction: string | null;
  onStart: (input: TaskDelegationStartInput) => Promise<void>;
  onCancel: (delegationId: string) => Promise<void>;
}

export function imageExecutors(adapters: OrchestrationAdapter[]): OrchestrationAdapter[] {
  return adapters.filter((agent) => agent.available && agent.runtimeCapabilities.includes("image_generate"));
}

/** 同项目、kind=image、未删除的资产作为 reference 候选；只取第一页，够选 8 张。 */
function useReferenceCandidates(repository: AssetRepository, enabled: boolean) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    repository.listAssets({ kind: "image", limit: repository.pageSize, offset: 0 })
      .then((page) => { if (active) { setAssets(page.items.filter((asset) => !asset.deletedAt)); setError(null); } })
      .catch((reason: unknown) => { if (active) setError(getErrorMessage(reason)); });
    return () => { active = false; };
  }, [repository, enabled]);
  return { assets, error };
}

export function ImageDelegationPanel({
  item,
  adapters,
  delegation,
  assetRepository,
  defaultAcceptance,
  busyAction,
  onStart,
  onCancel,
}: ImageDelegationPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const executors = useMemo(() => imageExecutors(adapters), [adapters]);
  const [executorId, setExecutorId] = useState(executors[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(defaultAcceptance);
  const references = useReferenceCandidates(assetRepository, open);

  // Agent 能力异步到达：首次渲染的空列表不能固化成选择。
  useEffect(() => {
    if (!executors.some((agent) => agent.id === executorId)) setExecutorId(executors[0]?.id ?? "");
  }, [executorId, executors]);

  const active = delegation ? ACTIVE.has(delegation.status) : false;

  if (delegation && !open) {
    const executing = adapters.find((agent) => agent.id === delegation.executorAgentId);
    return (
      <div className={`work-item-delegation-state is-${delegation.status}`}>
        <span><ImagePlus size={13} /><strong>{t(delegationStatusLabel(delegation))}</strong></span>
        <small>
          {executing?.label ?? delegation.executorAgentId}
          {" · "}
          {t("参考图 {count} 张", { count: delegation.inputAssetIds.length })}
        </small>
        {active ? <p>{t("后台生成中，完成后图片会出现在「产物」区。")}</p> : null}
        {delegation.status === "approved" && item.status !== "completed"
          ? <p>{t("生成完成，请在产物区挑选最终稿，再在任务状态中完成验收。")}</p> : null}
        {delegation.acceptanceCriteria ? <details className="delegation-criteria"><summary>{t("查看验收标准")}</summary><p>{delegation.acceptanceCriteria}</p></details> : null}
        {delegation.error ? <p><AlertTriangle size={12} />{t(delegation.error)}</p> : null}
        {active ? (
          <button type="button" disabled={Boolean(busyAction)} onClick={() => void onCancel(delegation.id)}>
            {busyAction === `cancel-delegation:${delegation.id}` ? <LoaderCircle className="spinning" size={12} /> : <X size={12} />}
            {t("取消委派")}
          </button>
        ) : item.status !== "completed" ? (
          <button type="button" disabled={Boolean(busyAction)} onClick={() => setOpen(true)}>
            <Bot size={12} />{t("重新委派")}
          </button>
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        className="work-item-mini-button work-item-delegate-button"
        type="button"
        disabled={Boolean(busyAction) || executors.length === 0}
        title={executors.length === 0 ? t("生图需要本机 ChatGPT 登录的 Codex") : undefined}
        onClick={() => setOpen(true)}
      >
        <ImagePlus size={12} />{t("委派生图")}
      </button>
    );
  }

  function toggleReference(assetId: string, checked: boolean) {
    setSelected((current) => checked
      ? current.includes(assetId) || current.length >= MAX_REFERENCES ? current : [...current, assetId]
      : current.filter((id) => id !== assetId));
  }

  const valid = Boolean(executorId && acceptanceCriteria.trim());
  return (
    <div className="task-delegation-form" data-delegation-kind="image">
      <header className="task-delegation-kind">
        <ImagePlus size={13} /><strong>{t("图像委派")}</strong>
        <button type="button" className="work-item-mini-button" aria-label={t("关闭")} onClick={() => setOpen(false)}><X size={13} /></button>
      </header>
      <p className="task-muted">{t("由具备生图能力的 Agent 在隔离 worktree 内按简报生成图片；不经 Agent 审核，由人在产物区验收。")}</p>
      {executors.length === 0 ? (
        <p className="task-notice is-warning" role="note"><AlertTriangle size={13} />{t("生图需要本机 ChatGPT 登录的 Codex")}</p>
      ) : (
        <label>
          <span>{t("生图 Agent")}</span>
          <select aria-label={t("生图 Agent")} value={executorId} onChange={(event) => setExecutorId(event.target.value)}>
            {executors.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
          </select>
        </label>
      )}
      <fieldset>
        <legend>{t("参考图（可选，最多 {max} 张）", { max: MAX_REFERENCES })}</legend>
        {references.error ? <p className="task-notice is-danger" role="alert">{t(references.error)}</p> : null}
        {references.assets.length === 0 ? (
          <p className="task-muted">{t("资产库里还没有图像。")}</p>
        ) : (
          <div className="task-reference-list">
            {references.assets.map((asset) => (
              <label className="task-reference-option" key={asset.id}>
                <AssetThumbnail repository={assetRepository} asset={asset} />
                <span>
                  <input
                    type="checkbox"
                    checked={selected.includes(asset.id)}
                    disabled={!selected.includes(asset.id) && selected.length >= MAX_REFERENCES}
                    onChange={(event) => toggleReference(asset.id, event.target.checked)}
                  />
                  {asset.id.slice(-8)}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label>
        <span>{t("验收标准")}</span>
        <textarea aria-label={t("验收标准")} rows={3} maxLength={4000} value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} />
      </label>
      <div className="task-delegation-actions">
        <button
          className="primary-button"
          type="button"
          disabled={!valid || Boolean(busyAction)}
          onClick={() => void onStart({
            kind: "image",
            executorAgentId: executorId,
            requestedPermission: "workspace_write",
            completionPolicy: "human",
            acceptanceCriteria: acceptanceCriteria.trim(),
            inputAssetIds: selected,
          }).then(() => setOpen(false))}
        >
          {busyAction === `delegate:${item.id}` ? <LoaderCircle className="spinning" size={13} /> : <ImagePlus size={13} />}
          {t("开始生图")}
        </button>
      </div>
    </div>
  );
}
