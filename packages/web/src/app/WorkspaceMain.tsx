/**
 * @input  依赖：界面语言、当前 WorkspaceRoute、内容/编排/议题写操作控制器、各工作区视图组件与 features/tasks 的 TasksView、
 *         features/assets 的 AssetsView、features/pipelines 的 PipelinesView
 * @output 导出：WorkspaceMain —— 侧栏右侧的主区域，按路由渲染待处理/架构档案/决策记录/任务（列表或详情，传入内容与编排 revision）/资产库（网格或详情，传入内容 revision）/流水线（列表或详情，传入内容与编排 revision）/
 *         议题讨论（含右栏检查器，讨论页不再承载单项委派与取消）或空工作区
 * @pos    App 壳的视图分发层，只做路由 → 组件与 props 接线，不持有业务状态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus } from "lucide-react";
import { ArchitectureView } from "../components/ArchitectureView";
import { DecisionRecordsView, type DecisionRecordFocusRequest } from "../components/DecisionRecordsView";
import { DiscussionPanel } from "../components/DiscussionPanel";
import { InspectorPanel } from "../components/InspectorPanel";
import { WorkAttentionView } from "../components/WorkAttentionView";
import { AssetsView } from "../features/assets/AssetsView";
import { PipelinesView } from "../features/pipelines/PipelinesView";
import { TasksView } from "../features/tasks/TasksView";
import type { CouncilRepository } from "../data/repository";
import { useI18n } from "../i18n/I18nProvider";
import type { WorkspaceSnapshot } from "../types/council";
import type { WorkspaceRoute } from "./routes";
import type { OrchestrationStateController } from "./use-orchestration-state";
import type { TopicActionsController } from "./use-topic-actions";
import type { WorkspaceContentController } from "./use-workspace-content";

export interface WorkspaceMainProps {
  route: WorkspaceRoute;
  workspace: WorkspaceSnapshot;
  repository: CouncilRepository;
  projectPath: string | undefined;
  content: WorkspaceContentController;
  orchestrationState: OrchestrationStateController;
  topicActions: TopicActionsController;
  decisionFocus: DecisionRecordFocusRequest | null;
  topicDecisionFocusNonce: number | undefined;
  isInspectorOpen: boolean;
  onOpenTopic: (topicId: string) => void;
  onOpenDecisionRecord: (topicId: string) => void;
  onCreateTopic: () => void;
  onOpenManualDecision: () => void;
  onFocusTopicDecision: () => void;
  onCloseInspector: () => void;
}

export function WorkspaceMain({
  route,
  workspace,
  repository,
  projectPath,
  content,
  orchestrationState: orch,
  topicActions: actions,
  decisionFocus,
  topicDecisionFocusNonce,
  isInspectorOpen,
  onOpenTopic,
  onOpenDecisionRecord,
  onCreateTopic,
  onOpenManualDecision,
  onFocusTopicDecision,
  onCloseInspector,
}: WorkspaceMainProps) {
  const { t } = useI18n();
  const { participants, selectedTopic } = content;
  const loadDetail = (topicId: string) => repository.loadTopicDetail(topicId);

  switch (route.view) {
    case "attention":
      return (
        <WorkAttentionView key={workspace.project.id} topicId={workspace.topics[0]?.id}
          revision={workspace} executionRevision={orch.orchestration?.revision}
          onOpenTopic={onOpenTopic} />
      );
    case "architecture":
      return (
        <ArchitectureView
          projectName={workspace.project.name}
          projectPath={projectPath}
          topics={workspace.topics}
          participants={participants}
          onLoadDetail={loadDetail}
          onOpenTopic={onOpenTopic}
          onOpenDecisionRecord={onOpenDecisionRecord}
          onCreateTopic={onCreateTopic}
        />
      );
    case "decisions":
      return (
        <DecisionRecordsView
          topics={workspace.topics}
          participants={participants}
          onLoadDetail={loadDetail}
          onOpenTopic={onOpenTopic}
          focusRequest={decisionFocus}
        />
      );
    case "tasks":
      return (
        <TasksView key={workspace.project.id} taskId={route.taskId}
          revision={workspace} executionRevision={orch.orchestration?.revision}
          delegationAgents={orch.orchestration?.capabilities?.adapters ?? []}
          onOpenTopic={onOpenTopic} />
      );
    case "assets":
      return <AssetsView key={workspace.project.id} assetId={route.assetId} revision={workspace} />;
    case "pipelines":
      return (
        <PipelinesView key={workspace.project.id} pipelineId={route.pipelineId}
          revision={workspace} executionRevision={orch.orchestration?.revision}
          delegationAgents={orch.orchestration?.capabilities?.adapters ?? []} />
      );
    case "discussion":
      break;
  }

  if (!selectedTopic) {
    return (
      <main className="empty-workspace" id="main-content">
        <h1>{t("这个工作区还没有议题")}</h1>
        <p>{t("创建第一个架构议题，Agent 的回复将写回同一条共享时间线。")}</p>
        <button className="primary-button" type="button" onClick={onCreateTopic}>
          <Plus size={17} />
          {t("创建议题")}
        </button>
      </main>
    );
  }

  return (
    <>
      <DiscussionPanel
        projectName={workspace.project.name}
        topic={selectedTopic}
        participants={participants}
        sync={workspace.sync}
        isPublishing={actions.isPublishing}
        onPublish={actions.publish}
        orchestration={orch.orchestration}
        orchestrationBusyAction={orch.busyAction}
        workItemBusyAction={actions.workItemBusyAction}
        onGenerateWorkItems={actions.generateWorkItems}
        onAddWorkItem={actions.addWorkItem}
        onUpdateWorkItem={actions.updateWorkItem}
        onClaimWorkItem={actions.claimWorkItem}
        delegationAgents={orch.orchestration?.capabilities?.adapters ?? []}
        delegations={orch.workItemDelegations.delegations}
        delegationBusyAction={orch.workItemDelegations.busyAction}
        onDelegateWorkItems={actions.delegateWorkItems}
        isAccepting={content.isAccepting}
        onAccept={content.acceptDecisions}
        isRecordingManualDecision={content.isRecordingManualDecision}
        onRecordManualDecision={onOpenManualDecision}
        isClosingTopic={content.isClosingTopic}
        onCloseTopic={() => void content.closeTopic()}
        decisionFocusNonce={topicDecisionFocusNonce}
      />
      <InspectorPanel
        topic={selectedTopic}
        participants={participants}
        isRecordingManualDecision={content.isRecordingManualDecision}
        isOpen={isInspectorOpen}
        onRecordManualDecision={onOpenManualDecision}
        onOpenDecision={onFocusTopicDecision}
        onClose={onCloseInspector}
        orchestration={orch.orchestration}
        orchestrationBusyAction={orch.busyAction}
        onStartCycle={orch.startCycle}
        onAnswerCycleQuestion={orch.answerCycleQuestion}
        onSubmitFixes={orch.submitFixes}
        onAbandonCycle={orch.abandonCycle}
        onStartRun={(runId) => orch.runAction("start", runId)}
        onApproveRun={orch.approveRun}
        onCancelRun={(runId) => orch.runAction("cancel", runId)}
        onRecoverRun={(runId) => orch.runAction("recover", runId)}
        onCloseRuntimeBinding={(bindingId) => orch.runtimeBindingAction("close", bindingId)}
        onReopenRuntimeBinding={(bindingId) => orch.runtimeBindingAction("reopen", bindingId)}
      />
    </>
  );
}
