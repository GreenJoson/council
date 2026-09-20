/**
 * @input  依赖：HttpOrchestrationRepository 与可控 Fetch/SSE 替身
 * @output 导出：自动轮次、持久会话协议、安全请求体和 revision 分流回归测试
 * @pos    Web 自动轮次仓储的传输与实时校准验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it, vi } from "vitest";
import type { Fetcher } from "../src/data/http-client";
import { HttpOrchestrationRepository } from "../src/data/http-orchestration-repository";
import type { EventStream } from "../src/data/http-repository";
import type {
  OrchestrationRun,
  OrchestrationSnapshot,
  RuntimeBinding,
} from "../src/types/orchestration";

function success(data: unknown): Response {
  return Response.json({ code: 0, message: "success", data, timestamp: 1 });
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

class FakeEventStream implements EventStream {
  readonly listeners = new Map<string, EventListener[]>();
  closed = false;

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    const event = new Event(type);
    if (data !== undefined) {
      Object.defineProperty(event, "data", { value: JSON.stringify(data) });
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    id: "run-one",
    topicId: "topic-one",
    status: "waiting_user",
    plan: [
      {
        adapterId: "claude-code",
        actorId: "claude",
        messageKind: "proposal",
        instruction: "审查一致性边界",
      },
    ],
    policy: {
      maxRounds: 4,
      agentIdleTimeoutMs: 500,
      agentTimeoutMs: 1_000,
      maxAttemptsPerRound: 1,
      maxManualRecoveries: 1,
      confirmation: { beforeRounds: [], beforeCompletion: true },
    },
    nextRoundIndex: 1,
    currentAttempt: 1,
    manualRecoveriesUsed: 0,
    confirmedGates: [],
    pendingGateId: "gate-one",
    version: 2,
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

function createBinding(overrides: Partial<RuntimeBinding> = {}): RuntimeBinding {
  return {
    id: "binding-one",
    topicId: "topic-one",
    agentId: "claude-code",
    actorId: "claude",
    providerId: "provider-claude",
    transportKind: "claude-resume",
    status: "idle",
    hasSession: true,
    stateVersion: 2,
    lastActivityAt: "2026-01-01T09:00:00.000Z",
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

interface OrchestrationFixture {
  fetcher: Fetcher;
  requests: Array<{ url: URL; init?: RequestInit }>;
  emitContentChanged(stream: FakeEventStream, revision: number): void;
  emitOrchestrationChanged(stream: FakeEventStream, revision: number): void;
  emitAgentOutput(
    stream: FakeEventStream,
    event: Record<string, unknown>,
  ): void;
  rejectStatus: (value: boolean) => void;
  rejectActions: (value: boolean) => void;
}

function createOrchestrationFixture(): OrchestrationFixture {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const revisions = { total: 0, content: 0, orchestration: 0 };
  const runs = [createRun()];
  let shouldRejectStatus = false;
  let shouldRejectActions = false;

  const fetcher: Fetcher = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ url, ...(init ? { init } : {}) });
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/v1/status") {
      if (shouldRejectStatus) {
        return Response.json(
          { code: 503, message: "暂时不可用", timestamp: 1 },
          { status: 503 },
        );
      }
      return success({
        revision: revisions.total,
        revisions: {
          content: revisions.content,
          orchestration: revisions.orchestration,
        },
      });
    }
    if (url.pathname === "/api/v1/orchestration/capabilities") {
      return success({
        adapters: [
          {
            id: "claude-code",
            actorId: "claude",
            label: "Claude",
            available: true,
            runtimeCapabilities: [
              "text",
              "repository_read",
              "shell_read",
              "git_diff",
              "session_resume",
            ],
          },
        ],
        defaultPolicy: {
          maxRounds: 4,
          agentIdleTimeoutMs: 500,
          agentTimeoutMs: 1_000,
          maxAttemptsPerRound: 1,
          maxManualRecoveries: 1,
          confirmation: { beforeRounds: [], beforeCompletion: true },
        },
      });
    }
    if (/^\/api\/v1\/topics\/[^/]+\/runtime-bindings$/u.test(url.pathname)) {
      return success([]);
    }
    if (/^\/api\/v1\/topics\/[^/]+\/cycle$/u.test(url.pathname)) {
      return success(null);
    }
    if (/^\/api\/v1\/topics\/[^/]+\/cycle\/latest$/u.test(url.pathname)) {
      return success(null);
    }
    if (url.pathname === "/api/v1/orchestration/cycle-metrics") {
      return success({
        cycles: { total: 0, converged: 0, abandoned: 0, active: 0, awaitingUser: 0 },
        rounds: { count: 0, mean: 0, median: 0, max: 0 },
        wallClockMs: { count: 0, mean: 0, median: 0, max: 0 },
        questions: { total: 0, open: 0, perCycle: 0 },
        verdicts: { checked: 0, missing: 0, missingCycleIds: [] },
        decisionConsistency: { checked: 0, divergedCycleIds: [] },
      });
    }
    if (url.pathname === "/api/v1/topics/topic-one/runs" && method === "GET") {
      return success({
        total: runs.length,
        count: runs.length,
        offset: 0,
        hasMore: false,
        runs,
      });
    }
    if (url.pathname === "/api/v1/topics/topic-one/runs" && method === "POST") {
      return success(createRun({ id: "run-created", status: "idle" }));
    }
    if (url.pathname === "/api/v1/runs/run-one/approvals" && method === "POST") {
      return success({ run: runs[0], applied: false });
    }
    if (url.pathname.includes("/actions/") && method === "POST") {
      if (shouldRejectActions) {
        return Response.json(
          { code: 409, message: "状态已经变化", timestamp: 1 },
          { status: 409 },
        );
      }
      return success(runs[0]);
    }
    if (url.pathname === "/api/v1/runs/run-one" && method === "GET") {
      return success(runs[0]);
    }
    return Response.json(
      { code: 404, message: "不存在", timestamp: 1 },
      { status: 404 },
    );
  };

  return {
    fetcher,
    requests,
    emitContentChanged(stream: FakeEventStream, revision: number): void {
      revisions.total = revision;
      revisions.content = revision;
      stream.emit("council.changed", { revision });
    },
    emitOrchestrationChanged(stream: FakeEventStream, revision: number): void {
      revisions.total = revision;
      revisions.orchestration = revision;
      stream.emit("council.changed", { revision });
    },
    emitAgentOutput(stream: FakeEventStream, event: Record<string, unknown>): void {
      stream.emit("agent.output", event);
    },
    rejectStatus(value: boolean): void {
      shouldRejectStatus = value;
    },
    rejectActions(value: boolean): void {
      shouldRejectActions = value;
    },
  };
}

const OPTIONS = {
  baseUrl: "https://example.com",
  runPageSize: 50,
  eventRefreshMaxAttempts: 2,
  eventRefreshRetryDelayMs: 0,
  eventRecoveryDelayMs: 100,
} as const;

describe("HttpOrchestrationRepository", () => {
  it("直接合并当前议题的 agent.output，忽略乱序分片并在正式状态校准前保留完成草稿", async () => {
    const fixture = createOrchestrationFixture();
    const stream = new FakeEventStream();
    const snapshots: OrchestrationSnapshot[] = [];
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher: fixture.fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe((snapshot) => snapshots.push(snapshot));
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");

    const settledRevision = snapshots.at(-1)?.revision;
    const settledSnapshotCount = snapshots.length;
    const base = {
      runId: "run-one",
      topicId: "topic-one",
      adapterId: "claude-code",
    };
    fixture.emitAgentOutput(stream, {
      ...base,
      sequence: 1,
      operation: "reset",
    });
    fixture.emitAgentOutput(stream, {
      ...base,
      sequence: 2,
      operation: "append",
      content: "公开",
    });
    fixture.emitAgentOutput(stream, {
      ...base,
      sequence: 3,
      operation: "append",
      content: "草稿",
    });
    fixture.emitAgentOutput(stream, {
      ...base,
      sequence: 2,
      operation: "replace",
      content: "过期",
    });
    expect(snapshots.at(-1)?.agentOutputs?.[0]?.content).toBe("公开草稿");
    expect(snapshots.slice(settledSnapshotCount).every((snapshot) => snapshot.revision === settledRevision)).toBe(true);

    fixture.emitAgentOutput(stream, {
      ...base,
      sequence: 4,
      operation: "complete",
    });
    expect(snapshots.at(-1)?.agentOutputs?.[0]?.content).toBe("公开草稿");

    fixture.emitAgentOutput(stream, {
      ...base,
      adapterId: "codex",
      sequence: 1,
      operation: "reset",
    });
    fixture.emitAgentOutput(stream, {
      ...base,
      adapterId: "codex",
      sequence: 2,
      operation: "append",
      content: "下一轮",
    });
    expect(snapshots.at(-1)?.agentOutputs?.[0]).toMatchObject({
      adapterId: "codex",
      sequence: 2,
      content: "下一轮",
    });
    unsubscribe();
  });

  it("只在 orchestration revision 变化时重读当前议题运行列表", async () => {
    const fixture = createOrchestrationFixture();
    const stream = new FakeEventStream();
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher: fixture.fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadCapabilities();
    const selected = await repository.selectTopic("topic-one");
    expect(selected.runs[0]?.policy.maxManualRecoveries).toBe(1);
    const runRequestsBefore = fixture.requests.filter(
      (request) => request.url.pathname.endsWith("/runs") && request.init?.method !== "POST",
    ).length;

    fixture.emitContentChanged(stream, 1);
    await vi.waitFor(() => {
      expect(fixture.requests.filter((request) => request.url.pathname === "/api/v1/status"))
        .toHaveLength(3);
    });
    await settleAsyncWork();
    expect(
      fixture.requests.filter(
        (request) => request.url.pathname.endsWith("/runs") && request.init?.method !== "POST",
      ),
    ).toHaveLength(runRequestsBefore);

    fixture.emitOrchestrationChanged(stream, 2);
    await vi.waitFor(() => {
      expect(
        fixture.requests.filter(
          (request) => request.url.pathname.endsWith("/runs") && request.init?.method !== "POST",
        ),
      ).toHaveLength(runRequestsBefore + 1);
    });
    unsubscribe();
  });

  it("创建与审批请求不声明身份，并原样重放稳定 approvalId", async () => {
    const fixture = createOrchestrationFixture();
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");
    await repository.createRun({
      topicId: "topic-one",
      confirmationBeforeCompletion: true,
      plan: [
        {
          adapterId: "claude-code",
          messageKind: "proposal",
          instruction: "审查一致性边界",
        },
      ],
    });
    const approval = {
      runId: "run-one",
      expectedGateId: "gate-one",
      expectedVersion: 2,
      approvalId: "approval-stable",
    };
    await repository.approveRun(approval);
    await repository.approveRun(approval);

    const postBodies = fixture.requests
      .filter((request) => request.init?.method === "POST")
      .map((request) => JSON.parse(String(request.init?.body)) as Record<string, unknown>);
    expect(postBodies[0]).toEqual({
      confirmationBeforeCompletion: true,
      plan: [
        {
          adapterId: "claude-code",
          messageKind: "proposal",
          instruction: "审查一致性边界",
        },
      ],
    });
    expect(postBodies[1]).toEqual({
      expectedGateId: "gate-one",
      expectedVersion: 2,
      approvalId: "approval-stable",
    });
    expect(postBodies[2]).toEqual(postBodies[1]);
  });

  it("严格解析持久会话并把关闭与重开动作发送到独立端点", async () => {
    const fixture = createOrchestrationFixture();
    const initial = createBinding();
    const closed = createBinding({
      status: "closed",
      closeReason: "manual-close",
      closedAt: "2026-01-01T10:00:00.000Z",
      stateVersion: 3,
    });
    const reopened = createBinding({
      id: "binding-two",
      status: "starting",
      hasSession: false,
      stateVersion: 1,
      createdAt: "2026-01-01T11:00:00.000Z",
      updatedAt: "2026-01-01T11:00:00.000Z",
    });
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v1/topics/topic-one/runtime-bindings") {
        return success([initial]);
      }
      if (
        url.pathname === "/api/v1/runtime-bindings/binding-one/actions/close"
        && method === "POST"
      ) {
        return success(closed);
      }
      if (
        url.pathname === "/api/v1/runtime-bindings/binding-one/actions/reopen"
        && method === "POST"
      ) {
        return success(reopened);
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });

    const selected = await repository.selectTopic("topic-one");
    expect(selected.runtimeBindings).toEqual([initial]);
    await expect(repository.closeRuntimeBinding("binding-one")).resolves.toEqual(closed);
    await expect(repository.reopenRuntimeBinding("binding-one")).resolves.toEqual(reopened);
  });

  it("丢弃已切题时迟到的旧议题 SSE runs 响应", async () => {
    const fixture = createOrchestrationFixture();
    const stream = new FakeEventStream();
    let oldTopicRunReads = 0;
    let releaseOldTopic = () => undefined;
    let markOldTopicStarted = () => undefined;
    const oldTopicStarted = new Promise<void>((resolve) => {
      markOldTopicStarted = resolve;
    });
    const oldTopicGate = new Promise<void>((resolve) => {
      releaseOldTopic = resolve;
    });
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/topics/topic-one/runs") {
        oldTopicRunReads += 1;
        if (oldTopicRunReads === 2) {
          markOldTopicStarted();
          await oldTopicGate;
        }
        const run = createRun({ id: `run-a-${String(oldTopicRunReads)}` });
        return success({ total: 1, count: 1, offset: 0, hasMore: false, runs: [run] });
      }
      if (url.pathname === "/api/v1/topics/topic-two/runs") {
        const run = createRun({ id: "run-b", topicId: "topic-two" });
        return success({ total: 1, count: 1, offset: 0, hasMore: false, runs: [run] });
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");

    fixture.emitOrchestrationChanged(stream, 1);
    await oldTopicStarted;
    const selectedB = await repository.selectTopic("topic-two");
    expect(selectedB.runs.map((run) => run.id)).toEqual(["run-b"]);
    releaseOldTopic();
    await settleAsyncWork();

    const finalSnapshot = await repository.selectTopic("topic-two");
    expect(finalSnapshot.activeTopicId).toBe("topic-two");
    expect(finalSnapshot.runs.map((run) => run.id)).toEqual(["run-b"]);
    unsubscribe();
  });

  it("慢选题完成后继续消费期间到达的更新 revision", async () => {
    const fixture = createOrchestrationFixture();
    const stream = new FakeEventStream();
    const snapshots: OrchestrationSnapshot[] = [];
    let selectedTopicRunReads = 0;
    let releaseOldSelection = () => undefined;
    let markOldSelectionStarted = () => undefined;
    const oldSelectionStarted = new Promise<void>((resolve) => {
      markOldSelectionStarted = resolve;
    });
    const oldSelectionGate = new Promise<void>((resolve) => {
      releaseOldSelection = resolve;
    });
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/topics/topic-two/runs") {
        selectedTopicRunReads += 1;
        if (selectedTopicRunReads === 1) {
          markOldSelectionStarted();
          await oldSelectionGate;
        }
        const run = createRun({
          id: selectedTopicRunReads === 1 ? "run-b-old" : "run-b-current",
          topicId: "topic-two",
        });
        return success({ total: 1, count: 1, offset: 0, hasMore: false, runs: [run] });
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe((snapshot) => snapshots.push(snapshot));
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");

    const selectingTopicB = repository.selectTopic("topic-two");
    await oldSelectionStarted;
    fixture.emitOrchestrationChanged(stream, 1);
    releaseOldSelection();
    await selectingTopicB;

    await vi.waitFor(() => {
      expect(snapshots.at(-1)?.activeTopicId).toBe("topic-two");
      expect(snapshots.at(-1)?.runs.map((run) => run.id)).toEqual(["run-b-current"]);
    });
    expect(selectedTopicRunReads).toBe(2);
    unsubscribe();
  });

  it("旧议题慢动作返回后保留用户新选择的议题", async () => {
    const fixture = createOrchestrationFixture();
    let releaseAction = () => undefined;
    let markActionStarted = () => undefined;
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/runs/run-one/actions/start") {
        markActionStarted();
        await actionGate;
        return success(createRun());
      }
      if (url.pathname === "/api/v1/topics/topic-two/runs") {
        const run = createRun({ id: "run-b", topicId: "topic-two" });
        return success({ total: 1, count: 1, offset: 0, hasMore: false, runs: [run] });
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");

    const slowAction = repository.startRun("run-one");
    await actionStarted;
    await repository.selectTopic("topic-two");
    releaseAction();
    const actionSnapshot = await slowAction;

    expect(actionSnapshot.activeTopicId).toBe("topic-two");
    expect(actionSnapshot.runs.map((run) => run.id)).toEqual(["run-b"]);
  });

  it("动作失败时保留已知运行，并把同步状态标记为离线", async () => {
    const fixture = createOrchestrationFixture();
    const snapshots: OrchestrationRun[][] = [];
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    repository.subscribe((snapshot) => snapshots.push(snapshot.runs));
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");
    fixture.rejectActions(true);

    await expect(repository.startRun("run-one")).rejects.toThrow("状态已经变化");
    expect(snapshots.at(-1)?.map((run) => run.id)).toEqual(["run-one"]);
  });

  it("取消最后一个订阅者会关闭事件流并终止退避重试", async () => {
    const fixture = createOrchestrationFixture();
    const stream = new FakeEventStream();
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      eventRefreshRetryDelayMs: 80,
      fetcher: fixture.fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");
    fixture.rejectStatus(true);
    fixture.emitOrchestrationChanged(stream, 1);
    await vi.waitFor(() => {
      expect(fixture.requests.filter((request) => request.url.pathname === "/api/v1/status"))
        .toHaveLength(3);
    });
    unsubscribe();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    expect(
      fixture.requests.filter((request) => request.url.pathname === "/api/v1/status"),
    ).toHaveLength(3);
    expect(stream.closed).toBe(true);
  });

  it("退订后立即重订时由新事件世代消费排队 revision", async () => {
    const fixture = createOrchestrationFixture();
    const streams = [new FakeEventStream(), new FakeEventStream()];
    let streamIndex = 0;
    let statusReads = 0;
    let releaseOldStatus = () => undefined;
    let markOldStatusStarted = () => undefined;
    const oldStatusStarted = new Promise<void>((resolve) => {
      markOldStatusStarted = resolve;
    });
    const oldStatusGate = new Promise<void>((resolve) => {
      releaseOldStatus = resolve;
    });
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/status") {
        statusReads += 1;
        if (statusReads === 3) {
          markOldStatusStarted();
          await oldStatusGate;
        }
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpOrchestrationRepository({
      ...OPTIONS,
      fetcher,
      eventStreamFactory: () => streams[streamIndex++] ?? new FakeEventStream(),
    });
    const firstUnsubscribe = repository.subscribe(() => undefined);
    await repository.loadCapabilities();
    await repository.selectTopic("topic-one");

    fixture.emitOrchestrationChanged(streams[0]!, 1);
    await oldStatusStarted;
    firstUnsubscribe();
    const snapshots: OrchestrationSnapshot[] = [];
    const secondUnsubscribe = repository.subscribe((snapshot) => snapshots.push(snapshot));
    fixture.emitOrchestrationChanged(streams[1]!, 2);
    releaseOldStatus();

    await vi.waitFor(() => {
      expect(snapshots.at(-1)?.sync.label).toBe("自动轮次已实时校准");
    });
    expect(statusReads).toBeGreaterThanOrEqual(4);
    secondUnsubscribe();
  });
});
