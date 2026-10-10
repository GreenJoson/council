/**
 * @input  依赖：React、CouncilRepository、OrchestrationRepository、内容与编排控制器、界面语言、实施项类型
 * @output 导出：useTopicActions —— 发帖（含 @ 召唤语法糖；发布后把正文 council-asset: 引用挂到消息）与实施项拆分/新增/状态更新/认领/批量委派（单项委派与取消已迁到任务详情），
 *         以及 isPublishing、workItemBusyAction 忙碌状态
 * @pos    App 壳里横跨内容仓储与编排仓储的议题内写操作；错误统一写入内容错误条，成功走共享 toast
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useState } from "react";
import type { MentionPublishRequest } from "../features/discussion/Composer";
import { getErrorMessage } from "../data/error-message";
import { linkReferencedAssetsToMessage } from "../data/markdown-images";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import type { CouncilRepository } from "../data/repository";
import { useI18n } from "../i18n/I18nProvider";
import type {
  CouncilWorkItem,
  MessageKind,
  WorkspaceSnapshot,
  WorkItemStatus,
} from "../types/council";
import type { OrchestrationStateController } from "./use-orchestration-state";
import type { WorkspaceContentController } from "./use-workspace-content";

export interface DelegateWorkItemInput {
  supervisorAgentId: string;
  executorAgentId: string;
  requestedPermission: "workspace_write" | "danger_full_access";
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  createInitialBaseline?: boolean;
}

export interface TopicActionsOptions {
  repository: CouncilRepository;
  orchestrationRepository: OrchestrationRepository;
  content: WorkspaceContentController;
  orchestrationState: OrchestrationStateController;
  setToastMessage: (message: string | null) => void;
}

export function useTopicActions({
  repository,
  orchestrationRepository,
  content,
  orchestrationState,
  setToastMessage,
}: TopicActionsOptions) {
  const { t } = useI18n();
  const [isPublishing, setIsPublishing] = useState(false);
  const [workItemBusyAction, setWorkItemBusyAction] = useState<string | null>(null);
  const { activeTopicId, workspace, setWorkspace, setErrorMessage } = content;
  const { orchestration, workItemDelegations } = orchestrationState;

  /**
   * mention 非空时是 "@claude/@codex 召唤" 语法糖：kind 此时已被 Composer 固定为 note
   * （这条讨论消息是指令性发言，不是提案本身），发布成功后额外发起一次单轮自动 run
   * （plan.messageKind 取 mention.responseKind，即 Agent 回应应呈现的类型，来自用户在
   * kind 选择器里实际点的那个值）。Run 创建/启动失败不回滚已发布的消息——用诚实的错误
   * 提示告知"消息已发布，但自动回应启动失败"，而不是让用户以为整条操作失败。
   */
  async function publish(
    kind: MessageKind,
    text: string,
    mention?: MentionPublishRequest,
  ): Promise<boolean> {
    setIsPublishing(true);
    setErrorMessage(null);
    try {
      const published = await repository.publishMessage({
        topicId: activeTopicId,
        author: "human",
        kind,
        content: text,
      });
      const requestMessageId = published.topics
        .find((topic) => topic.id === activeTopicId)
        ?.messages
        .filter((message) => message.author === "human" && message.content === text)
        .at(-1)
        ?.id;
      // 桌面模式人工发帖直写 SQLite，服务端不会自动挂接；这里统一补挂（幂等），失败不影响已发布消息。
      if (requestMessageId) {
        await linkReferencedAssetsToMessage(text, requestMessageId);
      }
      if (!mention) {
        setToastMessage(t("回复已发布并同步"));
        return true;
      }
      if (!requestMessageId) {
        throw new Error(t("公开请求已发布，但无法冻结对应消息，Agent 调用未启动。"));
      }
      await orchestrationState.triggerMentionRun(mention, requestMessageId);
      return true;
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setIsPublishing(false);
    }
  }

  async function generateImplementationPlan(
    topicId: string,
    snapshot: WorkspaceSnapshot,
    adapterId: string,
    decisionId?: string,
  ): Promise<void> {
    const topic = snapshot.topics.find((candidate) => candidate.id === topicId);
    const selectedDecision = decisionId
      ? topic?.decisions.find((decision) => decision.id === decisionId)
      : [...(topic?.decisions ?? [])]
        .reverse()
        .find((decision) => decision.status === "accepted");
    const agent = orchestration?.capabilities?.adapters.find(
      (adapter) => adapter.id === adapterId && adapter.available,
    );
    if (!agent) {
      setErrorMessage(t("所选任务拆分 Agent 当前不可用，请重新选择"));
      return;
    }

    setWorkItemBusyAction("generate");
    setErrorMessage(null);
    try {
      const result = await orchestrationRepository.generateWorkItems({
        topicId,
        adapterId,
        ...(selectedDecision ? { decisionId: selectedDecision.id } : {}),
      });
      const refreshed = await repository.loadWorkspace();
      setWorkspace(refreshed);
      setToastMessage(
        result.createdCount > 0
          ? t("{agent} 已生成 {count} 个实施任务", {
            agent: agent.label,
            count: result.createdCount,
          })
          : t("{agent} 未发现需要补充的新任务", { agent: agent.label }),
      );
    } catch (error: unknown) {
      setErrorMessage(t("AI 拆分任务失败：{message}", {
        message: getErrorMessage(error),
      }));
    } finally {
      setWorkItemBusyAction(null);
    }
  }

  async function generateWorkItems(adapterId: string): Promise<void> {
    if (!workspace || !activeTopicId) {
      return;
    }
    await generateImplementationPlan(activeTopicId, workspace, adapterId);
  }

  async function addWorkItem(
    title: string,
    details: string,
    parentId?: string,
  ): Promise<boolean> {
    setWorkItemBusyAction("add");
    setErrorMessage(null);
    try {
      const snapshot = await repository.addWorkItems({
        topicId: activeTopicId,
        ...(parentId ? { parentId } : {}),
        items: [{ title, ...(details ? { details } : {}) }],
      });
      setWorkspace(snapshot);
      setToastMessage(t("实施项已加入执行账本"));
      return true;
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
      return false;
    } finally {
      setWorkItemBusyAction(null);
    }
  }

  async function updateWorkItem(
    item: CouncilWorkItem,
    status: WorkItemStatus,
    statusNote: string,
  ): Promise<void> {
    if (status === item.status && statusNote === (item.statusNote ?? "")) {
      return;
    }
    setWorkItemBusyAction(`update:${item.id}`);
    setErrorMessage(null);
    try {
      const snapshot = await repository.updateWorkItem({
        topicId: activeTopicId,
        workItemId: item.id,
        status,
        statusNote,
        expectedVersion: item.version,
      });
      setWorkspace(snapshot);
      setToastMessage(status === "completed" ? t("实施项已标记完成") : t("实施状态已更新"));
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setWorkItemBusyAction(null);
    }
  }

  async function claimWorkItem(item: CouncilWorkItem): Promise<void> {
    setWorkItemBusyAction(`claim:${item.id}`);
    setErrorMessage(null);
    try {
      const snapshot = await repository.claimWorkItem({
        topicId: activeTopicId,
        workItemId: item.id,
        expectedVersion: item.version,
      });
      setWorkspace(snapshot);
      setToastMessage(t("已认领「{title}」", { title: item.title }));
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setWorkItemBusyAction(null);
    }
  }

  async function delegateWorkItems(
    items: CouncilWorkItem[],
    input: DelegateWorkItemInput,
  ): Promise<void> {
    setErrorMessage(null);
    try {
      await workItemDelegations.startBatch({
        topicId: activeTopicId,
        workItems: items.map((item) => ({
          workItemId: item.id,
          expectedVersion: item.version,
        })),
        ...input,
      });
      setToastMessage(t("一键委派已开始：任务将串行执行并逐项审核"));
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    }
  }

  return {
    isPublishing,
    workItemBusyAction,
    publish,
    generateWorkItems,
    addWorkItem,
    updateWorkItem,
    claimWorkItem,
    delegateWorkItems,
  };
}

export type TopicActionsController = ReturnType<typeof useTopicActions>;
