/**
 * @input  依赖：界面语言、打开状态、PipelineRepository.createPipeline、AssetRepository（列参考图候选）、可用 Agent 列表；
 *         pipeline-labels、features/assets 的 AssetThumbnail
 * @output 导出：PipelineCreateDialog —— 原生 <dialog> 新建流水线：模板单选、目标（必填）、多行约束（每行一条）、
 *         资产库参考图多选（最多 8 张）、各阶段 Agent 选择（默认留空 = 服务端默认）
 * @pos    流水线列表的新建入口；创建成功把详情交给调用方（负责导航到 #/pipelines/<id>），失败留在表单内显示
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { getErrorMessage } from "../../data/error-message";
import type { PipelineRepository } from "../../data/pipelines/pipeline-repository";
import { useI18n } from "../../i18n/I18nProvider";
import type { Asset } from "../../types/assets";
import type { OrchestrationAdapter } from "../../types/orchestration";
import { PIPELINE_TEMPLATES, type PipelineAgents, type PipelineDetail, type PipelineTemplate } from "../../types/pipelines";
import { AssetThumbnail } from "../assets/AssetThumbnail";
import { TEMPLATE_HINTS, TEMPLATE_LABELS } from "./pipeline-labels";

/** 契约：referenceAssetIds 最多 8 个。 */
const MAX_REFERENCES = 8;

export interface PipelineCreateDialogProps {
  isOpen: boolean;
  repository: PipelineRepository;
  assetRepository: AssetRepository;
  agents: OrchestrationAdapter[];
  onClose: () => void;
  onCreated: (detail: PipelineDetail) => void;
}

/** 打开时读一次资产库第一页图像作参考候选，够选 8 张。 */
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

function splitLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function PipelineCreateDialog({ isOpen, repository, assetRepository, agents, onClose, onCreated }: PipelineCreateDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [template, setTemplate] = useState<PipelineTemplate>("app-mockup");
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [briefAgent, setBriefAgent] = useState("");
  const [imageAgent, setImageAgent] = useState("");
  const [prototypeAgent, setPrototypeAgent] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useReferenceCandidates(assetRepository, isOpen);
  const available = useMemo(() => agents.filter((agent) => agent.available), [agents]);
  const imageAgents = useMemo(() => available.filter((agent) => agent.runtimeCapabilities.includes("image_generate")), [available]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      setError(null);
      dialog.showModal();
    }
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  const canCreate = goal.trim().length > 0 && !isCreating;

  function toggleReference(assetId: string, checked: boolean) {
    setReferences((current) => checked
      ? [...current.filter((id) => id !== assetId), assetId].slice(0, MAX_REFERENCES)
      : current.filter((id) => id !== assetId));
  }

  function chosenAgents(): Partial<PipelineAgents> | undefined {
    // 只发用户明确选过的 Agent；全空时整个字段不发，交给服务端默认。
    const chosen: Partial<PipelineAgents> = {
      ...(briefAgent ? { brief: briefAgent } : {}),
      ...(imageAgent ? { image: imageAgent } : {}),
      ...(template === "app-mockup" && prototypeAgent ? { prototype: { executor: prototypeAgent } } : {}),
    };
    return Object.keys(chosen).length > 0 ? chosen : undefined;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    setIsCreating(true);
    setError(null);
    try {
      const lines = splitLines(constraints);
      const agentChoice = chosenAgents();
      const created = await repository.createPipeline({
        template,
        goal: goal.trim(),
        ...(lines.length > 0 ? { constraints: lines } : {}),
        ...(references.length > 0 ? { referenceAssetIds: references } : {}),
        ...(agentChoice ? { agents: agentChoice } : {}),
      });
      setGoal("");
      setConstraints("");
      setReferences([]);
      onCreated(created);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setIsCreating(false);
    }
  }

  const agentSelect = (label: string, value: string, onChange: (next: string) => void, options: OrchestrationAdapter[]) => (
    <label>
      <span>{t(label)}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("服务端默认")}</option>
        {options.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
      </select>
    </label>
  );

  return (
    <dialog
      className="create-topic-dialog task-create-dialog pipeline-create-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-labelledby="pipeline-create-title"
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <header>
          <div>
            <span className="dialog-kicker">{t("新建流水线")}</span>
            <h2 id="pipeline-create-title">{t("从目标出发，自动走完出图流程")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t("关闭")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <fieldset className="pipeline-template-options">
          <legend>{t("模板")}</legend>
          {PIPELINE_TEMPLATES.map((value) => (
            <label key={value} className={`pipeline-template-option ${template === value ? "is-selected" : ""}`}>
              <input type="radio" name="pipeline-template" value={value} checked={template === value}
                onChange={() => setTemplate(value)} />
              <span>
                <strong>{t(TEMPLATE_LABELS[value])}</strong>
                <small>{t(TEMPLATE_HINTS[value])}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          <span>{t("目标")}</span>
          <textarea
            autoFocus
            rows={3}
            maxLength={2000}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder={t("例如：会员中心首页改版，突出权益与续费入口")}
          />
        </label>
        <label>
          <span>{t("约束")} <small>{t("可选，每行一条")}</small></span>
          <textarea
            rows={3}
            maxLength={4000}
            value={constraints}
            onChange={(event) => setConstraints(event.target.value)}
            placeholder={t("例如：沿用现有品牌色")}
          />
        </label>
        <fieldset className="task-reference-fieldset">
          <legend>{t("参考图（可选，最多 {max} 张）", { max: MAX_REFERENCES })}</legend>
          {candidates.error ? <p className="task-notice is-danger" role="alert">{t(candidates.error)}</p> : null}
          {candidates.assets.length === 0 ? (
            <p className="task-muted">{t("资产库里还没有图像。")}</p>
          ) : (
            <div className="task-reference-list">
              {candidates.assets.map((asset) => (
                <label className="task-reference-option" key={asset.id}>
                  <AssetThumbnail repository={assetRepository} asset={asset} />
                  <span>
                    <input
                      type="checkbox"
                      checked={references.includes(asset.id)}
                      disabled={!references.includes(asset.id) && references.length >= MAX_REFERENCES}
                      onChange={(event) => toggleReference(asset.id, event.target.checked)}
                    />
                    {asset.id.slice(-8)}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className="task-create-row pipeline-agent-row">
          {agentSelect("简报 Agent", briefAgent, setBriefAgent, available)}
          {agentSelect("出图 Agent", imageAgent, setImageAgent, imageAgents)}
          {template === "app-mockup" ? agentSelect("原型 Agent", prototypeAgent, setPrototypeAgent, available) : null}
        </div>
        {error ? <p className="task-notice is-danger" role="alert">{t(error)}</p> : null}
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>{t("取消")}</button>
          <button className="primary-button" type="submit" disabled={!canCreate}>
            <Plus size={17} />
            {isCreating ? t("创建中…") : t("创建流水线")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
