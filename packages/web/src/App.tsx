/**
 * @input  依赖：Council/Orchestration Repository、三栏组件和工作区领域模型
 * @output 导出：App Operator Console 根组件
 * @pos    协调内容与自动轮次的独立加载、选题、恢复和写操作状态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { LoaderCircle, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreateTopicDialog } from "./components/CreateTopicDialog";
import { DiscussionPanel } from "./components/DiscussionPanel";
import { HeaderBar } from "./components/HeaderBar";
import { InspectorPanel } from "./components/InspectorPanel";
import { TopicSidebar } from "./components/TopicSidebar";
import { createCouncilRepository } from "./data/create-repository";
import { createOrchestrationRepository } from "./data/create-orchestration-repository";
import { filterTopics } from "./data/selectors";
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
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
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

  useEffect(() => {
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
  }, [loadAttempt, repository]);

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

  if (contentErrorMessage && !workspace) {
    return (
      <FatalState
        message={contentErrorMessage}
        onRetry={() => {
          setContentErrorMessage(null);
          setLoadAttempt((current) => current + 1);
        }}
      />
    );
  }

  if (!workspace) {
    return <LoadingState />;
  }

  const visibleTopics = filterTopics(workspace.topics, searchQuery);
  const recoverableErrorMessage =
    capabilitiesErrorMessage ?? runsErrorMessage ?? contentErrorMessage;

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

  async function handleCreateTopic(input: CreateTopicInput): Promise<boolean> {
    setIsCreating(true);
    try {
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

  if (!selectedTopic) {
    return (
      <div className="app-shell">
        <HeaderBar
          project={workspace.project}
          sync={workspace.sync}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onCreateTopic={() => setIsCreateDialogOpen(true)}
          onRetrySync={handleRetrySync}
          onOpenTopics={() => setIsTopicsOpen(true)}
          onOpenInspector={() => setIsInspectorOpen(true)}
        />
        <div className="workspace-grid empty-workspace-grid">
          <TopicSidebar
            topics={visibleTopics}
            selectedTopicId=""
            isOpen={isTopicsOpen}
            onSelectTopic={(topicId) => void handleSelectTopic(topicId)}
            onClose={() => setIsTopicsOpen(false)}
          />
          <main className="empty-workspace" id="main-content">
            <h1>这个工作区还没有议题</h1>
            <p>创建第一个架构议题，Agent 的回复将写回同一条共享时间线。</p>
            <button className="primary-button" type="button" onClick={() => setIsCreateDialogOpen(true)}>
              <Plus size={17} />
              创建议题
            </button>
          </main>
        </div>
        <CreateTopicDialog
          isOpen={isCreateDialogOpen}
          isCreating={isCreating}
          onClose={() => setIsCreateDialogOpen(false)}
          onCreate={handleCreateTopic}
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
      </div>
    );
  }

  return (
    <div className="app-shell">
      <HeaderBar
        project={workspace.project}
        sync={workspace.sync}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onCreateTopic={() => setIsCreateDialogOpen(true)}
        onRetrySync={handleRetrySync}
        onOpenTopics={() => setIsTopicsOpen(true)}
        onOpenInspector={() => setIsInspectorOpen(true)}
      />
      <div className="workspace-grid">
        <TopicSidebar
          topics={visibleTopics}
          selectedTopicId={selectedTopic.id}
          isOpen={isTopicsOpen}
          onSelectTopic={(topicId) => void handleSelectTopic(topicId)}
          onClose={() => setIsTopicsOpen(false)}
        />
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
}

function FatalState({ message, onRetry }: FatalStateProps) {
  return (
    <main className="full-state">
      <TriangleAlert size={28} />
      <h1>无法加载 Council</h1>
      <p>{message}</p>
      <button className="primary-button" type="button" onClick={onRetry}>
        <RefreshCw size={17} />
        重试
      </button>
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
