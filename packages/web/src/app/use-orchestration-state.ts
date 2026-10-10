/**
 * @input  依赖：React、OrchestrationRepository（含 SSE 订阅）、Agent 委派 hook、界面语言、编排领域类型
 * @output 导出：useOrchestrationState —— 编排快照、能力/运行两类错误与重试、忙碌动作、实施项委派状态，
 *         以及 @ 召唤 run、圆桌（开局/答问/提交修复/放弃）、自动轮次（启动/取消/恢复/确认）、持久会话开关写操作
 * @pos    App 壳的编排控制器：能力快照独立于内容加载；当前议题变化时重新 selectTopic 拉取该议题的运行态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useEffect, useState } from "react";
import type { MentionPublishRequest } from "../features/discussion/Composer";
import { getErrorMessage } from "../data/error-message";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import { useWorkItemDelegations } from "../hooks/useWorkItemDelegations";
import { useI18n } from "../i18n/I18nProvider";
import type {
  CycleReviewScope,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";

export function useOrchestrationState(
  orchestrationRepository: OrchestrationRepository,
  activeTopicId: string,
  setToastMessage: (message: string | null) => void,
) {
  const { t } = useI18n();
  const [orchestration, setOrchestration] = useState<OrchestrationSnapshot | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [capabilitiesErrorMessage, setCapabilitiesErrorMessage] = useState<string | null>(null);
  const [runsErrorMessage, setRunsErrorMessage] = useState<string | null>(null);
  const [capabilitiesLoadAttempt, setCapabilitiesLoadAttempt] = useState(0);
  const [runsLoadAttempt, setRunsLoadAttempt] = useState(0);

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

  const workItemDelegations = useWorkItemDelegations(
    orchestrationRepository,
    activeTopicId,
    orchestration,
  );

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

  /** Model Router 配置变化或能力加载失败后重拉能力快照 */
  function reloadCapabilities(): void {
    setCapabilitiesLoadAttempt((current) => current + 1);
  }

  function retryCapabilities(): void {
    setCapabilitiesErrorMessage(null);
    reloadCapabilities();
  }

  function retryRuns(): void {
    setRunsErrorMessage(null);
    setRunsLoadAttempt((current) => current + 1);
  }

  function clearErrors(): void {
    setCapabilitiesErrorMessage(null);
    setRunsErrorMessage(null);
  }

  /**
   * @claude/@codex 召唤语法糖的第二步：公开消息已发布后发起单轮自动 run。
   * 失败只报"消息已发布，但自动回应启动失败"，不回滚已发布的消息。
   */
  async function triggerMentionRun(
    mention: MentionPublishRequest,
    requestMessageId: string,
  ): Promise<void> {
    setBusyAction("create");
    setRunsErrorMessage(null);
    try {
      const created = await orchestrationRepository.createRun({
        topicId: activeTopicId,
        confirmationBeforeCompletion: false,
        plan: [{
          adapterId: mention.adapterId,
          messageKind: mention.responseKind,
          instruction: mention.instruction,
          requestMessageId,
        }],
      });
      setBusyAction(`start:${created.id}`);
      const snapshot = await orchestrationRepository.startRun(created.id);
      setOrchestration(snapshot);
      setToastMessage(t("消息已发布，Agent 正在回复"));
    } catch (error: unknown) {
      setRunsErrorMessage(t("消息已发布，但自动回应启动失败：{message}", {
        message: getErrorMessage(error),
      }));
    } finally {
      setBusyAction(null);
    }
  }

  async function startCycle(
    participants: string[],
    roundBudget: number,
    reviewScope: CycleReviewScope,
  ): Promise<boolean> {
    setBusyAction("cycle");
    setRunsErrorMessage(null);
    try {
      const snapshot = await orchestrationRepository.startCycle({
        topicId: activeTopicId,
        participants,
        roundBudget,
        kind: reviewScope === "commit" ? "fix_review" : "discussion",
        reviewScope,
      });
      setOrchestration(snapshot);
      const reusedProposal = snapshot.cycle?.cycle.turns.some(
        (turn) => turn.stage === "proposal",
      ) ?? false;
      setToastMessage(
        reusedProposal
          ? t("已复用现有提案，首位评审正在审核")
          : t("圆桌已开始，提案人正在发言"),
      );
      return true;
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function answerCycleQuestion(
    questionMessageId: string,
    content: string,
  ): Promise<boolean> {
    setBusyAction("cycle");
    setRunsErrorMessage(null);
    try {
      const snapshot = await orchestrationRepository.answerCycleQuestion({
        topicId: activeTopicId,
        questionMessageId,
        content,
      });
      setOrchestration(snapshot);
      setToastMessage(t("回答已发布，讨论继续"));
      return true;
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function submitFixes(): Promise<void> {
    setBusyAction("cycle");
    setRunsErrorMessage(null);
    try {
      setOrchestration(
        await orchestrationRepository.submitFixes({ topicId: activeTopicId }),
      );
      setToastMessage(t("修复已提交，复审开始"));
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function abandonCycle(): Promise<void> {
    setBusyAction("cycle");
    setRunsErrorMessage(null);
    try {
      setOrchestration(await orchestrationRepository.abandonCycle(activeTopicId));
      setToastMessage(t("圆桌已放弃，议题可以重新开局"));
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function runAction(
    action: "start" | "cancel" | "recover",
    runId: string,
  ): Promise<void> {
    setBusyAction(`${action}:${runId}`);
    setRunsErrorMessage(null);
    try {
      const snapshot = action === "start"
        ? await orchestrationRepository.startRun(runId)
        : action === "cancel"
          ? await orchestrationRepository.cancelRun(runId)
          : await orchestrationRepository.recoverRun(runId);
      setOrchestration(snapshot);
      setToastMessage(
        action === "cancel"
          ? t("自动轮次已取消")
          : action === "recover"
            ? t("恢复已提交")
            : t("自动轮次已启动"),
      );
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function approveRun(run: OrchestrationRun): Promise<void> {
    if (!run.pendingGateId) {
      return;
    }
    setBusyAction(`approve:${run.id}`);
    setRunsErrorMessage(null);
    try {
      const snapshot = await orchestrationRepository.approveRun({
        runId: run.id,
        expectedGateId: run.pendingGateId,
        expectedVersion: run.version,
        approvalId: crypto.randomUUID(),
      });
      setOrchestration(snapshot);
      setToastMessage(t("确认已提交，自动轮次继续"));
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function runtimeBindingAction(
    action: "close" | "reopen",
    bindingId: string,
  ): Promise<void> {
    setBusyAction(`binding:${action}:${bindingId}`);
    setRunsErrorMessage(null);
    try {
      if (action === "close") {
        await orchestrationRepository.closeRuntimeBinding(bindingId);
      } else {
        await orchestrationRepository.reopenRuntimeBinding(bindingId);
      }
      const snapshot = await orchestrationRepository.selectTopic(activeTopicId);
      setOrchestration(snapshot);
      setToastMessage(action === "close" ? t("持久会话已关闭") : t("持久会话已重新打开"));
    } catch (error: unknown) {
      setRunsErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  return {
    orchestration,
    busyAction,
    capabilitiesErrorMessage,
    runsErrorMessage,
    workItemDelegations,
    reloadCapabilities,
    retryCapabilities,
    retryRuns,
    clearErrors,
    triggerMentionRun,
    startCycle,
    answerCycleQuestion,
    submitFixes,
    abandonCycle,
    runAction,
    approveRun,
    runtimeBindingAction,
  };
}

export type OrchestrationStateController = ReturnType<typeof useOrchestrationState>;
