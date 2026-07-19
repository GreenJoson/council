/**
 * @input  依赖：DesktopBridge、API 严格解析器和 Workspace mapper
 * @output 导出：NativeCouncilRepository 与桌面仓储类型守卫
 * @pos    Tauri 模式下绕过 HTTP、直接读写 Rust council-core 的内容仓储
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  parseApiDecision,
  parseApiMessage,
  parseApiPaginatedTopics,
  parseApiTopic,
  parseApiTopicDetail,
  type ApiTopic,
} from "./api-types";
import {
  createDesktopBridge,
  type DesktopBridge,
  type DesktopSettings,
} from "./desktop-bridge";
import { readProjectPathConfig } from "./project-path";
import type { CouncilRepository, WorkspaceListener } from "./repository";
import { parseCouncilStatusRevisions } from "./status-revisions";
import { mapWorkspaceFromTopics } from "./workspace-mapper";
import type {
  CreateTopicInput,
  PublishMessageInput,
  WorkspaceSnapshot,
} from "../types/council";

export interface NativeCouncilRepositoryOptions {
  bridge?: DesktopBridge;
  topicPageSize: number;
  messagePageSize: number;
  recoveryDelayMs: number;
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return structuredClone(snapshot);
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Council workspace";
}

export class NativeCouncilRepository implements CouncilRepository {
  readonly isDesktop = true;
  readonly #bridge: DesktopBridge;
  readonly #topicPageSize: number;
  readonly #messagePageSize: number;
  readonly #recoveryDelayMs: number;
  readonly #listeners = new Set<WorkspaceListener>();
  #settings: DesktopSettings | undefined;
  #topics: ApiTopic[] = [];
  #activeTopicId: string | undefined;
  #snapshot: WorkspaceSnapshot | undefined;
  #observedRevision = -1;
  #pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  #unlisten: UnlistenFn | undefined;
  #refreshPromise: Promise<WorkspaceSnapshot> | undefined;
  #settingsGeneration = 0;

  constructor(options: NativeCouncilRepositoryOptions) {
    if (!Number.isSafeInteger(options.topicPageSize) || options.topicPageSize <= 0) {
      throw new Error("topicPageSize 必须是正整数");
    }
    if (!Number.isSafeInteger(options.messagePageSize) || options.messagePageSize <= 0) {
      throw new Error("messagePageSize 必须是正整数");
    }
    if (!Number.isSafeInteger(options.recoveryDelayMs) || options.recoveryDelayMs <= 0) {
      throw new Error("recoveryDelayMs 必须是正整数");
    }
    this.#bridge = options.bridge ?? createDesktopBridge();
    this.#topicPageSize = options.topicPageSize;
    this.#messagePageSize = options.messagePageSize;
    this.#recoveryDelayMs = options.recoveryDelayMs;
  }

  async getDesktopSettings(): Promise<DesktopSettings> {
    return this.#applySettings(await this.#bridge.getSettings());
  }

  async chooseLogLibrary(): Promise<DesktopSettings | undefined> {
    const settings = await this.#bridge.chooseLogLibrary();
    return settings ? this.#applySettings(settings) : undefined;
  }

  async chooseProject(): Promise<DesktopSettings | undefined> {
    const settings = await this.#bridge.chooseProject();
    return settings ? this.#applySettings(settings) : undefined;
  }

  async selectRecentProject(path: string): Promise<DesktopSettings> {
    readProjectPathConfig(path);
    return this.#applySettings(await this.#bridge.selectProject(path));
  }

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }
    const generation = this.#settingsGeneration;
    const promise = this.#performLoad(generation);
    this.#refreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#refreshPromise === promise) {
        this.#refreshPromise = undefined;
      }
    }
  }

  async selectTopic(topicId: string): Promise<WorkspaceSnapshot> {
    if (!this.#topics.some((topic) => topic.id === topicId)) {
      throw new Error("议题不存在或已被移除");
    }
    const generation = this.#settingsGeneration;
    const detail = parseApiTopicDetail(await this.#bridge.getTopic({
      topicId,
      messageLimit: this.#messagePageSize,
      messageOffset: 0,
    }));
    this.#assertGeneration(generation);
    this.#activeTopicId = topicId;
    this.#snapshot = this.#map(detail);
    this.#publish();
    return cloneSnapshot(this.#snapshot);
  }

  async createTopic(input: CreateTopicInput): Promise<WorkspaceSnapshot> {
    const projectPath = this.#requireConfigured().currentProjectPath;
    const generation = this.#settingsGeneration;
    const topic = parseApiTopic(await this.#bridge.createTopic({
      title: input.title,
      question: input.question,
      constraints: input.constraints,
      projectPath,
    }));
    this.#assertGeneration(generation);
    this.#activeTopicId = topic.id;
    return this.loadWorkspace();
  }

  async publishMessage(input: PublishMessageInput): Promise<WorkspaceSnapshot> {
    const generation = this.#settingsGeneration;
    parseApiMessage(await this.#bridge.postMessage({
      topicId: input.topicId,
      kind: input.kind,
      content: input.content,
    }));
    this.#assertGeneration(generation);
    this.#activeTopicId = input.topicId;
    return this.loadWorkspace();
  }

  async acceptDecision(topicId: string): Promise<WorkspaceSnapshot> {
    const topic = this.#snapshot?.topics.find((candidate) => candidate.id === topicId);
    if (!topic?.decision) {
      throw new Error("当前议题没有可接受的拟议决策");
    }
    if (topic.decision.status === "accepted") {
      return cloneSnapshot(this.#snapshot as WorkspaceSnapshot);
    }
    const generation = this.#settingsGeneration;
    parseApiDecision(await this.#bridge.recordDecision({
      topicId,
      title: topic.decision.title,
      decision: topic.decision.summary,
      rationale: topic.decision.rationale,
      alternatives: topic.alternatives.map((alternative) => alternative.title),
      status: "accepted",
    }));
    this.#assertGeneration(generation);
    this.#activeTopicId = topicId;
    return this.loadWorkspace();
  }

  subscribe(listener: WorkspaceListener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      void this.#bridge.listenChanged(() => void this.#refreshIfChanged())
        .then((unlisten) => {
          if (this.#listeners.size === 0) {
            unlisten();
          } else {
            this.#unlisten = unlisten;
          }
        });
      this.#pollTimer = globalThis.setInterval(
        () => void this.#refreshIfChanged(),
        this.#recoveryDelayMs,
      );
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#unlisten?.();
        this.#unlisten = undefined;
        if (this.#pollTimer) {
          globalThis.clearInterval(this.#pollTimer);
          this.#pollTimer = undefined;
        }
      }
    };
  }

  #applySettings(settings: DesktopSettings): DesktopSettings {
    this.#settingsGeneration += 1;
    this.#settings = structuredClone(settings);
    this.#topics = [];
    this.#activeTopicId = undefined;
    this.#snapshot = undefined;
    this.#observedRevision = -1;
    this.#refreshPromise = undefined;
    return structuredClone(settings);
  }

  #requireConfigured(): { logLibrary: string; currentProjectPath: string } {
    const logLibrary = this.#settings?.logLibrary;
    const currentProjectPath = this.#settings?.currentProjectPath;
    if (!logLibrary || !currentProjectPath) {
      throw new Error("请先设置日志库并选择项目目录");
    }
    return {
      logLibrary,
      currentProjectPath: readProjectPathConfig(currentProjectPath),
    };
  }

  async #performLoad(generation: number): Promise<WorkspaceSnapshot> {
    if (!this.#settings) {
      this.#settings = await this.#bridge.getSettings();
      this.#assertGeneration(generation);
    }
    const { currentProjectPath } = this.#requireConfigured();
    const status = parseCouncilStatusRevisions(await this.#bridge.getStatus());
    this.#assertGeneration(generation);
    const topics: ApiTopic[] = [];
    let offset = 0;
    while (true) {
      const page = parseApiPaginatedTopics(await this.#bridge.listTopics({
        projectPath: currentProjectPath,
        limit: this.#topicPageSize,
        offset,
      }));
      this.#assertGeneration(generation);
      topics.push(...page.topics);
      if (!page.hasMore || page.nextOffset === undefined) {
        break;
      }
      offset = page.nextOffset;
    }
    const activeTopicId = topics.some((topic) => topic.id === this.#activeTopicId)
      ? this.#activeTopicId
      : topics[0]?.id;
    const detail = activeTopicId
      ? parseApiTopicDetail(await this.#bridge.getTopic({
        topicId: activeTopicId,
        messageLimit: this.#messagePageSize,
        messageOffset: 0,
      }))
      : undefined;
    this.#assertGeneration(generation);
    this.#topics = topics;
    this.#activeTopicId = activeTopicId;
    this.#observedRevision = status.revision;
    this.#snapshot = this.#map(detail, currentProjectPath);
    this.#publish();
    return cloneSnapshot(this.#snapshot);
  }

  #map(
    detail: ReturnType<typeof parseApiTopicDetail> | undefined,
    currentProjectPath = this.#requireConfigured().currentProjectPath,
  ): WorkspaceSnapshot {
    const snapshot = mapWorkspaceFromTopics(
      this.#topics,
      detail,
      { status: "connected", label: "Rust 本地库已连接" },
    );
    snapshot.project = {
      id: currentProjectPath,
      name: projectName(currentProjectPath),
    };
    return snapshot;
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#settingsGeneration) {
      throw new Error("项目已切换，旧工作区加载结果已忽略");
    }
  }

  async #refreshIfChanged(): Promise<void> {
    if (!this.#snapshot || this.#refreshPromise || !this.#settings?.logLibrary) {
      return;
    }
    try {
      const status = parseCouncilStatusRevisions(await this.#bridge.getStatus());
      if (status.revision !== this.#observedRevision) {
        await this.loadWorkspace();
      }
    } catch {
      // 下一次恢复轮询继续尝试；现有快照保持可读。
    }
  }

  #publish(): void {
    if (!this.#snapshot) {
      return;
    }
    for (const listener of this.#listeners) {
      listener(cloneSnapshot(this.#snapshot));
    }
  }
}

export function isNativeCouncilRepository(
  repository: CouncilRepository,
): repository is NativeCouncilRepository {
  return repository instanceof NativeCouncilRepository;
}
