/**
 * @input  依赖：Council/Orchestration Repository、主题偏好、工作区视图路由（议题/架构档案/决策记录）和三栏组件
 * @output 导出：App Operator Console 根组件
 * @pos    协调内容与自动轮次的独立加载、选题、筛选、工作区视图切换、恢复和写操作状态；
 *         架构档案时间线点击某条 ADR 时通过 decisionFocus 状态通知决策记录视图定位
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Database,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArchitectureView } from "./components/ArchitectureView";
import { CreateTopicDialog } from "./components/CreateTopicDialog";
import { DecisionRecordsView, type DecisionRecordFocusRequest } from "./components/DecisionRecordsView";
import { DesktopSetup } from "./components/DesktopSetup";
import { DiscussionPanel } from "./components/DiscussionPanel";
import { HeaderBar } from "./components/HeaderBar";
import { InspectorPanel } from "./components/InspectorPanel";
import { TopicSidebar, type WorkspaceView } from "./components/TopicSidebar";
import { createCouncilRepository } from "./data/create-repository";
import { createOrchestrationRepository } from "./data/create-orchestration-repository";
import type { DesktopSettings } from "./data/desktop-bridge";
import { isNativeCouncilRepository } from "./data/native-repository";
import { filterTopics, type TopicStatusFilter } from "./data/selectors";
import {
  applyThemePreference,
  resolveInitialPreference,
  watchSystemTheme,
  type ThemePreference,
} from "./data/theme";
import type {
  CreateTopicInput,
  MessageKind,
  Participant,
  WorkspaceSnapshot,
} from "./types/council";
import type {
  OrchestrationMessageKind,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "./types/orchestration";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

export default function App() {
  const repository = useMemo(() => createCouncilRepository(), []);
  const orchestrationRepository = useMemo(() => createOrchestrationRepository(), []);
  const nativeRepository = isNativeCouncilRepository(repository) ? repository : undefined;
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TopicStatusFilter>("all");
  const [activeView, setActiveView] = useState<WorkspaceView>("topics");
  const [decisionFocus, setDecisionFocus] = useState<DecisionRecordFocusRequest | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(resolveInitialPreference);

  // 跟随系统时监听操作系统深浅色变化并实时重放到根节点
  useEffect(() => {
    if (themePreference !== "system") {
      return;
    }
    return watchSystemTheme(() => applyThemePreference("system"));
  }, [themePreference]);
  const [contentErrorMessage, setContentErrorMessage] = useState<string | null>(null);
  const [capabilitiesErrorMessage, setCapabilitiesErrorMessage] = useState<string | null>(null);
  const [runsErrorMessage, setRunsErrorMessage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isTopicsOpen, setIsTopicsOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [capabilitiesLoadAttempt, setCapabilitiesLoadAttempt] = useState(0);
  const [runsLoadAttempt, setRunsLoadAttempt] = useState(0);
  const [orchestration, setOrchestration] = useState<OrchestrationSnapshot | null>(null);
  const [orchestrationBusyAction, setOrchestrationBusyAction] = useState<string | null>(null);
  const selectionRequestId = useRef(0);
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(null);
  const [desktopSettingsLoaded, setDesktopSettingsLoaded] = useState(!nativeRepository);
  const [desktopBusyAction, setDesktopBusyAction] = useState<"logs" | "project" | null>(null);
  const [desktopErrorMessage, setDesktopErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!nativeRepository) {
      return;
    }
    let active = true;
    void nativeRepository.getDesktopSettings()
      .then((settings) => {
        if (active) {
          setDesktopSettings(settings);
          setDesktopSettingsLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setDesktopErrorMessage(getErrorMessage(error));
          setDesktopSettingsLoaded(true);
        }
      });
    return () => { active = false; };
  }, [nativeRepository]);

  useEffect(() => {
    if (nativeRepository && (!desktopSettings?.logLibrary || !desktopSettings.currentProjectPath)) {
      return;
    }
    let active = true;
    const unsubscribe = repository.subscribe((snapshot) => {
      if (active) {
        setWorkspace(snapshot);
        if (snapshot.activeTopicId) {
          setSelectedTopicId(snapshot.activeTopicId);
        }
        if (snapshot.sync.status === "connected") {
          setContentErrorMessage(null);
        }
      }
    });
    void repository
      .loadWorkspace()
      .then((snapshot) => {
        if (!active) {
          return;
        }
        setWorkspace(snapshot);
        setContentErrorMessage(null);
        setSelectedTopicId((current) =>
          (snapshot.activeTopicId ?? current) || snapshot.topics[0]?.id || ""
        );
      })
      .catch((error: unknown) => {
        if (active) {
          setContentErrorMessage(getErrorMessage(error));
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktopSettings?.currentProjectPath, desktopSettings?.logLibrary, loadAttempt, nativeRepository, repository]);

  useEffect(() => {
    let active = true;
    const unsubscribe = orchestrationRepository.subscribe((snapshot) => {
      if (active) {
        setOrchestration(snapshot);
      }
    });
    void orchestrationRepository.loadCapabilities()
      .then((snapshot) => {
        if (active) {
          setOrchestration(snapshot);
          setCapabilitiesErrorMessage(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setCapabilitiesErrorMessage(getErrorMessage(error));
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [capabilitiesLoadAttempt, orchestrationRepository]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const timeoutId = window.setTimeout(() => setToastMessage(null), 2800);
    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  const participants = useMemo(
    () => new Map<string, Participant>(workspace?.participants.map((item) => [item.id, item]) ?? []),
    [workspace],
  );
  const selectedTopic = workspace
    ? workspace.topics.find((topic) => topic.id === selectedTopicId) ?? workspace.topics[0]
    : undefined;
  const activeTopicId = selectedTopic?.id ?? "";

  useEffect(() => {
    if (!activeTopicId) {
      return;
    }
    let active = true;
    void orchestrationRepository.selectTopic(activeTopicId)
      .then((snapshot) => {
        if (active) {
          setOrchestration(snapshot);
          setRunsErrorMessage(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setRunsErrorMessage(getErrorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [activeTopicId, orchestrationRepository, runsLoadAttempt]);

  if (nativeRepository && !desktopSettingsLoaded) {
    return <LoadingState />;
  }

  if (
    nativeRepository
    && (!desktopSettings?.logLibrary || !desktopSettings.currentProjectPath)
  ) {
    return (
      <DesktopSetup
        hasLogLibrary={Boolean(desktopSettings?.logLibrary)}
        hasProject={Boolean(desktopSettings?.currentProjectPath)}
        busyAction={desktopBusyAction}
        errorMessage={desktopErrorMessage}
        onChooseLogLibrary={() => handleDesktopSelection("logs")}
        onChooseProject={() => handleDesktopSelection("project")}
      />
    );
  }

  if (contentErrorMessage && !workspace) {
    return (
      <FatalState
        message={desktopErrorMessage ?? contentErrorMessage}
        onRetry={() => {
          setContentErrorMessage(null);
          setLoadAttempt((current) => current + 1);
        }}
        busyAction={desktopBusyAction}
        onChooseLogLibrary={nativeRepository
          ? () => handleDesktopSelection("logs")
          : undefined}
        onChooseProject={nativeRepository
          ? () => handleDesktopSelection("project")
          : undefined}
      />
    );
  }

  if (!workspace) {
    return <LoadingState />;
  }

  const visibleTopics = filterTopics(workspace.topics, searchQuery, statusFilter);
  const recoverableErrorMessage =
    capabilitiesErrorMessage ?? runsErrorMessage ?? contentErrorMessage;

  function handleCycleTheme(): void {
    setThemePreference((current) => {
      const next: ThemePreference =
        current === "light" ? "dark" : current === "dark" ? "system" : "light";
      applyThemePreference(next);
      return next;
    });
  }

  async function handleDesktopSelection(
    action: "logs" | "project",
    options?: { keepWorkspace?: boolean },
  ): Promise<void> {
    if (!nativeRepository) {
      return;
    }
    setDesktopBusyAction(action);
    setDesktopErrorMessage(null);
    try {
      const settings = action === "logs"
        ? await nativeRepository.chooseLogLibrary()
        : await nativeRepository.chooseProject();
      if (settings) {
        setDesktopSettings(settings);
        // keepWorkspace：新建议题对话框内浏览目录时不清空工作区，
        // 避免对话框被卸载丢失草稿；工作区会因项目路径变化自动重载
        if (!options?.keepWorkspace && settings.logLibrary && settings.currentProjectPath) {
          setWorkspace(null);
          setLoadAttempt((current) => current + 1);
        }
      }
    } catch (error: unknown) {
      setDesktopErrorMessage(getErrorMessage(error));
    } finally {
      setDesktopBusyAction(null);
    }
  }

  async function handleRecentProject(path: string): Promise<void> {
    if (!nativeRepository) {
      return;
    }
    setDesktopBusyAction("project");
    try {
      const settings = await nativeRepository.selectRecentProject(path);
      setDesktopSettings(settings);
      setWorkspace(null);
      setLoadAttempt((current) => current + 1);
    } catch (error: unknown) {
      setDesktopErrorMessage(getErrorMessage(error));
    } finally {
      setDesktopBusyAction(null);
    }
  }

  function handleRetrySync(): void {
    setContentErrorMessage(null);
    void repository
      .loadWorkspace()
      .then(() => setContentErrorMessage(null))
      .catch((error: unknown) => setContentErrorMessage(getErrorMessage(error)));
  }

  function handleRetryError(): void {
    if (capabilitiesErrorMessage) {
      setCapabilitiesErrorMessage(null);
      setCapabilitiesLoadAttempt((current) => current + 1);
      return;
    }
    if (runsErrorMessage) {
      setRunsErrorMessage(null);
      setRunsLoadAttempt((current) => current + 1);
      return;
    }
    handleRetrySync();
  }

  async function handleSelectTopic(topicId: string): Promise<void> {
    if (topicId === activeTopicId) {
      return;
    }
    const requestId = ++selectionRequestId.current;
    setContentErrorMessage(null);
    try {
      const snapshot = await repository.selectTopic(topicId);
      if (requestId !== selectionRequestId.current) {
        return;
      }
      setWorkspace(snapshot);
      setSelectedTopicId(topicId);
    } catch (error: unknown) {
      if (requestId === selectionRequestId.current) {
        setContentErrorMessage(getErrorMessage(error));
      }
    }
  }

  /** 架构档案时间线、决策记录"在讨论中打开"和侧栏议题列表共用：切回议题视图并选中该议题 */
  async function handleOpenTopic(topicId: string): Promise<void> {
    setActiveView("topics");
    await handleSelectTopic(topicId);
  }

  /**
   * 架构档案时间线的已决策条目（含"已被 ADR-xxx 取代"徽章）跳转到决策记录视图并定位到
   * 对应条目；nonce 递增而不是只传 topicId，保证重复点击同一条 ADR 也能重新触发定位
   * （DecisionRecordsView 的 focusRequest 依赖对象引用变化，不比较 topicId 是否相同）。
   */
  function handleOpenDecisionRecord(topicId: string): void {
    setActiveView("decisions");
    setDecisionFocus((current) => ({ topicId, nonce: (current?.nonce ?? 0) + 1 }));
  }

  async function handlePublish(kind: MessageKind, content: string): Promise<boolean> {
    setIsPublishing(true);
    setContentErrorMessage(null);
    try {
      await repository.publishMessage({
        topicId: activeTopicId,
        author: "user",
        kind,
        content,
      });
      setToastMessage("回复已发布并同步");
      return true;
    } catch (error: unknown) {
      setContentErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleAccept(): Promise<void> {
    setIsAccepting(true);
    try {
      await repository.acceptDecision(activeTopicId);
      setToastMessage("决策已记录为 Accepted");
    } catch (error: unknown) {
      setContentErrorMessage(getErrorMessage(error));
    } finally {
      setIsAccepting(false);
    }
  }

  async function handleCreateTopic(
    input: CreateTopicInput,
    targetProjectPath?: string,
  ): Promise<boolean> {
    setIsCreating(true);
    try {
      // 目标项目 ≠ 当前项目时，先切换项目再创建，保证议题写入所选项目
      if (
        nativeRepository
        && targetProjectPath
        && targetProjectPath !== desktopSettings?.currentProjectPath
      ) {
        const settings = await nativeRepository.selectRecentProject(targetProjectPath);
        setDesktopSettings(settings);
      }
      const snapshot = await repository.createTopic(input);
      const createdTopicId = snapshot.activeTopicId ?? snapshot.topics[0]?.id;
      if (createdTopicId) {
        setSelectedTopicId(createdTopicId);
      }
      setIsCreateDialogOpen(false);
      setToastMessage("新议题已创建并同步");
      return true;
    } catch (error: unknown) {
      setContentErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setIsCreating(false);
    }
  }

  async function handleCreateAndStartRun(
    adapterId: string,
    messageKind: OrchestrationMessageKind,
    instruction: string,
  ): Promise<boolean> {
    setOrchestrationBusyAction("create");
    setRunsErrorMessage(null);
    try {
      const created = await orchestrationRepository.createRun({
        topicId: activeTopicId,
        plan: [{ adapterId, messageKind, instruction }],
      });
      setOrchestrationBusyAction(`start:${created.id}`);
      const snapshot = await orchestrationRepository.startRun(created.id);
      setOrchestration(snapshot);
      setToastMessage("自动轮次已创建并启动");
      return true;
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setOrchestrationBusyAction(null);
    }
  }

  async function handleRunAction(
    action: "start" | "cancel" | "recover",
    runId: string,
  ): Promise<void> {
    setOrchestrationBusyAction(`${action}:${runId}`);
    setRunsErrorMessage(null);
    try {
      const snapshot = action === "start"
        ? await orchestrationRepository.startRun(runId)
        : action === "cancel"
          ? await orchestrationRepository.cancelRun(runId)
          : await orchestrationRepository.recoverRun(runId);
      setOrchestration(snapshot);
      setToastMessage(
        action === "cancel" ? "自动轮次已取消" : action === "recover" ? "恢复已提交" : "自动轮次已启动",
      );
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
    } finally {
      setOrchestrationBusyAction(null);
    }
  }

  async function handleApproveRun(run: OrchestrationRun): Promise<void> {
    if (!run.pendingGateId) {
      return;
    }
    setOrchestrationBusyAction(`approve:${run.id}`);
    setRunsErrorMessage(null);
    try {
      const snapshot = await orchestrationRepository.approveRun({
        runId: run.id,
        expectedGateId: run.pendingGateId,
        expectedVersion: run.version,
        approvalId: crypto.randomUUID(),
      });
      setOrchestration(snapshot);
      setToastMessage("确认已提交，自动轮次继续");
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
    } finally {
      setOrchestrationBusyAction(null);
    }
  }

  const closeResponsivePanels = () => {
    setIsTopicsOpen(false);
    setIsInspectorOpen(false);
  };

  // 议题视图且工作区没有任何议题，或架构档案/决策记录视图（合并中右两栏为单一全宽面板）时，
  // workspace-grid 都退化为「侧栏 + 单栏」两列布局，共用同一个修饰类
  const showsSingleColumn = activeView !== "topics" || !selectedTopic;

  return (
    <div className="app-shell">
      <HeaderBar
        project={workspace.project}
        sync={workspace.sync}
        searchQuery={searchQuery}
        themePreference={themePreference}
        onCycleTheme={handleCycleTheme}
        onSearchChange={setSearchQuery}
        onCreateTopic={() => setIsCreateDialogOpen(true)}
        onRetrySync={handleRetrySync}
        onOpenTopics={() => setIsTopicsOpen(true)}
        onOpenInspector={() => setIsInspectorOpen(true)}
        desktopSettings={desktopSettings ?? undefined}
        onChooseProject={() => handleDesktopSelection("project")}
        onChooseLogLibrary={() => handleDesktopSelection("logs")}
        onSelectRecentProject={handleRecentProject}
      />
      <div className={`workspace-grid ${showsSingleColumn ? "workspace-grid-full" : ""}`}>
        <TopicSidebar
          topics={visibleTopics}
          selectedTopicId={selectedTopic?.id ?? ""}
          isOpen={isTopicsOpen}
          statusFilter={statusFilter}
          activeView={activeView}
          onSelectView={setActiveView}
          onStatusFilterChange={setStatusFilter}
          onSelectTopic={(topicId) => void handleOpenTopic(topicId)}
          onClose={() => setIsTopicsOpen(false)}
        />
        {activeView === "architecture" ? (
          <ArchitectureView
            projectName={workspace.project.name}
            projectPath={desktopSettings?.currentProjectPath ?? undefined}
            topics={workspace.topics}
            participants={participants}
            onLoadDetail={(topicId) => repository.loadTopicDetail(topicId)}
            onOpenTopic={(topicId) => void handleOpenTopic(topicId)}
            onOpenDecisionRecord={handleOpenDecisionRecord}
            onCreateTopic={() => setIsCreateDialogOpen(true)}
          />
        ) : activeView === "decisions" ? (
          <DecisionRecordsView
            topics={workspace.topics}
            participants={participants}
            onLoadDetail={(topicId) => repository.loadTopicDetail(topicId)}
            onOpenTopic={(topicId) => void handleOpenTopic(topicId)}
            focusRequest={decisionFocus}
          />
        ) : selectedTopic ? (
          <>
            <DiscussionPanel
              topic={selectedTopic}
              participants={participants}
              sync={workspace.sync}
              isPublishing={isPublishing}
              onPublish={handlePublish}
            />
            <InspectorPanel
              topic={selectedTopic}
              participants={participants}
              isAccepting={isAccepting}
              isOpen={isInspectorOpen}
              onAccept={handleAccept}
              onClose={() => setIsInspectorOpen(false)}
              orchestration={orchestration}
              orchestrationBusyAction={orchestrationBusyAction}
              onCreateAndStartRun={handleCreateAndStartRun}
              onStartRun={(runId) => handleRunAction("start", runId)}
              onApproveRun={handleApproveRun}
              onCancelRun={(runId) => handleRunAction("cancel", runId)}
              onRecoverRun={(runId) => handleRunAction("recover", runId)}
            />
          </>
        ) : (
          <main className="empty-workspace" id="main-content">
            <h1>这个工作区还没有议题</h1>
            <p>创建第一个架构议题，Agent 的回复将写回同一条共享时间线。</p>
            <button className="primary-button" type="button" onClick={() => setIsCreateDialogOpen(true)}>
              <Plus size={17} />
              创建议题
            </button>
          </main>
        )}
      </div>
      {(isTopicsOpen || isInspectorOpen) ? (
        <button
          className="panel-scrim"
          type="button"
          aria-label="关闭侧边面板"
          onClick={closeResponsivePanels}
        />
      ) : null}
      <CreateTopicDialog
        isOpen={isCreateDialogOpen}
        isCreating={isCreating}
        onClose={() => setIsCreateDialogOpen(false)}
        onCreate={handleCreateTopic}
        desktopSettings={desktopSettings ?? undefined}
        isBrowsingProject={desktopBusyAction === "project"}
        onBrowseProject={nativeRepository
          ? () => handleDesktopSelection("project", { keepWorkspace: true })
          : undefined}
      />
      {recoverableErrorMessage ? (
        <RecoverableError
          message={recoverableErrorMessage}
          onRetry={handleRetryError}
          onClose={() => {
            setContentErrorMessage(null);
            setCapabilitiesErrorMessage(null);
            setRunsErrorMessage(null);
          }}
        />
      ) : null}
      {toastMessage ? <div className="toast" role="status">{toastMessage}</div> : null}
    </div>
  );
}

interface RecoverableErrorProps {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}

function RecoverableError({ message, onRetry, onClose }: RecoverableErrorProps) {
  return (
    <div className="error-banner" role="alert">
      <TriangleAlert size={17} />
      <span>{message}</span>
      <button className="secondary-button" type="button" onClick={onRetry}>
        <RefreshCw size={15} />
        重试
      </button>
      <button className="icon-button compact" type="button" aria-label="关闭错误提示" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

interface FatalStateProps {
  message: string;
  onRetry: () => void;
  busyAction?: "logs" | "project" | null;
  onChooseLogLibrary?: () => Promise<void>;
  onChooseProject?: () => Promise<void>;
}

function FatalState({
  message,
  onRetry,
  busyAction,
  onChooseLogLibrary,
  onChooseProject,
}: FatalStateProps) {
  return (
    <main className="full-state">
      <TriangleAlert size={28} />
      <h1>无法加载 Council</h1>
      <p>{message}</p>
      <div className="full-state-actions">
        <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={onRetry}>
          <RefreshCw size={17} />
          重试
        </button>
        {onChooseLogLibrary ? (
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void onChooseLogLibrary()}
          >
            {busyAction === "logs" ? <LoaderCircle className="spinner" size={17} /> : <Database size={17} />}
            重选日志库
          </button>
        ) : null}
        {onChooseProject ? (
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void onChooseProject()}
          >
            {busyAction === "project" ? <LoaderCircle className="spinner" size={17} /> : <FolderOpen size={17} />}
            重选项目
          </button>
        ) : null}
      </div>
    </main>
  );
}

function LoadingState() {
  return (
    <main className="full-state" aria-busy="true">
      <LoaderCircle className="spinner" size={28} />
      <h1>正在连接 Council</h1>
      <p>加载 Operator Console 工作区…</p>
    </main>
  );
}
