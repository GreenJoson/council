/**
 * @input  依赖：Council REST/SSE API、严格解析器与 Workspace 映射器
 * @output 导出：惰性详情、revision 解析、只读议题详情加载与 HttpCouncilRepository
 * @pos    Operator Console 的 HTTP 写入和 REST/SSE 串行校准协调器
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  parseApiDecision,
  parseApiMessage,
  parseApiPaginatedTopics,
  parseApiTopic,
  parseApiTopicDetail,
  type ApiTopic,
  type ApiTopicDetail,
} from "./api-types";
import {
  createApiUrl,
  jsonRequest,
  requestApiData,
  type Fetcher,
} from "./http-client";
import type { CouncilRepository, WorkspaceListener } from "./repository";
import { readProjectPathConfig } from "./project-path";
import { parseCouncilStatusRevisions } from "./status-revisions";
import { mapApiTopicDetail, mapWorkspaceFromTopics } from "./workspace-mapper";
import type {
  CreateTopicInput,
  PublishMessageInput,
  TopicDetail,
  WorkspaceSnapshot,
} from "../types/council";

export interface EventStream {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export type EventStreamFactory = (url: string) => EventStream;

export interface HttpCouncilRepositoryOptions {
  baseUrl: string;
  fetcher?: Fetcher;
  eventStreamFactory?: EventStreamFactory;
  projectPath: string;
  topicPageSize: number;
  messagePageSize: number;
  eventRefreshMaxAttempts: number;
  eventRefreshRetryDelayMs: number;
  eventRecoveryDelayMs: number;
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return structuredClone(snapshot);
}

function browserEventStreamFactory(url: string): EventStream {
  return new EventSource(url);
}

function parseRevisionRecord(parsed: unknown): number | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const revision = (parsed as Record<string, unknown>).revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

export function parseCouncilChangedRevision(event: Event): number | undefined {
  const data = (event as unknown as { data?: unknown }).data;
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    return parseRevisionRecord(JSON.parse(data) as unknown);
  } catch {
    return undefined;
  }
}

export class HttpCouncilRepository implements CouncilRepository {
  readonly #baseUrl: string;
  readonly #fetcher: Fetcher;
  readonly #eventStreamFactory: EventStreamFactory;
  readonly #projectPath: string;
  readonly #topicPageSize: number;
  readonly #messagePageSize: number;
  readonly #eventRefreshMaxAttempts: number;
  readonly #eventRefreshRetryDelayMs: number;
  readonly #eventRecoveryDelayMs: number;
  readonly #listeners = new Set<WorkspaceListener>();
  #topics: ApiTopic[] = [];
  #activeTopicId: string | undefined;
  #snapshot: WorkspaceSnapshot | undefined;
  #eventStream: EventStream | undefined;
  #eventStreamGeneration = 0;
  #eventConnected = false;
  #loadPromise: Promise<WorkspaceSnapshot> | undefined;
  #selectPromise: Promise<WorkspaceSnapshot> | undefined;
  #selectionRequestId = 0;
  #refreshRequested = false;
  #refreshRunning = false;
  #observedTotalRevision = -1;
  #appliedContentRevision = -1;
  #queuedRevision: number | undefined;
  #refreshingRevision: number | undefined;
  #failedRevision: number | undefined;
  #retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #retryWaitResolver: ((shouldContinue: boolean) => void) | undefined;
  #recoveryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(options: HttpCouncilRepositoryOptions) {
    createApiUrl(options.baseUrl, "/api/v1/status");
    const maxAttempts = options.eventRefreshMaxAttempts;
    const retryDelayMs = options.eventRefreshRetryDelayMs;
    const recoveryDelayMs = options.eventRecoveryDelayMs;
    if (!Number.isSafeInteger(options.topicPageSize) || options.topicPageSize <= 0) {
      throw new Error("topicPageSize 必须是正整数");
    }
    if (!Number.isSafeInteger(options.messagePageSize) || options.messagePageSize <= 0) {
      throw new Error("messagePageSize 必须是正整数");
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("eventRefreshMaxAttempts 必须是正整数");
    }
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new Error("eventRefreshRetryDelayMs 必须是非负整数");
    }
    if (!Number.isSafeInteger(recoveryDelayMs) || recoveryDelayMs <= 0) {
      throw new Error("eventRecoveryDelayMs 必须是正整数");
    }
    this.#baseUrl = options.baseUrl;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.#eventStreamFactory = options.eventStreamFactory ?? browserEventStreamFactory;
    this.#projectPath = readProjectPathConfig(options.projectPath);
    this.#topicPageSize = options.topicPageSize;
    this.#messagePageSize = options.messagePageSize;
    this.#eventRefreshMaxAttempts = maxAttempts;
    this.#eventRefreshRetryDelayMs = retryDelayMs;
    this.#eventRecoveryDelayMs = recoveryDelayMs;
  }

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    if (this.#loadPromise) {
      return this.#loadPromise;
    }
    const pendingSelection = this.#selectPromise;
    const promise = this.#performLoadAfterSelection(pendingSelection);
    this.#loadPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#loadPromise === promise) {
        this.#loadPromise = undefined;
      }
    }
  }

  async selectTopic(topicId: string): Promise<WorkspaceSnapshot> {
    if (!this.#topics.some((topic) => topic.id === topicId)) {
      throw new Error("议题不存在或已被移除");
    }
    if (topicId === this.#activeTopicId && this.#snapshot) {
      return cloneSnapshot(this.#snapshot);
    }
    const requestId = ++this.#selectionRequestId;
    const promise = this.#performSelection(topicId, requestId);
    this.#selectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#selectPromise === promise) {
        this.#selectPromise = undefined;
      }
    }
  }

  async createTopic(input: CreateTopicInput): Promise<WorkspaceSnapshot> {
    const topic = await this.#requestMutation(
      createApiUrl(this.#baseUrl, "/api/v1/topics"),
      {
        title: input.title,
        question: input.question,
        constraints: input.constraints,
        projectPath: this.#projectPath,
      },
      parseApiTopic,
    );
    return this.#reloadAfterMutation(topic.id);
  }

  async publishMessage(input: PublishMessageInput): Promise<WorkspaceSnapshot> {
    await this.#requestMutation(
      createApiUrl(
        this.#baseUrl,
        `/api/v1/topics/${encodeURIComponent(input.topicId)}/messages`,
      ),
      {
        kind: input.kind,
        content: input.content,
      },
      parseApiMessage,
    );
    return this.#reloadAfterMutation(input.topicId);
  }

  async acceptDecision(topicId: string): Promise<WorkspaceSnapshot> {
    const snapshot = this.#snapshot;
    if (!snapshot) {
      throw new Error("请先加载工作区，再接受决策");
    }
    const topic = snapshot.topics.find((candidate) => candidate.id === topicId);
    if (!topic?.decision) {
      throw new Error("当前议题没有可接受的拟议决策");
    }
    if (topic.decision.status === "accepted") {
      return cloneSnapshot(snapshot);
    }
    await this.#requestMutation(
      createApiUrl(
        this.#baseUrl,
        `/api/v1/topics/${encodeURIComponent(topicId)}/decisions`,
      ),
      {
        title: topic.decision.title,
        decision: topic.decision.summary,
        rationale: topic.decision.rationale,
        alternatives: topic.alternatives.map((alternative) => alternative.title),
        status: "accepted",
      },
      parseApiDecision,
    );
    return this.#reloadAfterMutation(topicId);
  }

  async loadTopicDetail(topicId: string): Promise<TopicDetail> {
    const detail = await this.#loadTopicDetail(topicId);
    return mapApiTopicDetail(detail);
  }

  subscribe(listener: WorkspaceListener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#openEventStream();
      this.#scheduleRecovery();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#eventStream?.close();
        this.#eventStream = undefined;
        this.#eventStreamGeneration += 1;
        this.#eventConnected = false;
        this.#refreshRequested = false;
        this.#queuedRevision = undefined;
        this.#cancelRetryWait();
        this.#cancelRecoveryTimer();
      }
    };
  }

  async #performLoadAfterSelection(
    pendingSelection: Promise<WorkspaceSnapshot> | undefined,
  ): Promise<WorkspaceSnapshot> {
    if (pendingSelection) {
      try {
        await pendingSelection;
      } catch {
        // 列表刷新仍应继续，选题错误由发起者显示。
      }
    }
    return this.#performLoad();
  }

  async #performLoad(): Promise<WorkspaceSnapshot> {
    this.#publishSync("syncing", "正在从 API 同步…");
    try {
      const statusRevisions = await this.#loadStatusRevisions();
      const topics = await this.#loadAllTopics();
      const activeTopicId = topics.some((topic) => topic.id === this.#activeTopicId)
        ? this.#activeTopicId
        : topics[0]?.id;
      const activeDetail = activeTopicId
        ? await this.#loadTopicDetail(activeTopicId)
        : undefined;
      this.#topics = topics;
      this.#activeTopicId = activeTopicId;
      const snapshot = mapWorkspaceFromTopics(
        topics,
        activeDetail,
        this.#connectedSyncState(),
      );
      this.#snapshot = snapshot;
      this.#observedTotalRevision = statusRevisions.revision;
      this.#appliedContentRevision = statusRevisions.content;
      if (this.#failedRevision !== undefined) {
        this.#failedRevision = undefined;
        this.#cancelRecoveryTimer();
      }
      this.#publishSnapshot();
      return cloneSnapshot(snapshot);
    } catch (error: unknown) {
      this.#publishSync("offline", "API 暂不可用 · 可重试");
      throw error;
    }
  }

  async #performSelection(topicId: string, requestId: number): Promise<WorkspaceSnapshot> {
    const existingLoad = this.#loadPromise;
    if (existingLoad) {
      try {
        await existingLoad;
      } catch {
        // 已有列表仍可用于选题；详情请求会给出真实结果。
      }
    }
    this.#publishSync("syncing", "正在加载议题详情…");
    try {
      const detail = await this.#loadTopicDetail(topicId);
      if (requestId !== this.#selectionRequestId) {
        if (!this.#snapshot) {
          throw new Error("工作区尚未加载完成");
        }
        return cloneSnapshot(this.#snapshot);
      }
      this.#activeTopicId = topicId;
      const snapshot = mapWorkspaceFromTopics(this.#topics, detail, this.#connectedSyncState());
      this.#snapshot = snapshot;
      return cloneSnapshot(snapshot);
    } catch (error: unknown) {
      if (requestId === this.#selectionRequestId) {
        this.#publishSync("offline", "议题详情加载失败 · 可重试");
      }
      throw error;
    }
  }

  async #loadAllTopics(): Promise<ApiTopic[]> {
    const topics: ApiTopic[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await requestApiData(
        this.#fetcher,
        createApiUrl(this.#baseUrl, "/api/v1/topics", {
          projectPath: this.#projectPath,
          limit: this.#topicPageSize,
          offset,
        }),
        parseApiPaginatedTopics,
      );
      topics.push(...page.topics);
      hasMore = page.hasMore;
      if (hasMore && page.nextOffset === undefined) {
        throw new Error("Council API topics 分页缺少 nextOffset");
      }
      if (hasMore && (page.nextOffset ?? offset) <= offset) {
        throw new Error("Council API topics 分页游标没有前进");
      }
      offset = page.nextOffset ?? offset;
    }
    return topics;
  }

  async #loadTopicDetail(topicId: string): Promise<ApiTopicDetail> {
    return requestApiData(
      this.#fetcher,
      createApiUrl(
        this.#baseUrl,
        `/api/v1/topics/${encodeURIComponent(topicId)}`,
        { messageLimit: this.#messagePageSize, messageOffset: 0 },
      ),
      parseApiTopicDetail,
    );
  }

  #openEventStream(): void {
    const eventUrl = createApiUrl(this.#baseUrl, "/api/v1/events", {
      projectPath: this.#projectPath,
    });
    const stream = this.#eventStreamFactory(eventUrl.toString());
    const generation = ++this.#eventStreamGeneration;
    this.#eventStream = stream;
    stream.addEventListener("open", () => {
      if (generation !== this.#eventStreamGeneration || this.#eventStream !== stream) {
        return;
      }
      this.#eventConnected = true;
      this.#publishSync("connected", "API 与实时同步已连接");
      if (this.#failedRevision !== undefined && this.#queuedRevision === undefined) {
        this.#queuedRevision = this.#failedRevision;
        this.#refreshRequested = true;
        void this.#drainRefreshQueue();
      }
    });
    stream.addEventListener("error", () => {
      if (generation !== this.#eventStreamGeneration || this.#eventStream !== stream) {
        return;
      }
      this.#eventConnected = false;
      this.#publishSync("offline", "实时同步已断开 · 浏览器重连中");
    });
    stream.addEventListener("council.changed", (event) => {
      if (generation !== this.#eventStreamGeneration || this.#eventStream !== stream) {
        return;
      }
      const revision = parseCouncilChangedRevision(event);
      if (
        revision === undefined
        || (revision === this.#observedTotalRevision && revision !== this.#failedRevision)
        || revision === this.#queuedRevision
        || revision === this.#refreshingRevision
      ) {
        return;
      }
      this.#queuedRevision = revision;
      this.#refreshRequested = true;
      void this.#drainRefreshQueue();
    });
  }

  async #drainRefreshQueue(): Promise<void> {
    if (this.#refreshRunning) {
      return;
    }
    this.#refreshRunning = true;
    try {
      while (this.#refreshRequested && this.#listeners.size > 0) {
        this.#refreshRequested = false;
        const targetRevision = this.#queuedRevision;
        this.#queuedRevision = undefined;
        if (
          targetRevision !== undefined
          && targetRevision === this.#observedTotalRevision
          && targetRevision !== this.#failedRevision
        ) {
          continue;
        }
        this.#refreshingRevision = targetRevision;
        try {
          const refreshed = await this.#refreshRevisionWithRetry(targetRevision);
          if (refreshed && targetRevision !== undefined) {
            this.#failedRevision = undefined;
            this.#cancelRecoveryTimer();
          } else if (targetRevision !== undefined) {
            this.#failedRevision = targetRevision;
            this.#scheduleRecovery();
          }
        } finally {
          if (this.#refreshingRevision === targetRevision) {
            this.#refreshingRevision = undefined;
          }
        }
      }
    } finally {
      this.#refreshRunning = false;
    }
  }

  async #refreshRevisionWithRetry(targetRevision: number | undefined): Promise<boolean> {
    for (let attempt = 1; attempt <= this.#eventRefreshMaxAttempts; attempt += 1) {
      if (this.#listeners.size === 0) {
        return false;
      }
      try {
        await this.#refreshAfterExistingLoad(targetRevision);
        return true;
      } catch {
        if (
          attempt >= this.#eventRefreshMaxAttempts
          || this.#listeners.size === 0
          || (this.#queuedRevision !== undefined && this.#queuedRevision !== targetRevision)
        ) {
          return false;
        }
        const shouldContinue = await this.#waitForRetry(
          this.#eventRefreshRetryDelayMs * attempt,
        );
        if (!shouldContinue) {
          return false;
        }
      }
    }
    return false;
  }

  async #waitForRetry(delayMs: number): Promise<boolean> {
    if (this.#listeners.size === 0) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      this.#retryWaitResolver = resolve;
      this.#retryTimer = globalThis.setTimeout(() => {
        this.#retryTimer = undefined;
        this.#retryWaitResolver = undefined;
        resolve(this.#listeners.size > 0);
      }, delayMs);
    });
  }

  #cancelRetryWait(): void {
    if (this.#retryTimer !== undefined) {
      globalThis.clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    const resolve = this.#retryWaitResolver;
    this.#retryWaitResolver = undefined;
    resolve?.(false);
  }

  #scheduleRecovery(): void {
    if (
      this.#recoveryTimer !== undefined
      || this.#failedRevision === undefined
      || this.#listeners.size === 0
    ) {
      return;
    }
    this.#recoveryTimer = globalThis.setTimeout(() => {
      this.#recoveryTimer = undefined;
      const failedRevision = this.#failedRevision;
      if (failedRevision === undefined || this.#listeners.size === 0) {
        return;
      }
      if (this.#refreshRunning || this.#queuedRevision !== undefined) {
        this.#scheduleRecovery();
        return;
      }
      this.#queuedRevision = failedRevision;
      this.#refreshRequested = true;
      void this.#drainRefreshQueue();
    }, this.#eventRecoveryDelayMs);
  }

  #cancelRecoveryTimer(): void {
    if (this.#recoveryTimer === undefined) {
      return;
    }
    globalThis.clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
  }

  async #refreshAfterExistingLoad(_targetRevision: number | undefined): Promise<WorkspaceSnapshot> {
    const existingLoad = this.#loadPromise;
    if (existingLoad) {
      try {
        await existingLoad;
      } catch {
        // changed 事件必须在旧请求结束后再发起一轮，不复用旧结果。
      }
    }
    const statusRevisions = await this.#loadStatusRevisions();
    this.#observedTotalRevision = statusRevisions.revision;
    if (statusRevisions.content === this.#appliedContentRevision && this.#snapshot) {
      return cloneSnapshot(this.#snapshot);
    }
    return this.loadWorkspace();
  }

  async #loadStatusRevisions() {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/status"),
      parseCouncilStatusRevisions,
    );
  }

  async #reloadAfterMutation(topicId: string): Promise<WorkspaceSnapshot> {
    const existingLoad = this.#loadPromise;
    if (existingLoad) {
      try {
        await existingLoad;
      } catch {
        // 写入已成功，必须丢弃写入前的旧读取并重新校准。
      }
    }
    this.#activeTopicId = topicId;
    return this.loadWorkspace();
  }

  #connectedSyncState(): WorkspaceSnapshot["sync"] {
    const hasWaitingEventStream = Boolean(this.#eventStream) && !this.#eventConnected;
    return {
      status: hasWaitingEventStream ? "syncing" : "connected",
      label: this.#eventConnected
        ? "API 与实时同步已连接"
        : hasWaitingEventStream
          ? "API 已连接 · 实时通道重连中"
          : "API 已连接",
    };
  }

  #publishSync(status: WorkspaceSnapshot["sync"]["status"], label: string): void {
    if (!this.#snapshot) {
      return;
    }
    this.#snapshot = {
      ...this.#snapshot,
      sync: { status, label },
    };
    this.#publishSnapshot();
  }

  async #requestMutation<T>(
    url: URL,
    body: unknown,
    parser: (data: unknown) => T,
  ): Promise<T> {
    try {
      return await requestApiData(this.#fetcher, url, parser, jsonRequest(body));
    } catch (error: unknown) {
      this.#publishSync("offline", "API 写入失败 · 可重试");
      throw error;
    }
  }

  #publishSnapshot(): void {
    if (!this.#snapshot) {
      return;
    }
    for (const listener of this.#listeners) {
      listener(cloneSnapshot(this.#snapshot));
    }
  }
}
