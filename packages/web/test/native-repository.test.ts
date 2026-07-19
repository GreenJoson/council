/**
 * @input  依赖：DesktopBridge 假实现与 Rust 同形领域响应
 * @output 导出：NativeCouncilRepository 加载、映射和项目切换测试
 * @pos    桌面内容闭环不依赖真实 Tauri 窗口的回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopSettings } from "../src/data/desktop-bridge";
import { NativeCouncilRepository } from "../src/data/native-repository";

const PROJECT = "/workspace/project-alpha";
const SETTINGS: DesktopSettings = {
  logLibrary: "/workspace/logs",
  currentProjectPath: PROJECT,
  recentProjectPaths: [PROJECT],
};
const TOPIC = {
  id: "topic_alpha",
  title: "桌面议题",
  question: "是否直接读取 Rust core？",
  constraints: ["共享同一 SQLite"],
  projectPath: PROJECT,
  status: "open",
  createdBy: "human",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

function topicFor(projectPath: string) {
  const suffix = projectPath.split("-").at(-1) ?? "project";
  return {
    ...TOPIC,
    id: `topic_${suffix}`,
    title: `桌面议题 ${suffix}`,
    projectPath,
  };
}

function bridge(): DesktopBridge {
  return {
    getSettings: vi.fn(async () => structuredClone(SETTINGS)),
    chooseLogLibrary: vi.fn(async () => structuredClone(SETTINGS)),
    chooseProject: vi.fn(async () => structuredClone(SETTINGS)),
    selectProject: vi.fn(async (path) => ({
      ...structuredClone(SETTINGS),
      currentProjectPath: path,
      recentProjectPaths: [path],
    })),
    listTopics: vi.fn(async () => ({
      total: 1,
      count: 1,
      offset: 0,
      hasMore: false,
      topics: [TOPIC],
    })),
    getTopic: vi.fn(async () => ({
      topic: TOPIC,
      messages: [],
      decisions: [],
      messageTotal: 0,
      messageLimit: 100,
      messageOffset: 0,
      hasMoreMessages: false,
    })),
    createTopic: vi.fn(async () => TOPIC),
    postMessage: vi.fn(async () => ({
      id: "message_alpha",
      topicId: TOPIC.id,
      author: "human",
      kind: "note",
      content: "正文",
      createdAt: TOPIC.updatedAt,
    })),
    recordDecision: vi.fn(async () => ({
      id: "decision_alpha",
      topicId: TOPIC.id,
      title: "结论",
      decision: "采用",
      rationale: "简单",
      alternatives: [],
      status: "accepted",
      createdBy: "human",
      createdAt: TOPIC.updatedAt,
      updatedAt: TOPIC.updatedAt,
    })),
    getStatus: vi.fn(async () => ({
      revision: 1,
      revisions: { content: 1, orchestration: 0 },
    })),
    listenChanged: vi.fn(async () => () => undefined),
  };
}

describe("NativeCouncilRepository", () => {
  it("从 Rust 同形响应加载项目工作区", async () => {
    const repository = new NativeCouncilRepository({
      bridge: bridge(),
      topicPageSize: 100,
      messagePageSize: 100,
      recoveryDelayMs: 60_000,
    });
    await repository.getDesktopSettings();
    const snapshot = await repository.loadWorkspace();
    expect(snapshot.project.name).toBe("project-alpha");
    expect(snapshot.topics[0]?.title).toBe("桌面议题");
    expect(snapshot.sync.status).toBe("connected");
  });

  it("切换最近项目会清空旧快照并调用原生命令", async () => {
    const injected = bridge();
    const repository = new NativeCouncilRepository({
      bridge: injected,
      topicPageSize: 100,
      messagePageSize: 100,
      recoveryDelayMs: 60_000,
    });
    await repository.getDesktopSettings();
    const settings = await repository.selectRecentProject("/workspace/project-beta");
    expect(settings.currentProjectPath).toBe("/workspace/project-beta");
    expect(injected.selectProject).toHaveBeenCalledWith("/workspace/project-beta");
  });

  it("切换项目后丢弃旧项目的在途加载结果", async () => {
    const alphaTopic = topicFor(PROJECT);
    const betaProject = "/workspace/project-beta";
    const betaTopic = topicFor(betaProject);
    let notifyAlphaStarted: (() => void) | undefined;
    let resolveAlphaPage: ((value: unknown) => void) | undefined;
    const alphaStarted = new Promise<void>((resolve) => { notifyAlphaStarted = resolve; });
    const alphaPage = new Promise<unknown>((resolve) => { resolveAlphaPage = resolve; });
    const injected = bridge();
    injected.listTopics = vi.fn(async (args: Record<string, unknown>) => {
      if (args.projectPath === PROJECT) {
        notifyAlphaStarted?.();
        return alphaPage;
      }
      return {
        total: 1,
        count: 1,
        offset: 0,
        hasMore: false,
        topics: [betaTopic],
      };
    });
    injected.getTopic = vi.fn(async (args: Record<string, unknown>) => {
      const topic = args.topicId === betaTopic.id ? betaTopic : alphaTopic;
      return {
        topic,
        messages: [],
        decisions: [],
        messageTotal: 0,
        messageLimit: 100,
        messageOffset: 0,
        hasMoreMessages: false,
      };
    });
    const repository = new NativeCouncilRepository({
      bridge: injected,
      topicPageSize: 100,
      messagePageSize: 100,
      recoveryDelayMs: 60_000,
    });
    await repository.getDesktopSettings();

    const staleLoad = repository.loadWorkspace();
    await alphaStarted;
    await repository.selectRecentProject(betaProject);
    const currentSnapshot = await repository.loadWorkspace();
    resolveAlphaPage?.({
      total: 1,
      count: 1,
      offset: 0,
      hasMore: false,
      topics: [alphaTopic],
    });

    await expect(staleLoad).rejects.toThrow("旧工作区加载结果已忽略");
    expect(currentSnapshot.project.name).toBe("project-beta");
    expect(currentSnapshot.topics[0]?.id).toBe(betaTopic.id);
  });
});
