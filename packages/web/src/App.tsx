/**
 * @input  依赖：CouncilRepository、三栏组件和工作区领域模型
 * @output 导出：App Operator Console 根组件
 * @pos    协调加载、选择、发帖、建议题和决策状态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CreateTopicDialog } from "./components/CreateTopicDialog";
import { DiscussionPanel } from "./components/DiscussionPanel";
import { HeaderBar } from "./components/HeaderBar";
import { InspectorPanel } from "./components/InspectorPanel";
import { TopicSidebar } from "./components/TopicSidebar";
import { createCouncilRepository } from "./data/create-repository";
import { filterTopics } from "./data/selectors";
import type {
  CreateTopicInput,
  MessageKind,
  Participant,
  WorkspaceSnapshot,
} from "./types/council";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

export default function App() {
  const repository = useMemo(() => createCouncilRepository(), []);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isTopicsOpen, setIsTopicsOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = repository.subscribe((snapshot) => {
      if (active) {
        setWorkspace(snapshot);
      }
    });
    void repository
      .loadWorkspace()
      .then((snapshot) => {
        if (!active) {
          return;
        }
        setWorkspace(snapshot);
        setSelectedTopicId((current) => current || snapshot.topics[0]?.id || "");
      })
      .catch((error: unknown) => {
        if (active) {
          setErrorMessage(getErrorMessage(error));
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [repository]);

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

  if (errorMessage) {
    return <FatalState message={errorMessage} onRetry={() => window.location.reload()} />;
  }

  if (!workspace) {
    return <LoadingState />;
  }

  const selectedTopic =
    workspace.topics.find((topic) => topic.id === selectedTopicId) ?? workspace.topics[0];

  if (!selectedTopic) {
    return <FatalState message="当前工作区没有可显示的议题" onRetry={() => setIsCreateDialogOpen(true)} />;
  }

  const visibleTopics = filterTopics(workspace.topics, searchQuery);
  const activeTopicId = selectedTopic.id;

  async function handlePublish(kind: MessageKind, content: string): Promise<void> {
    setIsPublishing(true);
    setErrorMessage(null);
    try {
      await repository.publishMessage({
        topicId: activeTopicId,
        author: "user",
        kind,
        content,
      });
      setToastMessage("回复已写入当前原型");
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
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
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsAccepting(false);
    }
  }

  async function handleCreateTopic(input: CreateTopicInput): Promise<void> {
    setIsCreating(true);
    try {
      const snapshot = await repository.createTopic(input);
      const createdTopic = snapshot.topics[0];
      if (createdTopic) {
        setSelectedTopicId(createdTopic.id);
      }
      setIsCreateDialogOpen(false);
      setToastMessage("新议题已经创建");
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  }

  const closeResponsivePanels = () => {
    setIsTopicsOpen(false);
    setIsInspectorOpen(false);
  };

  return (
    <div className="app-shell">
      <HeaderBar
        project={workspace.project}
        sync={workspace.sync}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onCreateTopic={() => setIsCreateDialogOpen(true)}
        onOpenTopics={() => setIsTopicsOpen(true)}
        onOpenInspector={() => setIsInspectorOpen(true)}
      />
      <div className="workspace-grid">
        <TopicSidebar
          topics={visibleTopics}
          selectedTopicId={selectedTopic.id}
          isOpen={isTopicsOpen}
          onSelectTopic={setSelectedTopicId}
          onClose={() => setIsTopicsOpen(false)}
        />
        <DiscussionPanel
          topic={selectedTopic}
          participants={participants}
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
      {toastMessage ? <div className="toast" role="status">{toastMessage}</div> : null}
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
      <p>加载 Operator Console 原型工作区…</p>
    </main>
  );
}
