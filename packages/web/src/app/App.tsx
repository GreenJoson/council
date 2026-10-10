/**
 * @input  依赖：界面语言、Council/Orchestration Repository 工厂、hash 路由、主题/toast/桌面设置/内容/编排/议题写操作控制器、
 *         头部/侧栏/对话框/状态栏组件与 WorkspaceMain 视图分发
 * @output 导出：App 根组件（壳）
 * @pos    只做装配：创建仓储、串起各控制器、处理桌面首次设置/致命错误/加载中三种前置态，并把 activeView 交给 hash 路由；
 *         架构档案时间线点击某条 ADR 时通过 decisionFocus 通知决策记录视图定位；
 *         Composer 的 @claude/@codex 召唤语法糖由 use-topic-actions 的 publish 承接
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useMemo, useState } from "react";
import { CreateTopicDialog } from "../components/CreateTopicDialog";
import type { DecisionRecordFocusRequest } from "../components/DecisionRecordsView";
import { DesktopSetup } from "../components/DesktopSetup";
import { ProjectFilesProvider } from "../components/files/ProjectFilesProvider";
import { HeaderBar } from "../components/HeaderBar";
import { ManualDecisionDialog } from "../components/ManualDecisionDialog";
import { ModelRouterDialog } from "../components/ModelRouterDialog";
import { StatusBar } from "../components/StatusBar";
import { TopicSidebar } from "../components/TopicSidebar";
import { createOrchestrationRepository } from "../data/create-orchestration-repository";
import { createCouncilRepository } from "../data/create-repository";
import { isNativeCouncilRepository } from "../data/native-repository";
import { filterTopics, type TopicStatusFilter } from "../data/selectors";
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

export default function App() {
  const { t } = useI18n();
  const repository = useMemo(() => createCouncilRepository(), []);
  const orchestrationRepository = useMemo(() => createOrchestrationRepository(), []);
  const nativeRepository = isNativeCouncilRepository(repository) ? repository : undefined;
  const { route, navigate } = useWorkspaceRoute();
  const { themePreference, cycleTheme } = useThemePreference();
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
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TopicStatusFilter>("all");
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
  const [isModelRouterOpen, setIsModelRouterOpen] = useState(false);
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

  const visibleTopics = filterTopics(workspace.topics, searchQuery, statusFilter);
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

  // 议题视图且工作区没有任何议题，或其余单栏视图（合并中右两栏为单一全宽面板）时，
  // workspace-grid 都退化为「侧栏 + 单栏」两列布局，共用同一个修饰类
  const showsSingleColumn = route.view !== "discussion" || !selectedTopic;

  return (
    <ExecutionRepositoryContext.Provider value={orchestrationRepository}>
    <ProjectFilesProvider projectKey={`${desktopSettings?.logLibrary ?? ""}:${desktopSettings?.currentProjectPath ?? workspace.project.id}`}>
    <div className="app-shell">
      <HeaderBar project={workspace.project} sync={workspace.sync} searchQuery={searchQuery}
        themePreference={themePreference} onCycleTheme={cycleTheme} onSearchChange={setSearchQuery}
        onCreateTopic={() => setIsCreateDialogOpen(true)} onRetrySync={content.retrySync}
        onOpenTopics={() => setIsTopicsOpen(true)} onOpenInspector={() => setIsInspectorOpen(true)}
        onOpenSettings={() => setIsModelRouterOpen(true)} desktopSettings={desktopSettings ?? undefined}
        onChooseProject={chooseProject} onChooseLogLibrary={chooseLogs}
        onSelectRecentProject={desktop.selectRecentProject} />
      <div className={`workspace-grid ${showsSingleColumn ? "workspace-grid-full" : ""}`}>
        <TopicSidebar topics={visibleTopics} selectedTopicId={selectedTopic?.id ?? ""} isOpen={isTopicsOpen}
          statusFilter={statusFilter} activeView={route.view}
          onSelectView={(view) => navigate(view === "discussion"
            ? { view, topicId: content.activeTopicId || undefined }
            : { view })}
          onStatusFilterChange={setStatusFilter} onSelectTopic={openTopic}
          onClose={() => setIsTopicsOpen(false)} />
        <WorkspaceMain route={route} workspace={workspace} repository={repository}
          projectPath={desktopSettings?.currentProjectPath ?? undefined} content={content}
          orchestrationState={orch} topicActions={topicActions} decisionFocus={decisionFocus}
          topicDecisionFocusNonce={topicDecisionFocusNonce} isInspectorOpen={isInspectorOpen}
          onOpenTopic={openTopic} onOpenDecisionRecord={handleOpenDecisionRecord}
          onCreateTopic={() => setIsCreateDialogOpen(true)}
          onOpenManualDecision={() => setIsManualDecisionOpen(true)}
          onFocusTopicDecision={() => setTopicDecisionFocusNonce((current) => (current ?? 0) + 1)}
          onCloseInspector={() => setIsInspectorOpen(false)} />
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
      <ModelRouterDialog isOpen={isModelRouterOpen} repository={orchestrationRepository}
        onClose={() => setIsModelRouterOpen(false)} onChanged={orch.reloadCapabilities} />
      {recoverableErrorMessage ? (
        <RecoverableError message={recoverableErrorMessage} onRetry={handleRetryError}
          onClose={() => { content.setErrorMessage(null); orch.clearErrors(); }} />
      ) : null}
      {toastMessage ? <div className="toast" role="status">{toastMessage}</div> : null}
      <StatusBar />
    </div>
    </ProjectFilesProvider>
    </ExecutionRepositoryContext.Provider>
  );
}
