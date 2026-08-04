/**
 * @input  依赖：mock 工作区、CouncilRepository 与浏览器结构化克隆
 * @output 导出：写入时冻结 Mock Actor 快照、支持人工 Accepted 的同构数据实现
 * @pos    UI 原型阶段模拟选题、共享发布、议题创建、决策接受（同时写入 decidedAt 供架构档案
 *         ADR 编号排序）与只读议题详情加载
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createMockWorkspace, mockActorSnapshot } from "./mock-data";
import type { CouncilRepository, WorkspaceListener } from "./repository";
import type {
  CreateTopicInput,
  PublishMessageInput,
  RecordManualDecisionInput,
  TopicDetail,
  WorkspaceSnapshot,
} from "../types/council";

const DEFAULT_MOCK_OPERATION_DELAY_MS = 120;

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return structuredClone(snapshot);
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
    };
    this.#snapshot.topics.unshift(topic);
    this.#snapshot.activeTopicId = topicId;
    this.#snapshot.sync = {
      status: "connected",
      label: `Mock 已更新 ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    };
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

  async acceptDecision(topicId: string): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(topicId);
    this.#snapshot.activeTopicId = topicId;
    if (!topic.decision) {
      throw new Error("当前议题没有可接受的拟议决策");
    }
    topic.decision.status = "accepted";
    topic.decision.decidedAt = new Date().toISOString();
    topic.status = "decided";
    topic.updatedLabel = "刚刚";
    return this.#publishSnapshot();
  }

  async recordManualDecision(input: RecordManualDecisionInput): Promise<WorkspaceSnapshot> {
    await waitForMockOperation(this.#operationDelayMs);
    const topic = this.#findTopic(input.topicId);
    this.#snapshot.activeTopicId = input.topicId;
    topic.decision = {
      title: input.title,
      summary: input.summary,
      rationale: input.rationale,
      status: "accepted",
      proposedBy: "human",
      proposedBySnapshot: mockActorSnapshot("human"),
      decidedAt: new Date().toISOString(),
    };
    topic.status = "decided";
    topic.updatedLabel = "刚刚";
    return this.#publishSnapshot();
  }

  async loadTopicDetail(topicId: string): Promise<TopicDetail> {
    await waitForMockOperation(this.#operationDelayMs);
    return structuredClone(this.#findTopic(topicId));
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
