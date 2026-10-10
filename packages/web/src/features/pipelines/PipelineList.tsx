/**
 * @input  依赖：界面语言、PipelineRepository、两路 revision、新建入口回调；use-pipelines、pipeline-labels
 * @output 导出：PipelineList —— #/pipelines 列表：按「等待我处理 / 进行中 / 失败 / 已完成」分组，
 *         行显示模板、目标与当前阶段徽标，链接到 #/pipelines/<id>；桌面离线时显示 limitation
 * @pos    流水线视图的列表态；分组在前端由 pipelineGroupOf 完成，行内顺序沿用仓储返回顺序
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus, RefreshCw } from "lucide-react";
import { buildHash } from "../../app/routes";
import type { PipelineRepository } from "../../data/pipelines/pipeline-repository";
import { useI18n } from "../../i18n/I18nProvider";
import {
  PIPELINE_GROUP_LABELS,
  PIPELINE_GROUP_ORDER,
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
  TEMPLATE_LABELS,
  formatPipelineTime,
  pipelineGroupOf,
} from "./pipeline-labels";
import { usePipelines } from "./use-pipelines";

export interface PipelineListProps {
  repository: PipelineRepository;
  revision: unknown;
  executionRevision: unknown;
  onCreate: () => void;
}

export function PipelineList({ repository, revision, executionRevision, onCreate }: PipelineListProps) {
  const { t, locale } = useI18n();
  const { pipelines, limitation, isLoading, error, reload } = usePipelines(repository, revision, executionRevision);
  const groups = PIPELINE_GROUP_ORDER
    .map((group) => ({ group, rows: pipelines.filter((row) => pipelineGroupOf(row) === group) }))
    .filter((entry) => entry.rows.length > 0);

  return (
    <main className="tasks-view pipelines-view" id="main-content">
      <header className="tasks-view-header">
        <h1>{t("流水线")}</h1>
        <div className="tasks-view-actions">
          <button type="button" disabled={isLoading} onClick={reload}><RefreshCw size={13} />{t("刷新")}</button>
          <button className="primary-button" type="button" disabled={Boolean(limitation)} onClick={onCreate}>
            <Plus size={15} />{t("新建流水线")}
          </button>
        </div>
      </header>

      {limitation ? <p className="task-notice is-warning" role="status">{t(limitation)}</p> : null}
      {error ? (
        <p className="task-notice is-danger" role="alert">{t(error)}</p>
      ) : isLoading && pipelines.length === 0 ? (
        <p className="tasks-placeholder" role="status">{t("加载中…")}</p>
      ) : pipelines.length === 0 && !limitation ? (
        <p className="tasks-placeholder">{t("还没有流水线。选一个模板，从目标一路走到可挑选的图与原型。")}</p>
      ) : null}

      {!error ? groups.map(({ group, rows }) => (
        <section className="tasks-group" key={group} data-pipeline-group={group} aria-labelledby={`pipelines-group-${group}`}>
          <h2 id={`pipelines-group-${group}`}>
            {t(PIPELINE_GROUP_LABELS[group])}
            <span>{rows.length}</span>
          </h2>
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <a className={`tasks-row pipeline-row is-${group}`} data-pipeline-id={row.id}
                  href={buildHash({ view: "pipelines", pipelineId: row.id })}>
                  <strong>{row.goal}</strong>
                  <span className="tasks-row-meta">
                    {t(TEMPLATE_LABELS[row.template])} · {formatPipelineTime(row.updatedAt, locale)}
                  </span>
                  <span className={`pipeline-stage-badge is-${row.cancelled ? "skipped" : row.currentStageStatus}`}>
                    {t(STAGE_LABELS[row.currentStageId])} · {row.cancelled ? t("已取消") : t(STAGE_STATUS_LABELS[row.currentStageStatus])}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )) : null}
    </main>
  );
}
