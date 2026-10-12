/**
 * @input  依赖：界面语言上下文、dispatch-block 的派活预览、流水线模板文案表、错误文案提取
 * @output 导出：PipelineDispatchCard（消息卡里的派活方案卡：模板、目标、交付物清单、参考图数与「按此起流水线」按钮）
 * @pos    讨论消息「一键派活」的展示与触发：Agent 只给方案，按钮由人点；点下后服务端从已存消息重解析并起流水线，
 *         成功后由上层跳到流水线页。方案解析不了时只显示问题提示，不给按钮
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useState } from "react";
import { LoaderCircle, Workflow } from "lucide-react";
import type { PipelineDispatchPreview } from "../../data/pipelines/dispatch-block";
import { getErrorMessage } from "../../data/error-message";
import { useI18n } from "../../i18n/I18nProvider";
import { TEMPLATE_LABELS } from "../pipelines/pipeline-labels";

export interface PipelineDispatchCardProps {
  dispatch?: PipelineDispatchPreview;
  /** 尾块存在但解析不了时的中文文案键。 */
  problem?: string;
  /** 未提供时只展示方案、不显示按钮。 */
  onDispatch?: () => Promise<void>;
}

export function PipelineDispatchCard({ dispatch, problem, onDispatch }: PipelineDispatchCardProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!dispatch) {
    return (
      <aside className="pipeline-dispatch-card is-invalid" aria-label={t("派活方案")}>
        <div className="pipeline-dispatch-card-heading">
          <Workflow size={15} />
          <strong>{t("派活方案")}</strong>
        </div>
        <p className="pipeline-dispatch-card-problem">{t(problem ?? "派活方案格式不对，请让 Agent 重新给出。")}</p>
      </aside>
    );
  }

  const { brief } = dispatch;
  const totalImages = brief.deliverables.reduce((sum, entry) => sum + (entry.count ?? 1), 0);

  const start = async () => {
    if (!onDispatch || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDispatch();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="pipeline-dispatch-card" aria-label={t("派活方案")}>
      <div className="pipeline-dispatch-card-heading">
        <Workflow size={15} />
        <strong>{t("派活方案")}</strong>
        <span>{t(TEMPLATE_LABELS[dispatch.template])}</span>
        <span>{t("{count} 项交付物，共 {images} 张", { count: brief.deliverables.length, images: totalImages })}</span>
        {dispatch.referencePaths.length > 0 ? (
          <span>{t("参考图 {count} 张", { count: dispatch.referencePaths.length })}</span>
        ) : null}
      </div>
      <p className="pipeline-dispatch-card-goal">{brief.goal}</p>
      <ul>
        {brief.deliverables.map((entry) => (
          <li key={entry.id}>
            <code>{entry.id}</code>
            <span>{entry.description}</span>
            <small>
              {[
                entry.size,
                entry.transparent ? t("透明背景") : undefined,
                `×${String(entry.count ?? 1)}`,
              ].filter(Boolean).join(" · ")}
            </small>
          </li>
        ))}
      </ul>
      {onDispatch ? (
        <div className="pipeline-dispatch-card-actions">
          <button className="primary-button" type="button" disabled={busy} onClick={() => void start()}>
            {busy ? <LoaderCircle className="spinning" size={15} /> : <Workflow size={15} />}
            {t("按此起流水线")}
          </button>
          <small>{t("跳过简报确认，直接开始生图；参考图会先导入资产库。")}</small>
        </div>
      ) : null}
      {error ? <p className="pipeline-dispatch-card-error" role="alert">{error}</p> : null}
    </aside>
  );
}
