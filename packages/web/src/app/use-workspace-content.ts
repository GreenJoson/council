/**
 * @input  依赖：React、CouncilRepository（含 SSE 订阅）、桌面设置控制器、界面语言、内容领域类型
 * @output 导出：useWorkspaceContent —— 工作区快照、选中议题、内容错误与重载，以及选题、接受决策、
 *         关闭议题、人工决策、新建议题等内容写操作
 * @pos    App 壳的内容仓储控制器：桌面模式未选定日志库/项目前不加载；订阅快照随 SSE 刷新并跟随
 *         activeTopicId；选题请求用递增 requestId 丢弃过期响应
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ManualDecisionDraft } from "../features/discussion/ManualDecisionDialog";
import { getErrorMessage } from "../data/error-message";
import type { NativeCouncilRepository } from "../data/native-repository";
import type { CouncilRepository } from "../data/repository";
import { useI18n } from "../i18n/I18nProvider";
import type {
  CreateTopicInput,
  Participant,
  RecordManualDecisionInput,
  WorkspaceSnapshot,
} from "../types/council";
import type { DesktopSettingsController } from "./use-desktop-settings";

export interface WorkspaceContentOptions {
  repository: CouncilRepository;
  nativeRepository: NativeCouncilRepository | undefined;
  desktop: DesktopSettingsController;
  setToastMessage: (message: string | null) => void;
}

export function useWorkspaceContent({
  repository,
  nativeRepository,
  desktop,
  setToastMessage,
}: WorkspaceContentOptions) {
  const { t } = useI18n();
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isClosingTopic, setIsClosingTopic] = useState(false);
  const [isRecordingManualDecision, setIsRecordingManualDecision] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const selectionRequestId = useRef(0);
  const desktopSettings = desktop.settings;

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
          setErrorMessage(null);
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
        setErrorMessage(null);
        setSelectedTopicId((current) =>
          (snapshot.activeTopicId ?? current) || snapshot.topics[0]?.id || ""
        );
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
  }, [desktopSettings?.currentProjectPath, desktopSettings?.logLibrary, loadAttempt, nativeRepository, repository]);

  const participants = useMemo(
    () => new Map<string, Participant>(workspace?.participants.map((item) => [item.id, item]) ?? []),
    [workspace],
  );
  const selectedTopic = workspace
    ? workspace.topics.find((topic) => topic.id === selectedTopicId) ?? workspace.topics[0]
    : undefined;
  const activeTopicId = selectedTopic?.id ?? "";

  /** 项目或日志库切换后清空工作区并重新加载 */
  function resetWorkspace(): void {
    setWorkspace(null);
    setLoadAttempt((current) => current + 1);
  }

  /** 致命态"重试"：清错误后重新走一遍首次加载 */
  function retryLoad(): void {
    setErrorMessage(null);
    setLoadAttempt((current) => current + 1);
  }

  function retrySync(): void {
    setErrorMessage(null);
    void repository
      .loadWorkspace()
      .then(() => setErrorMessage(null))
      .catch((error: unknown) => setErrorMessage(getErrorMessage(error)));
  }

  async function selectTopic(topicId: string): Promise<void> {
    if (topicId === activeTopicId) {
      return;
    }
    const requestId = ++selectionRequestId.current;
    setErrorMessage(null);
    try {
      const snapshot = await repository.selectTopic(topicId);
      if (requestId !== selectionRequestId.current) {
        return;
      }
      setWorkspace(snapshot);
      setSelectedTopicId(topicId);
    } catch (error: unknown) {
      if (requestId === selectionRequestId.current) {
        setErrorMessage(getErrorMessage(error));
      }
    }
  }

  async function acceptDecisions(decisionIds: string[]): Promise<void> {
    if (decisionIds.length === 0) {
      return;
    }
    setIsAccepting(true);
    try {
      const snapshot = await repository.acceptDecisions(activeTopicId, decisionIds);
      setWorkspace(snapshot);
      if (decisionIds.length === 1) {
        setToastMessage(t("决策已接受；任务尚未分拆，请在任务页选择 Agent 后手动开始"));
      } else {
        setToastMessage(t("已接受 {count} 条决策；任务尚未自动分拆", {
          count: decisionIds.length,
        }));
      }
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsAccepting(false);
    }
  }

  async function closeTopic(): Promise<void> {
    if (!activeTopicId || !selectedTopic || selectedTopic.status === "closed") {
      return;
    }
    const confirmed = window.confirm(t(
      "关闭后将停止该议题的圆桌和 Agent 会话，但会保留全部讨论、决策和任务历史。确定关闭吗？",
    ));
    if (!confirmed) {
      return;
    }
    setIsClosingTopic(true);
    setErrorMessage(null);
    try {
      const snapshot = await repository.closeTopic(activeTopicId);
      setWorkspace(snapshot);
      setToastMessage(t("议题已关闭，历史记录仍被保留"));
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsClosingTopic(false);
    }
  }

  async function recordManualDecision(draft: ManualDecisionDraft): Promise<boolean> {
    if (!activeTopicId) {
      return false;
    }
    setIsRecordingManualDecision(true);
    setErrorMessage(null);
    try {
      const input: RecordManualDecisionInput = {
        topicId: activeTopicId,
        ...draft,
      };
      const snapshot = await repository.recordManualDecision(input);
      setWorkspace(snapshot);
      setSelectedTopicId(activeTopicId);
      setToastMessage(t("人工决策已记录；任务尚未分拆，请在任务页选择 Agent 后手动开始"));
      return true;
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setIsRecordingManualDecision(false);
    }
  }

  /** onCreated 与选中新议题、toast 同步执行，保持原先"关闭对话框"的时序 */
  async function createTopic(
    input: CreateTopicInput,
    targetProjectPath: string | undefined,
    onCreated: () => void,
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
        desktop.setSettings(settings);
      }
      const snapshot = await repository.createTopic(input);
      const createdTopicId = snapshot.activeTopicId ?? snapshot.topics[0]?.id;
      if (createdTopicId) {
        setSelectedTopicId(createdTopicId);
      }
      onCreated();
      setToastMessage(t("新议题已创建并同步"));
      return true;
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setIsCreating(false);
    }
  }

  return {
    workspace,
    setWorkspace,
    participants,
    selectedTopic,
    activeTopicId,
    errorMessage,
    setErrorMessage,
    isAccepting,
    isClosingTopic,
    isRecordingManualDecision,
    isCreating,
    resetWorkspace,
    retryLoad,
    retrySync,
    selectTopic,
    acceptDecisions,
    closeTopic,
    recordManualDecision,
    createTopic,
  };
}

export type WorkspaceContentController = ReturnType<typeof useWorkspaceContent>;
