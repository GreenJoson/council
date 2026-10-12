/**
 * @input  依赖：界面语言、TaskRepository、AssetRepository、taskId、两路 revision、可用 Agent 列表、打开议题回调；
 *         use-task-detail、use-task-team、TaskStatusForm、BriefSection、TaskAssetsSection、TaskDelegationSection、
 *         TaskTeamPanel、components/FoldableContent 的 FoldText 与状态文案表
 * @output 导出：TaskDetail —— 单个任务的详情：元信息、正文（过长时折叠）、简报（搜索/折叠/编辑）、产物区、状态更新、议题跳转、
 *         诚实限制提示、委派（代码/图像，代码委派可选团队模式）面板与历史；有团队时右栏显示「团队」
 * @pos    #/tasks/<taskId> 的主体；读取失败（含任务不存在）时显示占位与返回列表链接，不白屏。
 *         布局为「主列 + 右栏」网格（宽屏两列，窄屏右栏落到主列下方），没有团队时只有主列
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, ArrowLeft, GitCommitHorizontal, MessagesSquare, RefreshCw } from "lucide-react";
import { buildHash } from "../../app/routes";
import { FoldText } from "../../components/FoldableContent";
import { WORK_ITEM_STATUS_LABELS } from "../../components/ImplementationProgress";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { parseCouncilBrief } from "../../data/tasks/council-brief";
import type { TaskRepository } from "../../data/tasks/task-repository";
import { useI18n } from "../../i18n/I18nProvider";
import type { OrchestrationAdapter } from "../../types/orchestration";
import { BriefSection } from "./BriefSection";
import { KIND_LABELS, SOURCE_LABELS } from "./task-labels";
import { TaskAssetsSection } from "./TaskAssetsSection";
import { TaskDelegationSection } from "./TaskDelegationSection";
import { TaskStatusForm } from "./TaskStatusForm";
import { TaskTeamPanel } from "./TaskTeamPanel";
import { useTaskDetail } from "./use-task-detail";
import { useTaskTeam } from "./use-task-team";

export interface TaskDetailProps {
  repository: TaskRepository;
  assetRepository: AssetRepository;
  taskId: string;
  revision: unknown;
  executionRevision: unknown;
  delegationAgents: OrchestrationAdapter[];
  onOpenTopic: (topicId: string) => void;
}

const LIST_HASH = buildHash({ view: "tasks" });

export function TaskDetail({
  repository,
  assetRepository,
  taskId,
  revision,
  executionRevision,
  delegationAgents,
  onOpenTopic,
}: TaskDetailProps) {
  const { t } = useI18n();
  const state = useTaskDetail(repository, taskId, revision, executionRevision);
  const teamState = useTaskTeam(repository, taskId, revision, executionRevision);
  const { detail } = state;

  if (!detail) {
    return (
      <main className="tasks-view task-detail" id="main-content">
        <a className="tasks-back-link" href={LIST_HASH}><ArrowLeft size={14} />{t("返回任务列表")}</a>
        {state.loadError ? (
          <div className="tasks-placeholder" role="alert">
            <h1>{t("无法打开这条任务")}</h1>
            <p>{t(state.loadError)}</p>
            <button type="button" onClick={state.reload}><RefreshCw size={13} />{t("重试")}</button>
          </div>
        ) : (
          <p className="tasks-placeholder" role="status">{t("加载中…")}</p>
        )}
      </main>
    );
  }

  const { task, topic, delegations, limitation } = detail;
  const latestDelegation = delegations[0];
  const topicId = topic?.id ?? task.topicId;
  const busy = state.busyAction !== null;
  const councilBrief = task.brief ? parseCouncilBrief(task.brief) : null;
  // 图像委派的验收标准默认取简报的验收条目，其次是任务正文。
  const defaultAcceptance = councilBrief?.acceptance.length
    ? councilBrief.acceptance.join("\n")
    : task.details || task.title;
  const showAssets = task.kind === "image" || delegations.some((entry) => entry.kind === "image");
  const { team } = teamState;
  const leadDelegation = team ? delegations.find((entry) => entry.id === team.leadDelegationId) : undefined;

  return (
    <main className={`tasks-view task-detail${team ? " has-team" : ""}`} id="main-content" data-task-id={task.id}>
      <a className="tasks-back-link" href={LIST_HASH}><ArrowLeft size={14} />{t("返回任务列表")}</a>
      <header className="task-detail-header">
        <h1>{task.title}</h1>
        <div className="task-meta">
          <span className={`task-status-pill is-${task.status}`}>{t(WORK_ITEM_STATUS_LABELS[task.status])}</span>
          <span>{t(KIND_LABELS[task.kind])}</span>
          <span>{t(SOURCE_LABELS[task.source])}</span>
          <span>{t("优先级 {priority}", { priority: task.priority })}</span>
          <span>v{task.version} · {task.updatedLabel}</span>
        </div>
        {topicId ? (
          <a
            className="task-topic-link"
            href={buildHash({ view: "discussion", topicId })}
            onClick={(event) => {
              // 交给壳层的打开议题逻辑（同时处理选题与 hash），保留 href 以支持新标签打开。
              event.preventDefault();
              onOpenTopic(topicId);
            }}
          >
            <MessagesSquare size={14} />
            {t("在讨论中打开")}
            {topic ? <small>{topic.title}</small> : null}
          </a>
        ) : null}
      </header>

      {state.loadError ? (
        // 已有旧详情时，重读失败只做提示，不把整页换成占位。
        <p className="task-notice is-warning" role="alert"><AlertTriangle size={13} />{t(state.loadError)}</p>
      ) : null}
      {limitation ? (
        <p className="task-notice is-warning" role="note"><AlertTriangle size={13} />{t(limitation)}</p>
      ) : null}

      <div className="task-detail-layout">
        <div className="task-detail-main">
          <section className="task-detail-section" aria-label={t("任务内容")}>
            {task.details
              ? <FoldText className="task-details-text" text={task.details} maxLines={6} maxChars={240} />
              : <p className="task-muted">{t("没有补充说明。")}</p>}
            {task.statusNote ? <blockquote>{task.statusNote}</blockquote> : null}
            {task.fixCommit ? <small className="task-commit"><GitCommitHorizontal size={12} />{task.fixCommit}</small> : null}
          </section>

          <BriefSection
            key={`${task.id}:brief`}
            task={task}
            isSaving={state.busyAction === "brief"}
            disabled={busy}
            saveError={state.actionError?.kind === "brief" ? state.actionError.message : undefined}
            onSave={state.saveBrief}
          />

          {showAssets ? (
            <TaskAssetsSection
              repository={assetRepository}
              taskId={task.id}
              revision={revision}
              executionRevision={executionRevision}
            />
          ) : null}

          <section className="task-detail-section" aria-labelledby="task-status-heading">
            <h2 id="task-status-heading">{t("更新状态")}</h2>
            {state.actionError?.kind === "update" ? (
              <p className="task-notice is-danger" role="alert">
                <AlertTriangle size={13} />
                {t("保存失败：{message}。已重新读取最新任务，请确认后再提交。", { message: t(state.actionError.message) })}
              </p>
            ) : null}
            <TaskStatusForm
              key={`${task.id}:${task.version}`}
              task={task}
              latestDelegation={latestDelegation}
              isSaving={state.busyAction === "update"}
              disabled={busy}
              onSubmit={state.updateStatus}
            />
          </section>

          <TaskDelegationSection
            task={task}
            delegations={delegations}
            adapters={delegationAgents}
            assetRepository={assetRepository}
            defaultAcceptance={defaultAcceptance}
            busyAction={state.busyAction}
            actionError={state.actionError && (state.actionError.kind === "delegate" || state.actionError.kind === "cancel")
              ? state.actionError.message : undefined}
            onStart={state.startDelegation}
            onCancel={state.cancelDelegation}
            onStartTeam={async (input) => {
              const started = await state.startTeam(input);
              if (started) teamState.applyTeam(started);
            }}
            hasActiveTeam={team?.status === "active"}
          />
        </div>

        {team ? (
          <TaskTeamPanel
            team={team}
            leadDelegation={leadDelegation}
            busyAction={teamState.busyAction}
            actionError={teamState.actionError}
            loadError={teamState.loadError}
            onFocus={teamState.focusWorker}
            onInterrupt={teamState.interruptWorker}
            onArchive={teamState.archiveWorker}
            onEndTeam={teamState.endTeam}
          />
        ) : null}
      </div>
    </main>
  );
}
