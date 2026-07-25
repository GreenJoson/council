/**
 * @input  依赖：DesktopOrchestrationRepository、桥接/委托替身与假定时器
 * @output 导出：桌面编排接入的地址解析、离线降级、自动拉起与自动转 LIVE 回归测试
 * @pos    桌面模式自动轮次健康探测与降级判断的行为验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseOrchestrationBaseUrl,
  parseOrchestrationConfig,
  parseOrchestrationHealth,
} from "../src/data/desktop-bridge";
import {
  buildOfflineOrchestrationSnapshot,
  DesktopOrchestrationRepository,
  type DesktopOrchestrationBridge,
} from "../src/data/desktop-orchestration-repository";
import type {
  OrchestrationRepository,
} from "../src/data/orchestration-repository";
import type { OrchestrationSnapshot } from "../src/types/orchestration";

const BASE_URL = "http://127.0.0.1:4317";
const HEALTH_INTERVAL_MS = 4_000;

function liveSnapshot(label: string, activeTopicId?: string): OrchestrationSnapshot {
  return {
    capabilities: {
      adapters: [{
        id: "claude-code",
        actorId: "claude",
        label: "Claude",
        available: true,
      }],
      defaultPolicy: {
        maxRounds: 8,
        agentTimeoutMs: 180_000,
        maxAttemptsPerRound: 2,
        maxManualRecoveries: 2,
        confirmation: { beforeRounds: [], beforeCompletion: true },
      },
    },
    ...(activeTopicId ? { activeTopicId } : {}),
    runs: [],
    sync: { status: "connected", label },
  };
}

interface FakeDelegate extends OrchestrationRepository {
  calls: string[];
  listenerCount: number;
}

function createFakeDelegate(): FakeDelegate {
  const listeners = new Set<(snapshot: OrchestrationSnapshot) => void>();
  const delegate: FakeDelegate = {
    calls: [],
    get listenerCount() {
      return listeners.size;
    },
    async loadCapabilities() {
      delegate.calls.push("loadCapabilities");
      return liveSnapshot("自动轮次 API 已连接");
    },
    async selectTopic(topicId: string) {
      delegate.calls.push(`selectTopic:${topicId}`);
      const snapshot = liveSnapshot("自动轮次已同步", topicId);
      for (const listener of listeners) {
        listener(structuredClone(snapshot));
      }
      return snapshot;
    },
    async getRun() {
      throw new Error("not used");
    },
    async createRun(input) {
      delegate.calls.push(`createRun:${input.topicId}`);
      throw new Error("not used");
    },
    async startRun() {
      throw new Error("not used");
    },
    async approveRun() {
      throw new Error("not used");
    },
    async cancelRun() {
      throw new Error("not used");
    },
    async recoverRun() {
      throw new Error("not used");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return delegate;
}

interface Fixture {
  bridge: DesktopOrchestrationBridge & {
    checkCalls: number;
    startCalls: number;
    setReachable(value: boolean): void;
    setAutostartConfigured(value: boolean): void;
    failConfig(value: boolean): void;
  };
  repository: DesktopOrchestrationRepository;
  delegates: FakeDelegate[];
}

function createFixture(): Fixture {
  let reachable = false;
  let autostartConfigured = false;
  let configShouldFail = false;
  const delegates: FakeDelegate[] = [];
  const bridge: Fixture["bridge"] = {
    checkCalls: 0,
    startCalls: 0,
    setReachable(value) {
      reachable = value;
    },
    setAutostartConfigured(value) {
      autostartConfigured = value;
    },
    failConfig(value) {
      configShouldFail = value;
    },
    async getOrchestrationConfig() {
      if (configShouldFail) {
        throw new Error("桥接不可用");
      }
      return { baseUrl: BASE_URL, autostartConfigured };
    },
    async checkOrchestrationService() {
      bridge.checkCalls += 1;
      return { baseUrl: BASE_URL, reachable };
    },
    async startOrchestrationService() {
      bridge.startCalls += 1;
    },
  };
  const repository = new DesktopOrchestrationRepository({
    bridge,
    createDelegate: () => {
      const delegate = createFakeDelegate();
      delegates.push(delegate);
      return delegate;
    },
    healthCheckIntervalMs: HEALTH_INTERVAL_MS,
  });
  return { bridge, repository, delegates };
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("桌面编排桥接解析", () => {
  it("接受合法的 http/https 绝对地址并去除首尾空白", () => {
    expect(parseOrchestrationBaseUrl(` ${BASE_URL} `)).toBe(BASE_URL);
    expect(parseOrchestrationBaseUrl("https://localhost:8443")).toBe("https://localhost:8443");
  });

  it.each([
    undefined,
    "",
    "   ",
    "127.0.0.1:4317",
    "ftp://127.0.0.1:4317",
    "not a url",
  ])("拒绝非法地址：%s", (value) => {
    expect(() => parseOrchestrationBaseUrl(value)).toThrow(/编排服务地址/);
  });

  it("严格解析配置与健康响应", () => {
    expect(parseOrchestrationConfig({ baseUrl: BASE_URL, autostartConfigured: true }))
      .toEqual({ baseUrl: BASE_URL, autostartConfigured: true });
    expect(parseOrchestrationHealth({ baseUrl: BASE_URL, reachable: false }))
      .toEqual({ baseUrl: BASE_URL, reachable: false });
    expect(() => parseOrchestrationConfig({ baseUrl: BASE_URL })).toThrow(/autostartConfigured/);
    expect(() => parseOrchestrationHealth({ baseUrl: BASE_URL, reachable: "yes" }))
      .toThrow(/reachable/);
    expect(() => parseOrchestrationConfig(null)).toThrow(/必须是对象/);
  });
});

describe("桌面编排离线快照", () => {
  it("离线文案包含服务地址与可执行指引，不再提及 Rust Runtime", () => {
    const snapshot = buildOfflineOrchestrationSnapshot(BASE_URL, "topic-1");
    const limitation = snapshot.capabilities?.adapters[0]?.limitation ?? "";
    expect(limitation).toContain(BASE_URL);
    expect(limitation).toContain("Council 正在自动重试");
    expect(JSON.stringify(snapshot)).not.toContain("Rust");
    expect(snapshot.sync.status).toBe("offline");
    expect(snapshot.activeTopicId).toBe("topic-1");
    expect(snapshot.runs).toEqual([]);
  });

  it("尚未取得地址时提示正在重试读取设置", () => {
    const snapshot = buildOfflineOrchestrationSnapshot(undefined);
    expect(snapshot.capabilities?.adapters[0]?.limitation).toContain("正在重试");
  });
});

describe.sequential("DesktopOrchestrationRepository", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("服务不可达时 loadCapabilities 返回离线快照且不抛错", async () => {
    const { repository, delegates } = createFixture();
    const snapshot = await repository.loadCapabilities();
    expect(snapshot.sync.status).toBe("offline");
    expect(snapshot.capabilities?.adapters[0]?.limitation).toContain(BASE_URL);
    expect(delegates).toHaveLength(0);
  });

  it("离线时写操作抛出与面板一致的诚实指引", async () => {
    const { repository } = createFixture();
    await expect(repository.createRun({ topicId: "topic-1", plan: [] }))
      .rejects.toThrow(/内置 Agent 服务暂未就绪/);
  });

  it("离线时选题返回带 activeTopicId 的离线快照", async () => {
    const { repository } = createFixture();
    const snapshot = await repository.selectTopic("topic-9");
    expect(snapshot.activeTopicId).toBe("topic-9");
    expect(snapshot.sync.status).toBe("offline");
  });

  it("服务可达时直接委托 HTTP 仓储", async () => {
    const { bridge, repository, delegates } = createFixture();
    bridge.setReachable(true);
    const snapshot = await repository.loadCapabilities();
    expect(snapshot.sync.status).toBe("connected");
    expect(delegates).toHaveLength(1);
    expect(delegates[0]?.calls).toContain("loadCapabilities");
  });

  it("配置了 autostart 时只尝试拉起一次并继续探测", async () => {
    const { bridge, repository } = createFixture();
    bridge.setAutostartConfigured(true);
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadCapabilities();
    expect(bridge.startCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);
    expect(bridge.startCalls).toBe(1);
    expect(bridge.checkCalls).toBeGreaterThanOrEqual(3);
    unsubscribe();
  });

  it("桥接配置读取失败按离线处理并周期重试", async () => {
    const { bridge, repository } = createFixture();
    bridge.failConfig(true);
    const unsubscribe = repository.subscribe(() => undefined);
    const snapshot = await repository.loadCapabilities();
    expect(snapshot.sync.status).toBe("offline");
    bridge.failConfig(false);
    bridge.setReachable(true);
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    await settleAsyncWork();
    const live = await repository.loadCapabilities();
    expect(live.sync.status).toBe("connected");
    unsubscribe();
  });

  it("服务启动后自动转 LIVE：回放已选议题并停止健康轮询", async () => {
    const { bridge, repository, delegates } = createFixture();
    const received: OrchestrationSnapshot[] = [];
    const unsubscribe = repository.subscribe((snapshot) => received.push(snapshot));
    await repository.loadCapabilities();
    await repository.selectTopic("topic-live");
    expect(received.at(-1)?.sync.status).toBe("offline");

    bridge.setReachable(true);
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    await settleAsyncWork();

    expect(delegates).toHaveLength(1);
    expect(delegates[0]?.calls).toEqual([
      "loadCapabilities",
      "selectTopic:topic-live",
    ]);
    expect(received.at(-1)?.sync.status).toBe("connected");
    expect(received.at(-1)?.activeTopicId).toBe("topic-live");

    // 转 LIVE 后健康轮询停止，不再重复探测。
    const checksAfterPromotion = bridge.checkCalls;
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
    expect(bridge.checkCalls).toBe(checksAfterPromotion);
    unsubscribe();
  });

  it("探测通过但能力加载失败时回到离线并拆除委托订阅", async () => {
    const { bridge } = createFixture();
    bridge.setReachable(true);
    const failingDelegate = createFakeDelegate();
    failingDelegate.loadCapabilities = async () => {
      throw new Error("服务刚刚退出");
    };
    const repositoryWithFailingDelegate = new DesktopOrchestrationRepository({
      bridge,
      createDelegate: () => failingDelegate,
      healthCheckIntervalMs: HEALTH_INTERVAL_MS,
    });
    const unsubscribe = repositoryWithFailingDelegate.subscribe(() => undefined);
    const snapshot = await repositoryWithFailingDelegate.loadCapabilities();
    expect(snapshot.sync.status).toBe("offline");
    expect(failingDelegate.listenerCount).toBe(0);
    unsubscribe();
  });

  it("最后一个订阅者退出后停止健康轮询", async () => {
    const { bridge, repository } = createFixture();
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadCapabilities();
    const checksBefore = bridge.checkCalls;
    unsubscribe();
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
    expect(bridge.checkCalls).toBe(checksBefore);
  });

  it("拒绝非法的健康探测间隔", () => {
    const { bridge } = createFixture();
    expect(() => new DesktopOrchestrationRepository({
      bridge,
      createDelegate: createFakeDelegate,
      healthCheckIntervalMs: 0,
    })).toThrow(/healthCheckIntervalMs/);
  });
});
