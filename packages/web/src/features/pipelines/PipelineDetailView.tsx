/**
 * @input  依赖：界面语言、PipelineRepository、AssetRepository、pipelineId、两路 revision；
 *         use-pipeline-detail、PipelineTrack、StageControls、pipeline-labels
 * @output 导出：PipelineDetailView —— #/pipelines/<id>：头部（目标、模板、当前阶段、父任务链接）、阶段轨道、人工操作区、
 *         复盘记录与最终稿；写操作 409 时提示「流水线已更新，请重试」并已自动重读
 * @pos    流水线视图的详情态；调用方按 pipelineId 作 key 重挂载，切换流水线时状态不串
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ArrowLeft, RefreshCw } from "lucide-react";
import { buildHash } from "../../app/routes";
import type { AssetRepository } from "../../data/assets/asset-repository";
import type { PipelineRepository } from "../../data/pipelines/pipeline-repository";
import { useI18n } from "../../i18n/I18nProvider";
import { PipelineTrack } from "./PipelineTrack";
import { STAGE_LABELS, STAGE_STATUS_LABELS, TEMPLATE_HINTS, TEMPLATE_LABELS, formatPipelineTime } from "./pipeline-labels";
import { StageControls, isPipelineFinished } from "./StageControls";
import { usePipelineDetail } from "./use-pipeline-detail";

const LIST_HASH = buildHash({ view: "pipelines" });

export interface PipelineDetailViewProps {
  repository: PipelineRepository;
  assetRepository: AssetRepository;
  pipelineId: string;
  revision: unknown;
  executionRevision: unknown;
}

export function PipelineDetailView({ repository, assetRepository, pipelineId, revision, executionRevision }: PipelineDetailViewProps) {
  const { t, locale } = useI18n();
  const state = usePipelineDetail(repository, pipelineId, revision, executionRevision);
  const { detail } = state;

  if (!detail) {
    return (
      <main className="tasks-view pipelines-view" id="main-content">
        <a className="tasks-back-link" href={LIST_HASH}><ArrowLeft size={14} />{t("返回流水线列表")}</a>
        {state.loadError ? (
          <div className="tasks-placeholder" role="alert">
            <h1>{t("无法打开这条流水线")}</h1>
            <p>{t(state.loadError)}</p>
            <button type="button" onClick={state.reload}><RefreshCw size={13} />{t("重试")}</button>
          </div>
        ) : (
          <p className="tasks-placeholder" role="status">{t("加载中…")}</p>
        )}
      </main>
    );
  }

  const { task, document } = detail;
  const cancelled = document.status === "cancelled";
  const current = document.stages.find((stage) => stage.id === document.currentStageId);
  const finished = isPipelineFinished(detail);

  return (
    <main className="tasks-view pipelines-view pipeline-detail" id="main-content" data-pipeline-detail={task.id}>
      <a className="tasks-back-link" href={LIST_HASH}><ArrowLeft size={14} />{t("返回流水线列表")}</a>
      <header className="task-detail-header">
        <h1>{document.request.goal}</h1>
        <div className="task-meta">
          <span className={`pipeline-stage-badge is-${cancelled ? "skipped" : current?.status ?? "pending"}`}>
            {t(STAGE_LABELS[document.currentStageId])} · {cancelled
              ? t("已取消")
              : finished ? t("已完成") : t(STAGE_STATUS_LABELS[current?.status ?? "pending"])}
          </span>
          <span>{t(TEMPLATE_LABELS[document.template])}</span>
          <span>{t("更新于 {time}", { time: formatPipelineTime(document.updatedAt, locale) })}</span>
          <a href={buildHash({ view: "tasks", taskId: task.id })}>{t("查看父任务")}</a>
        </div>
        <p className="task-muted">{t(TEMPLATE_HINTS[document.template])}</p>
      </header>

      {detail.limitation ? <p className="task-notice is-warning" role="status">{t(detail.limitation)}</p> : null}
      {state.loadError ? <p className="task-notice is-danger" role="alert">{t(state.loadError)}</p> : null}
      {state.actionError ? (
        <p className={`task-notice ${state.actionError.conflict ? "is-warning" : "is-danger"}`} role="alert">
          {state.actionError.conflict ? t("流水线已更新，请重试") : t(state.actionError.message)}
        </p>
      ) : null}

      <PipelineTrack document={document} />

      <StageControls
        detail={detail}
        assetRepository={assetRepository}
        busyAction={state.busyAction}
        onConfirmBrief={state.confirmBrief}
        onSelectFinal={state.selectFinal}
        onResume={state.resume}
        onCancel={state.cancel}
      />

      {document.request.constraints?.length ? (
        <section className="task-detail-section">
          <h2>{t("约束")}</h2>
          <ul>{document.request.constraints.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
        </section>
      ) : null}

      {document.reviews.length > 0 ? (
        <section className="task-detail-section" data-pipeline-reviews>
          <h2>{t("复盘记录")}</h2>
          <ol className="pipeline-reviews">
            {document.reviews.map((review) => (
              <li key={review.round}>
                <strong>{t("第 {round} 轮", { round: review.round })}</strong>
                <span className={`pipeline-stage-badge is-${review.verdict === "pass" ? "completed" : "failed"}`}>
                  {review.verdict === "pass" ? t("通过") : t("需返工")}
                </span>
                {review.items.filter((item) => !item.ok).map((item) => (
                  <p key={`${item.assetId}-${item.deliverableId}`} className="task-muted">
                    <code>{item.deliverableId}</code> {item.issue ?? ""}{item.change ? ` → ${item.change}` : ""}
                  </p>
                ))}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {document.finalAssetIds?.length ? (
        <section className="task-detail-section" data-pipeline-final>
          <h2>{t("最终稿")}</h2>
          <ul className="pipeline-final-list">
            {document.finalAssetIds.map((assetId) => (
              <li key={assetId}><a href={buildHash({ view: "assets", assetId })}><code>{assetId}</code></a></li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
