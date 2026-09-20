/**
 * @input  依赖：mock 工作区、CouncilRepository 与浏览器结构化克隆
 * @output 导出：写入时冻结 Mock Actor 快照、议题关闭、决策包按 ID 接受、人工 Accepted 与实施项流转的同构数据实现
 * @pos    UI 原型阶段模拟选题、共享发布、议题创建、批量决策接受（同时写入 decidedAt 供架构档案
 *         ADR 编号排序）与只读议题详情加载
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createMockWorkspace, mockActorSnapshot } from "./mock-data";
import type { CouncilRepository, WorkspaceListener } from "./repository";
import {
  deriveParentStatus,
  hasChildren,
  summarizeWorkItemProgress,
} from "./work-item-tree";
import type {
  AddWorkItemsInput,
  ClaimWorkItemInput,
  CouncilWorkItem,
  CreateTopicInput,
  PublishMessageInput,
  RecordManualDecisionInput,
  TopicDetail,
  UpdateWorkItemInput,
  WorkspaceSnapshot,
} from "../types/council";

const DEFAULT_MOCK_OPERATION_DELAY_MS = 120;

/**
 * 每份对外快照都现算一次完成度，与真实后端「列表接口自带聚合」的行为对齐：
 * 存储态只保留实施项本身，避免同一事实存两份后写漏一处就开始互相打架。
 */
function withWorkItemProgress(topic: TopicDetail): TopicDetail {
  const progress = summarizeWorkItemProgress(topic.workItems);
  if (!progress) {
    delete topic.workItemProgress;
    return topic;
  }
  topic.workItemProgress = progress;
  return topic;
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const clone = structuredClone(snapshot);
  clone.topics = clone.topics.map(withWorkItemProgress);
  return clone;
}

async function waitForMockOperation(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

export class MockCouncilRepository implements CouncilRepository {
  readonly #listeners = new Set<WorkspaceListener>();
  readonly #operationDelayMs: number;
  #snapshot = createMockWorkspace();

  constructor(operationDelayMs = DEFAULT_MOCK_OPERATION_DELAY_MS) {
    this.#operationDelayMs = operationDelayMs;
  }

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    return cloneSnapshot(this.#snapshot);
  }

  async selectTopic(topicId: string): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    this.#findTopic(topicId);
    this.#snapshot.activeTopicId = topicId;
    return cloneSnapshot(this.#snapshot);
  }

  async createTopic(input: CreateTopicInput): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const now = new Date();
    const topicId = crypto.randomUUID();
    const topic: TopicDetail = {
      id: topicId,
      title: input.title,
      status: "proposed",
      updatedLabel: "刚刚",
      question: input.question,
      createdLabel: "刚刚",
      owner: "human",
      ownerSnapshot: mockActorSnapshot("human"),
      participants: ["human", "claude", "codex"],
      messages: [],
      constraints: input.constraints.map((label) => ({
        id: crypto.randomUUID(),
        label,
        tone: "positive" as const,
      })),
      evidence: [],
      alternatives: [],
      workItems: [],
      decisions: [],
    };
    this.#snapshot.topics.unshift(topic);
    this.#snapshot.activeTopicId = topicId;
    this.#snapshot.sync = {
      status: "connected",
      label: `Mock 已更新 ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    };
    return this.#publishSnapshot();
  }

  async closeTopic(topicId: string): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(topicId);
    topic.status = "closed";
    topic.updatedLabel = "刚刚";
    return this.#publishSnapshot();
  }

  async publishMessage(input: PublishMessageInput): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(input.topicId);
    this.#snapshot.activeTopicId = input.topicId;
    topic.messages.push({
      id: crypto.randomUUID(),
      author: input.author,
      actorSnapshot: mockActorSnapshot(input.author),
      kind: input.kind,
      title: input.kind === "critique" ? "新的审查意见" : "新的公开回复",
      content: input.content,
      createdLabel: "刚刚",
    });
    topic.updatedLabel = "刚刚";
    topic.status = input.kind === "synthesis" ? "synthesis" : "discussing";
    return this.#publishSnapshot();
  }

  async acceptDecisions(topicId: string, decisionIds: string[]): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(topicId);
    this.#snapshot.activeTopicId = topicId;
    if (decisionIds.length === 0) {
      throw new Error("请选择至少一条待确认决策");
    }
    const selected = new Set(decisionIds);
    if (topic.decisions.filter((decision) => selected.has(decision.id)).length !== selected.size) {
      throw new Error("部分决策不存在或不属于当前议题");
    }
    const now = new Date().toISOString();
    for (const decision of topic.decisions) {
      if (!selected.has(decision.id)) {
        continue;
      }
      if (decision.status !== "proposed" && decision.status !== "accepted") {
        throw new Error("已拒绝或已被取代的决策不能重新接受");
      }
      decision.status = "accepted";
      decision.decidedAt = now;
    }
    topic.status = topic.decisions.some((decision) => decision.status === "proposed")
      ? "discussing"
      : "decided";
    topic.updatedLabel = "刚刚";
    return this.#publishSnapshot();
  }

  async recordManualDecision(input: RecordManualDecisionInput): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(input.topicId);
    this.#snapshot.activeTopicId = input.topicId;
    for (const decision of topic.decisions) {
      if (decision.status === "proposed") {
        decision.status = "superseded";
        decision.decidedAt = new Date().toISOString();
      }
    }
    topic.decisions.push({
      id: crypto.randomUUID(),
      title: input.title,
      summary: input.summary,
      rationale: input.rationale,
      status: "accepted",
      proposedBy: "human",
      proposedBySnapshot: mockActorSnapshot("human"),
      createdAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
    });
    topic.status = "decided";
    topic.updatedLabel = "刚刚";
    return this.#publishSnapshot();
  }

  async addWorkItems(input: AddWorkItemsInput): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(input.topicId);
    const parent = input.parentId
      ? topic.workItems.find((candidate) => candidate.id === input.parentId)
      : undefined;
    if (input.parentId && !parent) {
      throw new Error("父实施项不存在");
    }
    const acceptedDecision = input.decisionId
      ? topic.decisions.find(
        (decision) => decision.id === input.decisionId && decision.status === "accepted",
      )
      : [...topic.decisions]
        .reverse()
        .find((decision) => decision.status === "accepted");
    if (!parent && !acceptedDecision) {
      throw new Error("当前议题没有可绑定的 Accepted 决策");
    }
    const snapshot = mockActorSnapshot("human");
    const parentKey = input.parentId ?? "";
    const siblings = topic.workItems.filter(
      (candidate) => (candidate.parentId ?? "") === parentKey,
    );
    let sortOrder = siblings.reduce(
      (highest, candidate) => Math.max(highest, candidate.sortOrder + 1),
      0,
    );
    for (const item of input.items) {
      const title = item.title.trim();
      if (siblings.some((candidate) => candidate.title.toLowerCase() === title.toLowerCase())) {
        throw new Error(`实施项“${title}”已经存在`);
      }
      topic.workItems.push({
        id: `work_item_${crypto.randomUUID()}`,
        // 子任务继承父任务的决策锚点，一棵树不横跨两个 ADR。
        ...(parent
          ? parent.decisionId ? { decisionId: parent.decisionId } : {}
          : acceptedDecision ? { decisionId: acceptedDecision.id } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        title,
        details: item.details?.trim() ?? "",
        status: "pending" as const,
        version: 1,
        sortOrder,
        origin: "manual" as const,
        createdBy: "human",
        createdBySnapshot: snapshot,
        updatedBy: "human",
        updatedBySnapshot: snapshot,
        createdLabel: "刚刚",
        updatedLabel: "刚刚",
      });
      sortOrder += 1;
    }
    if (input.parentId) {
      // 新子任务会把一个已完成的父任务重新拉回进行中。
      this.#recomputeAncestors(topic, input.parentId);
    }
    topic.updatedLabel = "刚刚";
    this.#snapshot.activeTopicId = input.topicId;
    return this.#publishSnapshot();
  }

  /** 与服务端同口径：父任务状态只能由子任务派生，界面不提供手动改父状态的入口。 */
  #recomputeAncestors(topic: TopicDetail, fromWorkItemId: string): void {
    const visited = new Set<string>();
    let cursor: string | undefined = fromWorkItemId;
    while (cursor) {
      if (visited.has(cursor)) {
        return;
      }
      visited.add(cursor);
      const current: CouncilWorkItem | undefined = topic.workItems.find(
        (candidate) => candidate.id === cursor,
      );
      if (!current) {
        return;
      }
      const childStatuses = topic.workItems
        .filter((candidate) => candidate.parentId === current.id)
        .map((candidate) => candidate.status);
      if (childStatuses.length > 0) {
        const derived = deriveParentStatus(childStatuses);
        if (derived !== current.status) {
          current.status = derived;
          current.version += 1;
          current.updatedBy = "human";
          current.updatedBySnapshot = mockActorSnapshot("human");
          current.updatedLabel = "刚刚";
          if (derived === "completed") {
            current.completedLabel ??= "刚刚";
          } else {
            delete current.completedLabel;
          }
        }
      }
      cursor = current.parentId;
    }
  }

  async updateWorkItem(input: UpdateWorkItemInput): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(input.topicId);
    const item = topic.workItems.find((candidate) => candidate.id === input.workItemId);
    if (!item) {
      throw new Error("实施项不存在");
    }
    if (item.version !== input.expectedVersion) {
      throw new Error("实施项已被其他参与者更新，请刷新后重试");
    }
    if (hasChildren(topic.workItems, item.id)) {
      throw new Error("这是一个父任务，状态由子任务派生；请更新它的子任务");
    }
    item.status = input.status;
    item.version += 1;
    item.updatedBy = "human";
    item.updatedBySnapshot = mockActorSnapshot("human");
    item.updatedLabel = "刚刚";
    if (input.statusNote?.trim()) {
      item.statusNote = input.statusNote.trim();
    }
    if (input.fixCommit?.trim()) {
      item.fixCommit = input.fixCommit.trim();
    }
    if (input.status === "completed") {
      item.completedLabel = "刚刚";
    } else {
      delete item.completedLabel;
    }
    if (item.parentId) {
      this.#recomputeAncestors(topic, item.parentId);
    }
    topic.updatedLabel = "刚刚";
    this.#snapshot.activeTopicId = input.topicId;
    return this.#publishSnapshot();
  }

  async claimWorkItem(input: ClaimWorkItemInput): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(input.topicId);
    const item = topic.workItems.find((candidate) => candidate.id === input.workItemId);
    if (!item) {
      throw new Error("实施项不存在");
    }
    if (item.version !== input.expectedVersion) {
      throw new Error("实施项已被其他参与者更新，请刷新后重试");
    }
    if (hasChildren(topic.workItems, item.id)) {
      throw new Error("父任务不能被认领；请认领它的子任务");
    }
    if (item.status === "completed") {
      throw new Error("这条实施项已经完成，无需认领");
    }
    item.status = "in_progress";
    item.version += 1;
    item.assignee = "human";
    item.claimedLabel = "刚刚";
    item.updatedBy = "human";
    item.updatedBySnapshot = mockActorSnapshot("human");
    item.updatedLabel = "刚刚";
    delete item.completedLabel;
    if (input.statusNote?.trim()) {
      item.statusNote = input.statusNote.trim();
    }
    if (item.parentId) {
      this.#recomputeAncestors(topic, item.parentId);
    }
    topic.updatedLabel = "刚刚";
    this.#snapshot.activeTopicId = input.topicId;
    return this.#publishSnapshot();
  }

  async loadTopicDetail(topicId: string): Promise<TopicDetail> {
    await waitForMockOperation(this.#operationDelayMs);
    return withWorkItemProgress(structuredClone(this.#findTopic(topicId)));
  }

  subscribe(listener: WorkspaceListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #findTopic(topicId: string): TopicDetail {
    const topic = this.#snapshot.topics.find((candidate) => candidate.id === topicId);
    if (!topic) {
      throw new Error("议题不存在或已被移除");
    }
    return topic;
  }

  #publishSnapshot(): WorkspaceSnapshot {
    const snapshot = cloneSnapshot(this.#snapshot);
    for (const listener of this.#listeners) {
      listener(cloneSnapshot(snapshot));
    }
    return snapshot;
  }
}
