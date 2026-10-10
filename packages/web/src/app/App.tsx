/**
 * @input  依赖：界面语言、Council/Orchestration/任务/流水线/资产 Repository 工厂、hash 路由、主题/toast/桌面设置/内容/编排/议题写操作控制器、
 *         features/tasks 与 features/pipelines 的列表 hook、图标栏/会话列表/对话框/状态栏组件与 WorkspaceMain 视图分发
 * @output 导出：App 根组件（壳）
 * @pos    只做装配：创建仓储、串起各控制器、处理桌面首次设置/致命错误/加载中三种前置态，并把路由交给 hash；
 *         V2 壳为「图标栏 + 会话列表 + 主区（讨论 + 可收起的上下文栏）」，会话列表同时露出任务与流水线，
 *         任务/流水线新建对话框在壳层渲染以便从编辑器一键切换并带入草稿；
 *         架构档案时间线点击某条 ADR 时通过 decisionFocus 通知决策记录视图定位；
 *         Composer 的 @claude/@codex 召唤语法糖由 use-topic-actions 的 publish 承接
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useMemo, useState } from "react";
import { ConversationList } from "../components/ConversationList";
import { CreateTopicDialog } from "../features/discussion/CreateTopicDialog";
import type { DecisionRecordFocusRequest } from "../features/decisions/DecisionRecordsView";
import { DesktopSetup } from "../components/DesktopSetup";
import { ProjectFilesProvider } from "../components/files/ProjectFilesProvider";
import { ManualDecisionDialog } from "../features/discussion/ManualDecisionDialog";
import { ModelRouterDialog } from "../components/ModelRouterDialog";
import { NavRail } from "../components/NavRail";
import { PreferencesDialog } from "../components/PreferencesDialog";
import { StatusBar } from "../components/StatusBar";
import { createAssetRepository } from "../data/assets/create-asset-repository";
import { createOrchestrationRepository } from "../data/create-orchestration-repository";
import { createCouncilRepository } from "../data/create-repository";
import { isNativeCouncilRepository } from "../data/native-repository";
import { createPipelineRepository } from "../data/pipelines/create-pipeline-repository";
import { filterTopics } from "../data/selectors";
import { createTaskRepository } from "../data/tasks/create-task-repository";
import { PipelineCreateDialog } from "../features/pipelines/PipelineCreateDialog";
import { usePipelines } from "../features/pipelines/use-pipelines";
import { TaskCreateDialog } from "../features/tasks/TaskCreateDialog";
import { useTasks } from "../features/tasks/use-tasks";
import { ExecutionRepositoryContext } from "../hooks/useExecutionRepository";
import { useI18n } from "../i18n/I18nProvider";
import { FatalState, LoadingState, RecoverableError } from "./app-states";
import { useDesktopSettings } from "./use-desktop-settings";
import { useOrchestrationState } from "./use-orchestration-state";
import { useThemePreference } from "./use-theme-preference";
import { useToast } from "./use-toast";
import { useTopicActions } from "./use-topic-actions";
import { useTopicRouteSync } from "./use-topic-route-sync";
import { useWorkspaceContent } from "./use-workspace-content";
import { useWorkspaceRoute } from "./use-workspace-route";
import { WorkspaceMain } from "./WorkspaceMain";

/** 编辑器草稿转成任务标题：只取第一行并截到标题上限，正文留给用户在对话框里补。 */
function draftTitle(draft: string | null): string | undefined {
  if (draft === null) {
    return undefined;
  }
  return draft.split(/\r?\n/, 1)[0]?.trim().slice(0, 200) ?? "";
}

export default function App() {
  const { t } = useI18n();
  const repository = useMemo(() => createCouncilRepository(), []);
  const orchestrationRepository = useMemo(() => createOrchestrationRepository(), []);
  const taskRepository = useMemo(() => createTaskRepository(), []);
  const pipelineRepository = useMemo(() => createPipelineRepository(), []);
  const assetRepository = useMemo(() => createAssetRepository(), []);
  const nativeRepository = isNativeCouncilRepository(repository) ? repository : undefined;
  const { route, navigate } = useWorkspaceRoute();
  const { themePreference, setThemePreference } = useThemePreference();
  const [toastMessage, setToastMessage] = useToast();
  // content 在下一行才声明；回调只在桌面切换项目成功后的事件里调用，届时已初始化
  const desktop = useDesktopSettings(nativeRepository, () => content.resetWorkspace());
  const content = useWorkspaceContent({ repository, nativeRepository, desktop, setToastMessage });
  const orch = useOrchestrationState(orchestrationRepository, content.activeTopicId, setToastMessage);
  const topicActions = useTopicActions({
    repository, orchestrationRepository, content, orchestrationState: orch, setToastMessage,
  });
  const { openTopic } = useTopicRouteSync({
    route, navigate, workspace: content.workspace,
    activeTopicId: content.activeTopicId, selectTopic: content.selectTopic,
  });
  // 会话列表里的任务/流水线行：工作区快照或编排 revision 变化即重读，失败只是不显示，不打断主流程
  const executionRevision = orch.orchestration?.revision;
  const taskStream = useTasks(taskRepository, {}, content.workspace, executionRevision);
  const pipelineStream = usePipelines(pipelineRepository, content.workspace, executionRevision);
  const [searchQuery, setSearchQuery] = useState("");
  const [decisionFocus, setDecisionFocus] = useState<DecisionRecordFocusRequest | null>(null);
  /*
   * 右栏「查看全文」→ 主列「决策」tab。递增 nonce 而不是布尔量：同一议题里反复点也要
   * 每次都生效，而 undefined 表示"从未请求过"，开局不会抢走讨论 tab。
   */
  const [topicDecisionFocusNonce, setTopicDecisionFocusNonce] = useState<number | undefined>(undefined);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isManualDecisionOpen, setIsManualDecisionOpen] = useState(false);
  const [isTopicsOpen, setIsTopicsOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [isContextCollapsed, setIsContextCollapsed] = useState(false);
  const [isModelRouterOpen, setIsModelRouterOpen] = useState(false);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  // null = 对话框关闭；字符串 = 从编辑器带来的草稿（可为空串）
  const [taskDraft, setTaskDraft] = useState<string | null>(null);
  const [pipelineDraft, setPipelineDraft] = useState<string | null>(null);
  const { workspace, selectedTopic } = content;
  const desktopSettings = desktop.settings;
  const chooseLogs = () => desktop.choose("logs");
  const chooseProject = () => desktop.choose("project");

  if (nativeRepository && !desktop.loaded) {
    return <LoadingState />;
  }
  if (!desktop.ready) {
    return (
      <DesktopSetup hasLogLibrary={Boolean(desktopSettings?.logLibrary)}
        hasProject={Boolean(desktopSettings?.currentProjectPath)} busyAction={desktop.busyAction}
        errorMessage={desktop.errorMessage} onChooseLogLibrary={chooseLogs} onChooseProject={chooseProject} />
    );
  }
  if (content.errorMessage && !workspace) {
    return (
      <FatalState message={desktop.errorMessage ?? content.errorMessage} onRetry={content.retryLoad}
        busyAction={desktop.busyAction} onChooseLogLibrary={nativeRepository ? chooseLogs : undefined}
        onChooseProject={nativeRepository ? chooseProject : undefined} />
    );
  }
  if (!workspace) {
    return <LoadingState />;
  }

  const visibleTopics = filterTopics(workspace.topics, searchQuery);
  const delegationAgents = orch.orchestration?.capabilities?.adapters ?? [];
  const recoverableErrorMessage =
    orch.capabilitiesErrorMessage ?? orch.runsErrorMessage ?? content.errorMessage;

  function handleRetryError(): void {
    if (orch.capabilitiesErrorMessage) {
      orch.retryCapabilities();
    } else if (orch.runsErrorMessage) {
      orch.retryRuns();
    } else {
      content.retrySync();
    }
  }

  /**
   * 架构档案时间线的已决策条目（含"已被 ADR-xxx 取代"徽章）跳转到决策记录视图并定位到
   * 对应条目；nonce 递增而不是只传 topicId，保证重复点击同一条 ADR 也能重新触发定位
   * （DecisionRecordsView 的 focusRequest 依赖对象引用变化，不比较 topicId 是否相同）。
   */
  function handleOpenDecisionRecord(topicId: string): void {
    navigate({ view: "decisions" });
    setDecisionFocus((current) => ({ topicId, nonce: (current?.nonce ?? 0) + 1 }));
  }

  // 议题视图且工作区没有任何议题、其余单栏视图，或用户收起了上下文栏时，
  // 主区都退化为单栏（讨论列独占），共用同一个修饰类
  const showsSingleColumn = route.view !== "discussion" || !selectedTopic || isContextCollapsed;

  return (
    <ExecutionRepositoryContext.Provider value={orchestrationRepository}>
    <ProjectFilesProvider projectKey={`${desktopSettings?.logLibrary ?? ""}:${desktopSettings?.currentProjectPath ?? workspace.project.id}`}>
    <div className="app-shell">
      <NavRail activeView={route.view} activeTopicId={content.activeTopicId || undefined}
        activeAgentCount={orch.orchestration?.activity?.activeAgents}
        attentionCount={orch.orchestration?.activity?.attention}
        onNavigate={navigate} onOpenTopics={() => setIsTopicsOpen(true)}
        onOpenPreferences={() => setIsPreferencesOpen(true)}
        onOpenSettings={() => setIsModelRouterOpen(true)} />
      <ConversationList project={workspace.project} topics={visibleTopics} tasks={taskStream.tasks}
        pipelines={pipelineStream.pipelines} route={route} selectedTopicId={selectedTopic?.id ?? ""}
        isOpen={isTopicsOpen} searchQuery={searchQuery} desktopSettings={desktopSettings ?? undefined}
        onSearchChange={setSearchQuery} onNavigate={navigate} onSelectTopic={openTopic}
        onCreateTopic={() => setIsCreateDialogOpen(true)} onClose={() => setIsTopicsOpen(false)}
        onChooseProject={chooseProject} onChooseLogLibrary={chooseLogs}
        onSelectRecentProject={desktop.selectRecentProject} />
      <div className={`workspace-grid ${showsSingleColumn ? "workspace-grid-full" : ""}`}>
        <WorkspaceMain route={route} workspace={workspace} repository={repository}
          projectPath={desktopSettings?.currentProjectPath ?? undefined} content={content}
          orchestrationState={orch} topicActions={topicActions} decisionFocus={decisionFocus}
          topicDecisionFocusNonce={topicDecisionFocusNonce} isInspectorOpen={isInspectorOpen}
          isContextCollapsed={isContextCollapsed}
          onOpenTopic={openTopic} onOpenDecisionRecord={handleOpenDecisionRecord}
          onCreateTopic={() => setIsCreateDialogOpen(true)}
          onOpenManualDecision={() => setIsManualDecisionOpen(true)}
          onFocusTopicDecision={() => setTopicDecisionFocusNonce((current) => (current ?? 0) + 1)}
          onOpenInspector={() => setIsInspectorOpen(true)}
          onToggleContext={() => setIsContextCollapsed((current) => !current)}
          onCloseInspector={() => setIsInspectorOpen(false)}
          onOpenTaskCreate={setTaskDraft} onOpenPipelineCreate={setPipelineDraft} />
      </div>
      {(isTopicsOpen || isInspectorOpen) ? (
        <button className="panel-scrim" type="button" aria-label={t("关闭侧边面板")}
          onClick={() => { setIsTopicsOpen(false); setIsInspectorOpen(false); }} />
      ) : null}
      <CreateTopicDialog isOpen={isCreateDialogOpen} isCreating={content.isCreating}
        onClose={() => setIsCreateDialogOpen(false)}
        onCreate={(input, targetProjectPath) =>
          content.createTopic(input, targetProjectPath, () => setIsCreateDialogOpen(false))}
        desktopSettings={desktopSettings ?? undefined} isBrowsingProject={desktop.busyAction === "project"}
        onBrowseProject={nativeRepository ? () => desktop.choose("project", { keepWorkspace: true }) : undefined} />
      <ManualDecisionDialog isOpen={isManualDecisionOpen} isRecording={content.isRecordingManualDecision}
        topicTitle={selectedTopic?.title ?? ""}
        onClose={() => { if (!content.isRecordingManualDecision) setIsManualDecisionOpen(false); }}
        onRecord={content.recordManualDecision} />
      {/* 任务/流水线视图各自也挂着同名对话框；壳层这份只在有草稿时挂载，避免关闭态的 <dialog> 重复留在 DOM 里 */}
      {taskDraft !== null ? (
        <TaskCreateDialog isOpen repository={taskRepository}
          initialTitle={draftTitle(taskDraft)} onClose={() => setTaskDraft(null)}
          onCreated={(task) => { setTaskDraft(null); navigate({ view: "tasks", taskId: task.id }); }} />
      ) : null}
      {pipelineDraft !== null ? (
        <PipelineCreateDialog isOpen repository={pipelineRepository}
          assetRepository={assetRepository} agents={delegationAgents}
          initialGoal={pipelineDraft} onClose={() => setPipelineDraft(null)}
          onCreated={(detail) => {
            setPipelineDraft(null);
            navigate({ view: "pipelines", pipelineId: detail.task.id });
          }} />
      ) : null}
      <PreferencesDialog isOpen={isPreferencesOpen} themePreference={themePreference}
        onThemeChange={setThemePreference} onClose={() => setIsPreferencesOpen(false)} />
      <ModelRouterDialog isOpen={isModelRouterOpen} repository={orchestrationRepository}
        onClose={() => setIsModelRouterOpen(false)} onChanged={orch.reloadCapabilities} />
      {recoverableErrorMessage ? (
        <RecoverableError message={recoverableErrorMessage} onRetry={handleRetryError}
          onClose={() => { content.setErrorMessage(null); orch.clearErrors(); }} />
      ) : null}
      {toastMessage ? <div className="toast" role="status">{toastMessage}</div> : null}
      <StatusBar sync={workspace.sync} onRetrySync={content.retrySync}
        activeAgents={orch.orchestration?.activity?.activeAgents} />
    </div>
    </ProjectFilesProvider>
    </ExecutionRepositoryContext.Provider>
  );
}
