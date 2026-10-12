/**
 * @input  依赖：界面语言、流水线文档（模板、stages、currentStageId、修订轮数、取消标记）、子任务列表与已产出图数；
 *         pipeline-labels、app/routes 的 buildHash
 * @output 导出：PipelineTrack —— 按模板阶段顺序的横向轨道：每段显示状态、起止时间、错误 code/message、子任务链接（#/tasks/<id>，
 *         文字用子任务标题，能看出是第几轮/修订轮）；修订轮出图失败时注明此前产出的图仍保留、「恢复」只重跑这一轮
 * @pos    流水线详情的只读进度区；窄屏改为纵向堆叠（pipelines.css），不承载任何写操作
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { buildHash } from "../../app/routes";
import { useI18n } from "../../i18n/I18nProvider";
import type { CouncilWorkItem } from "../../types/council";
import { PIPELINE_TEMPLATE_STAGES, type CouncilPipelineDocument, type PipelineStage } from "../../types/pipelines";
import { STAGE_LABELS, STAGE_STATUS_LABELS, formatPipelineTime } from "./pipeline-labels";

export interface PipelineTrackProps {
  document: CouncilPipelineDocument;
  /** 流水线子任务：用标题替代笼统的「查看子任务」。 */
  childTasks?: readonly CouncilWorkItem[];
  /** 本流水线图像子任务已产出的图数。 */
  outputCount?: number;
}

export function PipelineTrack({ document, childTasks = [], outputCount = 0 }: PipelineTrackProps) {
  const { t, locale } = useI18n();
  // 以模板定义的阶段顺序为准；文档缺某段时按 pending 占位，避免后端漏写导致轨道断档。
  const stages: PipelineStage[] = PIPELINE_TEMPLATE_STAGES[document.template].map((id) =>
    document.stages.find((stage) => stage.id === id) ?? { id, status: "pending" });

  return (
    <ol className="pipeline-track" aria-label={t("流水线阶段")}>
      {stages.map((stage) => (
        <li
          key={stage.id}
          className={`pipeline-stage is-${stage.status} ${stage.id === document.currentStageId ? "is-current" : ""}`}
          data-stage-id={stage.id}
          data-stage-status={stage.status}
          aria-current={stage.id === document.currentStageId ? "step" : undefined}
        >
          <div className="pipeline-stage-head">
            <strong>{t(STAGE_LABELS[stage.id])}</strong>
            <span className={`pipeline-stage-badge is-${stage.status}`}>{t(STAGE_STATUS_LABELS[stage.status])}</span>
          </div>
          {stage.startedAt ? (
            <span className="pipeline-stage-time">{t("开始 {time}", { time: formatPipelineTime(stage.startedAt, locale) })}</span>
          ) : null}
          {stage.endedAt ? (
            <span className="pipeline-stage-time">{t("结束 {time}", { time: formatPipelineTime(stage.endedAt, locale) })}</span>
          ) : null}
          {stage.error ? (
            <span className="pipeline-stage-error">
              <code>{stage.error.code}</code> {stage.error.message}
            </span>
          ) : null}
          {stage.id === "image" && stage.status === "failed" && document.revisionCount > 0 && outputCount > 0 ? (
            // 修订轮失败时阶段显示「失败」，但前几轮的图并没有丢：说清楚，免得以为整段出图白做了。
            <span className="pipeline-stage-note">
              {t("失败的是修订轮；此前已产出的 {count} 张图仍保留，「恢复」只重跑这一轮修订。", { count: outputCount })}
            </span>
          ) : null}
          {stage.workItemId ? (
            <a className="pipeline-stage-link" href={buildHash({ view: "tasks", taskId: stage.workItemId })}>
              {childTasks.find((child) => child.id === stage.workItemId)?.title ?? t("查看子任务")}
            </a>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
