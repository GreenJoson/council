/**
 * @input  依赖：Council orchestration REST/SSE、状态 revision 与严格解析器
 * @output 导出：HttpOrchestrationRepository 独立自动轮次仓储
 * @pos    仅在 orchestration revision 变化时校准当前议题运行列表
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";
import { createApiUrl, jsonRequest, requestApiData, type Fetcher } from "./http-client";
import type { EventStream, EventStreamFactory } from "./http-repository";
import { parseCouncilChangedRevision } from "./http-repository";
import {
  parseOrchestrationCapabilities,
  parseOrchestrationApprovalResult,
  parseOrchestrationRun,
  parseOrchestrationRunPage,
} from "./orchestration-api";
import type {
  OrchestrationListener,
  OrchestrationRepository,
} from "./orchestration-repository";
import { parseCouncilStatusRevisions } from "./status-revisions";

export interface HttpOrchestrationRepositoryOptions {
  baseUrl: string;
  fetcher?: Fetcher;
  eventStreamFactory?: EventStreamFactory;
  runPageSize: number;
  eventRefreshMaxAttempts: number;
  eventRefreshRetryDelayMs: number;
  eventRecoveryDelayMs: number;
}

function browserEventStreamFactory(url: string): EventStream {
  return new EventSource(url);
}

function cloneSnapshot(snapshot: OrchestrationSnapshot): OrchestrationSnapshot {
  return structuredClone(snapshot);
}

export class HttpOrchestrationRepository implements OrchestrationRepository {
  readonly #baseUrl: string;
  readonly #fetcher: Fetcher;
  readonly #eventStreamFactory: EventStreamFactory;
  readonly #runPageSize: number;
  readonly #eventRefreshMaxAttempts: number;
  readonly #eventRefreshRetryDelayMs: number;
  readonly #eventRecoveryDelayMs: number;
  readonly #listeners = new Set<OrchestrationListener>();
  #snapshot: OrchestrationSnapshot = {
    runs: [],
    sync: { status: "syncing", label: "正在读取自动轮次能力…" },
  };
  #eventStream: EventStream | undefined;
  #eventGeneration = 0;
  #selectionGeneration = 0;
  #selectionPromise: Promise<OrchestrationSnapshot> | undefined;
  #observedTotalRevision = -1;
  #appliedOrchestrationRevision = -1;
  #queuedTotalRevision: number | undefined;
  #refreshRunning = false;
  #failedTotalRevision: number | undefined;
  #retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #retryResolver: ((continueRetry: boolean) => void) | undefined;
  #recoveryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(options: HttpOrchestrationRepositoryOptions) {
    createApiUrl(options.baseUrl, "/api/v1/orchestration/capabilities");
    if (!Number.isSafeInteger(options.runPageSize) || options.runPageSize <= 0) {
      throw new Error("runPageSize 必须是正整数");
    }
    if (
      !Number.isSafeInteger(options.eventRefreshMaxAttempts)
      || options.eventRefreshMaxAttempts <= 0
    ) {
      throw new Error("eventRefreshMaxAttempts 必须是正整数");
    }
    if (
      !Number.isSafeInteger(options.eventRefreshRetryDelayMs)
      || options.eventRefreshRetryDelayMs < 0
    ) {
      throw new Error("eventRefreshRetryDelayMs 必须是非负整数");
    }
    if (
      !Number.isSafeInteger(options.eventRecoveryDelayMs)
      || options.eventRecoveryDelayMs <= 0
    ) {
      throw new Error("eventRecoveryDelayMs 必须是正整数");
    }
    this.#baseUrl = options.baseUrl;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.#eventStreamFactory = options.eventStreamFactory ?? browserEventStreamFactory;
    this.#runPageSize = options.runPageSize;
    this.#eventRefreshMaxAttempts = options.eventRefreshMaxAttempts;
    this.#eventRefreshRetryDelayMs = options.eventRefreshRetryDelayMs;
    this.#eventRecoveryDelayMs = options.eventRecoveryDelayMs;
  }

  async loadCapabilities(): Promise<OrchestrationSnapshot> {
    this.#publishSync("syncing", "正在读取自动轮次能力…");
    try {
      const [capabilities, status] = await Promise.all([
        requestApiData(
          this.#fetcher,
          createApiUrl(this.#baseUrl, "/api/v1/orchestration/capabilities"),
          parseOrchestrationCapabilities,
        ),
        this.#loadStatus(),
      ]);
      this.#observedTotalRevision = status.revision;
      this.#appliedOrchestrationRevision = status.orchestration;
      this.#snapshot = {
        ...this.#snapshot,
        capabilities,
        sync: { status: "connected", label: "自动轮次 API 已连接" },
      };
      return this.#publishSnapshot();
    } catch (error: unknown) {
      this.#publishSync("offline", "自动轮次 API 暂不可用");
      throw error;
    }
  }

  async selectTopic(topicId: string): Promise<OrchestrationSnapshot> {
    const normalizedTopicId = topicId.trim();
    if (!normalizedTopicId) {
      throw new Error("topicId 不能为空");
    }
    const generation = ++this.#selectionGeneration;
    this.#publishSync("syncing", "正在校准当前议题的自动轮次…");
    const promise = this.#performSelection(normalizedTopicId, generation);
    this.#selectionPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#selectionPromise === promise) {
        this.#selectionPromise = undefined;
      }
    }
  }

  async #performSelection(
    topicId: string,
    generation: number,
  ): Promise<OrchestrationSnapshot> {
    try {
      const status = await this.#loadStatus();
      const runs = await this.#loadAllRuns(topicId);
      if (generation !== this.#selectionGeneration) {
        return cloneSnapshot(this.#snapshot);
      }
      this.#observedTotalRevision = status.revision;
      this.#appliedOrchestrationRevision = status.orchestration;
      this.#snapshot = {
        ...this.#snapshot,
        activeTopicId: topicId,
        runs,
        sync: { status: "connected", label: "自动轮次已同步" },
      };
      return this.#publishSnapshot();
    } catch (error: unknown) {
      if (generation === this.#selectionGeneration) {
        this.#publishSync("offline", "自动轮次加载失败 · 可重试");
      }
      throw error;
    }
  }

  async getRun(runId: string): Promise<OrchestrationRun> {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, `/api/v1/runs/${encodeURIComponent(runId)}`),
      parseOrchestrationRun,
    );
  }

  async createRun(input: CreateOrchestrationRunInput): Promise<OrchestrationRun> {
    const selectionGeneration = this.#selectionGeneration;
    const activeTopicId = this.#snapshot.activeTopicId;
    const run = await this.#mutateRun(
      createApiUrl(
        this.#baseUrl,
        `/api/v1/topics/${encodeURIComponent(input.topicId)}/runs`,
      ),
      { plan: input.plan },
    );
    if (this.#canRefreshMutation(selectionGeneration, activeTopicId, run.topicId)) {
      await this.selectTopic(run.topicId);
      return this.#snapshot.runs.find((candidate) => candidate.id === run.id) ?? run;
    }
    return run;
  }

  async startRun(runId: string): Promise<OrchestrationSnapshot> {
    return this.#runAction(runId, "start");
  }

  async approveRun(input: ApproveOrchestrationRunInput): Promise<OrchestrationSnapshot> {
    const selectionGeneration = this.#selectionGeneration;
    const activeTopicId = this.#snapshot.activeTopicId;
    let result;
    try {
      result = await requestApiData(
        this.#fetcher,
      createApiUrl(
        this.#baseUrl,
        `/api/v1/runs/${encodeURIComponent(input.runId)}/approvals`,
      ),
        parseOrchestrationApprovalResult,
        jsonRequest({
          expectedGateId: input.expectedGateId,
          expectedVersion: input.expectedVersion,
          approvalId: input.approvalId,
        }),
      );
    } catch (error: unknown) {
      this.#publishSync("offline", "自动轮次操作失败 · 状态未假定成功");
      throw error;
    }
    return this.#canRefreshMutation(
      selectionGeneration,
      activeTopicId,
      result.run.topicId,
    )
      ? this.selectTopic(result.run.topicId)
      : cloneSnapshot(this.#snapshot);
  }

  async cancelRun(runId: string): Promise<OrchestrationSnapshot> {
    return this.#runAction(runId, "cancel");
  }

  async recoverRun(runId: string): Promise<OrchestrationSnapshot> {
    return this.#runAction(runId, "recover");
  }

  subscribe(listener: OrchestrationListener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#openEventStream();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#eventStream?.close();
        this.#eventStream = undefined;
        this.#eventGeneration += 1;
        this.#queuedTotalRevision = undefined;
        this.#failedTotalRevision = undefined;
        this.#cancelRetry();
        this.#cancelRecovery();
      }
    };
  }

  async #runAction(
    runId: string,
    action: "start" | "cancel" | "recover",
  ): Promise<OrchestrationSnapshot> {
    const selectionGeneration = this.#selectionGeneration;
    const activeTopicId = this.#snapshot.activeTopicId;
    const run = await this.#mutateRun(
      createApiUrl(
        this.#baseUrl,
        `/api/v1/runs/${encodeURIComponent(runId)}/actions/${action}`,
      ),
      {},
    );
    return this.#canRefreshMutation(selectionGeneration, activeTopicId, run.topicId)
      ? this.selectTopic(run.topicId)
      : cloneSnapshot(this.#snapshot);
  }

  #canRefreshMutation(
    selectionGeneration: number,
    activeTopicId: string | undefined,
    resultTopicId: string,
  ): boolean {
    return selectionGeneration === this.#selectionGeneration
      && activeTopicId === resultTopicId
      && this.#snapshot.activeTopicId === resultTopicId;
  }

  async #mutateRun(url: URL, body: unknown): Promise<OrchestrationRun> {
    try {
      return await requestApiData(
        this.#fetcher,
        url,
        parseOrchestrationRun,
        jsonRequest(body),
      );
    } catch (error: unknown) {
      this.#publishSync("offline", "自动轮次操作失败 · 状态未假定成功");
      throw error;
    }
  }

  async #loadStatus() {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/status"),
      parseCouncilStatusRevisions,
    );
  }

  async #loadAllRuns(topicId: string): Promise<OrchestrationRun[]> {
    const runs: OrchestrationRun[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await requestApiData(
        this.#fetcher,
        createApiUrl(
          this.#baseUrl,
          `/api/v1/topics/${encodeURIComponent(topicId)}/runs`,
          { limit: this.#runPageSize, offset },
        ),
        parseOrchestrationRunPage,
      );
      runs.push(...page.runs);
      hasMore = page.hasMore;
      if (hasMore && page.nextOffset === undefined) {
        throw new Error("Council API runs 分页缺少 nextOffset");
      }
      if (hasMore && (page.nextOffset ?? offset) <= offset) {
        throw new Error("Council API runs 分页游标没有前进");
      }
      offset = page.nextOffset ?? offset;
    }
    return runs;
  }

  #openEventStream(): void {
    const stream = this.#eventStreamFactory(
      createApiUrl(this.#baseUrl, "/api/v1/events").toString(),
    );
    const generation = ++this.#eventGeneration;
    this.#eventStream = stream;
    stream.addEventListener("open", () => {
      if (generation !== this.#eventGeneration || this.#eventStream !== stream) {
        return;
      }
      this.#publishSync("connected", "自动轮次实时校准已连接");
      if (this.#failedTotalRevision !== undefined) {
        this.#queueRefresh(this.#failedTotalRevision);
      }
    });
    stream.addEventListener("error", () => {
      if (generation === this.#eventGeneration && this.#eventStream === stream) {
        this.#publishSync("offline", "自动轮次实时校准已断开");
      }
    });
    stream.addEventListener("council.changed", (event) => {
      if (generation !== this.#eventGeneration || this.#eventStream !== stream) {
        return;
      }
      const revision = parseCouncilChangedRevision(event);
      if (
        revision === undefined
        || (
          revision === this.#observedTotalRevision
          && revision !== this.#failedTotalRevision
        )
      ) {
        return;
      }
      this.#queueRefresh(revision);
    });
  }

  #queueRefresh(totalRevision: number): void {
    this.#queuedTotalRevision = totalRevision;
    if (!this.#refreshRunning) {
      void this.#drainRefreshQueue();
    }
  }

  async #drainRefreshQueue(): Promise<void> {
    this.#refreshRunning = true;
    const generation = this.#eventGeneration;
    try {
      while (this.#queuedTotalRevision !== undefined && this.#listeners.size > 0) {
        if (generation !== this.#eventGeneration) {
          break;
        }
        const target = this.#queuedTotalRevision;
        this.#queuedTotalRevision = undefined;
        if (
          target === this.#observedTotalRevision
          && target !== this.#failedTotalRevision
        ) {
          continue;
        }
        const refreshed = await this.#refreshWithRetry(target, generation);
        if (refreshed) {
          this.#failedTotalRevision = undefined;
          this.#cancelRecovery();
        } else if (this.#listeners.size > 0 && generation === this.#eventGeneration) {
          this.#failedTotalRevision = target;
          this.#scheduleRecovery();
        }
      }
    } finally {
      this.#refreshRunning = false;
      if (this.#queuedTotalRevision !== undefined && this.#listeners.size > 0) {
        void this.#drainRefreshQueue();
      }
    }
  }

  async #refreshWithRetry(target: number, generation: number): Promise<boolean> {
    for (let attempt = 1; attempt <= this.#eventRefreshMaxAttempts; attempt += 1) {
      if (this.#listeners.size === 0 || generation !== this.#eventGeneration) {
        return false;
      }
      try {
        const pendingSelection = this.#selectionPromise;
        if (pendingSelection) {
          try {
            await pendingSelection;
          } catch {
            // 选题失败不消费 SSE；继续按当前有效议题校准目标 revision。
          }
        }
        if (this.#listeners.size === 0 || generation !== this.#eventGeneration) {
          return false;
        }
        const status = await this.#loadStatus();
        if (this.#listeners.size === 0 || generation !== this.#eventGeneration) {
          return false;
        }
        this.#observedTotalRevision = status.revision;
        if (status.orchestration !== this.#appliedOrchestrationRevision) {
          const topicId = this.#snapshot.activeTopicId;
          const selectionGeneration = this.#selectionGeneration;
          const runs = topicId ? await this.#loadAllRuns(topicId) : [];
          if (
            this.#listeners.size === 0
            || generation !== this.#eventGeneration
            || selectionGeneration !== this.#selectionGeneration
            || this.#snapshot.activeTopicId !== topicId
          ) {
            return false;
          }
          this.#appliedOrchestrationRevision = status.orchestration;
          this.#snapshot = {
            ...this.#snapshot,
            runs,
            sync: { status: "connected", label: "自动轮次已实时校准" },
          };
          this.#publishSnapshot();
        }
        return true;
      } catch {
        if (attempt >= this.#eventRefreshMaxAttempts) {
          return false;
        }
        const continueRetry = await this.#waitForRetry(
          this.#eventRefreshRetryDelayMs * attempt,
        );
        if (!continueRetry) {
          return false;
        }
      }
    }
    return false;
  }

  #waitForRetry(delayMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#retryResolver = resolve;
      this.#retryTimer = globalThis.setTimeout(() => {
        this.#retryTimer = undefined;
        this.#retryResolver = undefined;
        resolve(this.#listeners.size > 0);
      }, delayMs);
    });
  }

  #cancelRetry(): void {
    if (this.#retryTimer !== undefined) {
      globalThis.clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    const resolve = this.#retryResolver;
    this.#retryResolver = undefined;
    resolve?.(false);
  }

  #scheduleRecovery(): void {
    if (this.#recoveryTimer !== undefined || this.#listeners.size === 0) {
      return;
    }
    this.#recoveryTimer = globalThis.setTimeout(() => {
      this.#recoveryTimer = undefined;
      if (this.#failedTotalRevision !== undefined && this.#listeners.size > 0) {
        this.#queueRefresh(this.#failedTotalRevision);
      }
    }, this.#eventRecoveryDelayMs);
  }

  #cancelRecovery(): void {
    if (this.#recoveryTimer !== undefined) {
      globalThis.clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = undefined;
    }
  }

  #publishSync(status: OrchestrationSnapshot["sync"]["status"], label: string): void {
    this.#snapshot = { ...this.#snapshot, sync: { status, label } };
    this.#publishSnapshot();
  }

  #publishSnapshot(): OrchestrationSnapshot {
    const snapshot = cloneSnapshot(this.#snapshot);
    for (const listener of this.#listeners) {
      listener(cloneSnapshot(snapshot));
    }
    return snapshot;
  }
}
