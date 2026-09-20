/**
 * @input  依赖：HttpCouncilRepository、HTTP 客户端和可控 Fetch/SSE 替身
 * @output 导出：HTTP 错误、决策包按 ID 接受、人工 Accepted、内容/实施项写入、事件刷新与只读详情测试
 * @pos    Web 真实数据层的传输与实时同步回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it, vi } from "vitest";
import { CouncilApiError, requestApiData, type Fetcher } from "../src/data/http-client";
import {
  HttpCouncilRepository,
  type EventStream,
} from "../src/data/http-repository";

function success(data: unknown): Response {
  return Response.json({ code: 0, message: "success", data, timestamp: 1 });
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const HTTP_OPTIONS = {
  projectPath: "/path/to/project",
  topicPageSize: 100,
  messagePageSize: 100,
  eventRefreshMaxAttempts: 2,
  eventRefreshRetryDelayMs: 0,
  eventRecoveryDelayMs: 50,
} as const;

function actorSnapshot(actorId: string, displayName: string, shortName: string, role: string) {
  return {
    schemaVersion: 1,
    actorId,
    slug: actorId,
    displayName,
    shortName,
    role,
  };
}

function createTopic(id: string, title: string) {
  return {
    id,
    title,
    question: `${title}的问题`,
    constraints: [],
    status: "open",
    createdByActorId: "human",
    createdBySnapshot: actorSnapshot("human", "User", "U", "决策者"),
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
  };
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

interface ApiFixture {
  fetcher: Fetcher;
  requests: Array<{ url: URL; init?: RequestInit }>;
  emitContentChanged(stream: FakeEventStream, revision: number): void;
  emitOrchestrationChanged(stream: FakeEventStream, revision: number): void;
}

function createApiFixture(): ApiFixture {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const topics = [
    createTopic("topic-one", "缓存一致性"),
    createTopic("topic-three", "事件顺序"),
  ];
  const messages: unknown[] = [];
  const decisions: unknown[] = [
    {
      id: "decision-one",
      topicId: "topic-one",
      title: "版本号校验",
      decision: "使用版本号拒绝旧写入。",
      rationale: "边界明确。",
      alternatives: ["固定 TTL"],
      status: "proposed",
      createdByActorId: "claude",
      createdBySnapshot: actorSnapshot("claude", "Claude", "CL", "方案顾问"),
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
    },
  ];
  const revisions = { total: 0, content: 0, orchestration: 0 };

  const fetcher: Fetcher = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ url, ...(init ? { init } : {}) });
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/v1/status") {
      return success({
        status: "ok",
        revision: revisions.total,
        revisions: {
          content: revisions.content,
          orchestration: revisions.orchestration,
        },
      });
    }
    if (url.pathname === "/api/v1/topics" && method === "GET") {
      return success({
        total: topics.length,
        count: topics.length,
        offset: 0,
        hasMore: false,
        topics,
      });
    }
    if (url.pathname === "/api/v1/topics" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const topic = createTopic("topic-two", String(body.title));
      topics.unshift(topic);
      return success(topic);
    }
    if (url.pathname.endsWith("/messages") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const message = {
        id: `message-${String(messages.length + 1)}`,
        topicId: "topic-one",
        actorId: "human",
        actorSnapshot: actorSnapshot("human", "User", "U", "决策者"),
        kind: body.kind,
        content: body.content,
        createdAt: "2026-01-01T10:00:00.000Z",
      };
      messages.push(message);
      return success(message);
    }
    if (url.pathname.endsWith("/decisions/accept") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { decisionIds: string[] };
      const accepted = decisions
        .filter((candidate): candidate is Record<string, unknown> => (
          typeof candidate === "object"
          && candidate !== null
          && body.decisionIds.includes(String((candidate as { id?: unknown }).id))
        ))
        .map((candidate) => {
          candidate.status = "accepted";
          candidate.updatedAt = "2026-01-01T10:00:00.000Z";
          return candidate;
        });
      return success(accepted);
    }
    if (url.pathname.endsWith("/decisions") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const decision = {
        id: "decision-accepted",
        topicId: "topic-one",
        ...body,
        createdByActorId: "human",
        createdBySnapshot: actorSnapshot("human", "User", "U", "决策者"),
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      };
      decisions.push(decision);
      return success(decision);
    }
    if (url.pathname.endsWith("/actions/close") && method === "POST") {
      const topicId = url.pathname.split("/").at(-3);
      const topic = topics.find((candidate) => candidate.id === topicId);
      if (topic) {
        topic.status = "closed";
        return success(topic);
      }
    }
    const topicId = url.pathname.split("/").at(-1);
    const topic = topics.find((candidate) => candidate.id === topicId);
    if (topic) {
      return success({
        topic,
        messages: topic.id === "topic-one" ? messages : [],
        decisions: topic.id === "topic-one" ? decisions : [],
        workItems: [],
        messageTotal: topic.id === "topic-one" ? messages.length : 0,
        messageLimit: 100,
        messageOffset: 0,
        hasMoreMessages: false,
      });
    }
    return Response.json(
      { code: 404, message: "议题不存在", timestamp: 1 },
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
  };
}

describe("Council HTTP client", () => {
  it("保留 canonical HTTP 错误语义", async () => {
    const fetcher: Fetcher = async () => Response.json(
      { code: 422, message: "输入校验失败", timestamp: 1 },
      { status: 422 },
    );

    const error = await requestApiData(fetcher, new URL("https://example.com/api"), (data) => data)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CouncilApiError);
    expect(error).toMatchObject({ message: "输入校验失败", httpStatus: 422, code: 422 });
  });

  it("拒绝结构错误的成功响应", async () => {
    const fetcher: Fetcher = async () => success({ topics: "invalid" });
    await expect(
      requestApiData(fetcher, new URL("https://example.com/api"), () => {
        throw new Error("topics 必须是数组");
      }),
    ).rejects.toThrow("Council API 数据协议无效");
  });
});

describe("HttpCouncilRepository", () => {
  it("初始只加载首个详情，并在选题时惰性替换详情", async () => {
    const fixture = createApiFixture();
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });

    const initial = await repository.loadWorkspace();
    const initialDetailRequests = fixture.requests.filter(
      (request) => request.url.pathname.startsWith("/api/v1/topics/topic-"),
    );
    expect(initialDetailRequests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/topics/topic-one",
    ]);
    expect(initial.topics[0]?.messageTotal).toBe(0);
    expect(initial.topics[1]?.messageTotal).toBeUndefined();

    const selected = await repository.selectTopic("topic-three");
    expect(selected.topics[0]?.messageTotal).toBeUndefined();
    expect(selected.topics[1]?.messageTotal).toBe(0);
    expect(fixture.requests.at(-1)?.url.pathname).toBe("/api/v1/topics/topic-three");
  });

  it("只读加载议题详情，映射决策字段，且不改变当前选题或触发订阅", async () => {
    const fixture = createApiFixture();
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    const initial = await repository.loadWorkspace();
    expect(initial.activeTopicId).toBe("topic-one");

    const listener = vi.fn();
    const unsubscribe = repository.subscribe(listener);
    listener.mockClear();

    const detail = await repository.loadTopicDetail("topic-one");
    expect(detail.id).toBe("topic-one");
    expect(detail.decisions[0]).toMatchObject({
      title: "版本号校验",
      summary: "使用版本号拒绝旧写入。",
      status: "proposed",
    });
    expect(detail.alternatives[0]?.title).toBe("固定 TTL");
    expect(listener).not.toHaveBeenCalled();

    const afterRead = await repository.loadWorkspace();
    expect(afterRead.activeTopicId).toBe("topic-one");
    unsubscribe();
  });

  it("加载不存在议题的详情时向上传播 HTTP 错误", async () => {
    const fixture = createApiFixture();
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    await repository.loadWorkspace();

    const error = await repository.loadTopicDetail("topic-missing").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CouncilApiError);
    expect(error).toMatchObject({ message: "议题不存在", httpStatus: 404 });
  });

  it("通过真实 API 创建、发帖和接受当前拟议决策", async () => {
    const fixture = createApiFixture();
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    await repository.loadWorkspace();

    const afterPost = await repository.publishMessage({
      topicId: "topic-one",
      author: "human",
      kind: "critique",
      content: "补充失败路径。",
    });
    expect(afterPost.topics[0]?.messages.at(-1)?.author).toBe("human");

    const afterDecision = await repository.acceptDecisions("topic-one", ["decision-one"]);
    expect(afterDecision.topics[0]?.decisions[0]?.status).toBe("accepted");

    const afterCreate = await repository.createTopic({
      title: "新议题",
      question: "如何验证？",
      constraints: [],
    });
    expect(afterCreate.topics[0]?.title).toBe("新议题");

    const postBodies = fixture.requests
      .filter((request) => request.init?.method === "POST")
      .map((request) => JSON.parse(String(request.init?.body)) as Record<string, unknown>);
    expect(postBodies[0]).toEqual({ kind: "critique", content: "补充失败路径。" });
    expect(postBodies[1]).toEqual({ decisionIds: ["decision-one"] });
    expect(postBodies[2]).toEqual({
      title: "新议题",
      question: "如何验证？",
      constraints: [],
      projectPath: "/path/to/project",
    });
  });

  it("人工决策直接写 accepted，不经过消息或 Agent 入口", async () => {
    const fixture = createApiFixture();
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    await repository.loadWorkspace();

    const snapshot = await repository.recordManualDecision({
      topicId: "topic-one",
      title: "外部修复已上线",
      summary: "修复完成，线上验证通过。",
      rationale: "部署记录和回滚点已经核对。",
    });

    expect(snapshot.topics[0]?.decisions.at(-1)).toMatchObject({
      title: "外部修复已上线",
      summary: "修复完成，线上验证通过。",
      status: "accepted",
      proposedBy: "human",
    });
    const decisionRequest = fixture.requests.find(
      (request) => request.url.pathname.endsWith("/decisions")
        && request.init?.method === "POST",
    );
    expect(JSON.parse(String(decisionRequest?.init?.body))).toEqual({
      title: "外部修复已上线",
      decision: "修复完成，线上验证通过。",
      rationale: "部署记录和回滚点已经核对。",
      alternatives: [],
      status: "accepted",
    });
  });

  it("关闭议题后保留详情并映射为关闭态", async () => {
    const fixture = createApiFixture();
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    await repository.loadWorkspace();

    const snapshot = await repository.closeTopic("topic-one");

    expect(snapshot.topics.find((topic) => topic.id === "topic-one")?.status).toBe("closed");
    const request = fixture.requests.find(
      (candidate) => candidate.url.pathname.endsWith("/actions/close"),
    );
    expect(request?.init?.method).toBe("POST");
  });

  it("orchestration-only revision 不重读 Topic 内容", async () => {
    const fixture = createApiFixture();
    const stream = new FakeEventStream();
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadWorkspace();

    const contentRequestsBefore = fixture.requests.filter(
      (request) => request.url.pathname !== "/api/v1/status",
    ).length;
    fixture.emitOrchestrationChanged(stream, 1);
    await vi.waitFor(() => {
      expect(
        fixture.requests.filter((request) => request.url.pathname === "/api/v1/status"),
      ).toHaveLength(2);
    });
    await settleAsyncWork();
    expect(
      fixture.requests.filter((request) => request.url.pathname !== "/api/v1/status"),
    ).toHaveLength(contentRequestsBefore);
    unsubscribe();
  });

  it("SSE 断线显示真实状态，并按 revision 合并突发事件", async () => {
    const fixture = createApiFixture();
    const stream = new FakeEventStream();
    const snapshots: string[] = [];
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe((snapshot) => {
      snapshots.push(`${snapshot.sync.status}:${snapshot.sync.label}`);
    });
    await repository.loadWorkspace();

    stream.emit("error");
    expect(snapshots.at(-1)).toContain("offline:实时同步已断开");
    stream.emit("open");
    expect(snapshots.at(-1)).toContain("connected:API 与实时同步已连接");

    const requestsBeforeEvents = fixture.requests.length;
    fixture.emitContentChanged(stream, 1);
    fixture.emitContentChanged(stream, 2);
    fixture.emitContentChanged(stream, 3);
    await vi.waitFor(() => {
      expect(fixture.requests.length).toBeGreaterThan(requestsBeforeEvents);
    });
    await settleAsyncWork();
    const requestsAfterEvents = fixture.requests.length - requestsBeforeEvents;
    expect(requestsAfterEvents).toBeLessThanOrEqual(4);

    const requestsBeforeDuplicates = fixture.requests.length;
    fixture.emitContentChanged(stream, 3);
    await settleAsyncWork();
    expect(fixture.requests).toHaveLength(requestsBeforeDuplicates);

    fixture.emitContentChanged(stream, 1);
    await vi.waitFor(() => {
      expect(fixture.requests.length).toBeGreaterThan(requestsBeforeDuplicates);
    });
    await settleAsyncWork();
    const requestsAfterReset = fixture.requests.length;
    fixture.emitContentChanged(stream, 1);
    await settleAsyncWork();
    expect(fixture.requests).toHaveLength(requestsAfterReset);

    unsubscribe();
    expect(stream.closed).toBe(true);
  });

  it("changed 事件等待旧 load 后强制发起新一轮读取", async () => {
    const fixture = createApiFixture();
    const stream = new FakeEventStream();
    let holdNextDetail = false;
    let releaseDetail = () => undefined;
    let markDetailStarted = () => undefined;
    const detailStarted = new Promise<void>((resolve) => {
      markDetailStarted = resolve;
    });
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (holdNextDetail && url.pathname === "/api/v1/topics/topic-one") {
        holdNextDetail = false;
        markDetailStarted();
        await detailGate;
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadWorkspace();

    holdNextDetail = true;
    const oldLoad = repository.loadWorkspace();
    await detailStarted;
    fixture.emitContentChanged(stream, 1);
    releaseDetail();
    await oldLoad;

    await vi.waitFor(() => {
      const listRequests = fixture.requests.filter(
        (request) => request.url.pathname === "/api/v1/topics" && request.init?.method !== "POST",
      );
      expect(listRequests).toHaveLength(3);
    });
    unsubscribe();
  });

  it("写入成功后丢弃写入前旧 load，并按返回 ID 选择新议题", async () => {
    const fixture = createApiFixture();
    let holdNextDetail = false;
    let releaseDetail = () => undefined;
    let markDetailStarted = () => undefined;
    const detailStarted = new Promise<void>((resolve) => {
      markDetailStarted = resolve;
    });
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (holdNextDetail && url.pathname === "/api/v1/topics/topic-one") {
        holdNextDetail = false;
        markDetailStarted();
        await detailGate;
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher,
      eventStreamFactory: () => new FakeEventStream(),
    });
    await repository.loadWorkspace();

    holdNextDetail = true;
    const oldLoad = repository.loadWorkspace();
    await detailStarted;
    const createPromise = repository.createTopic({
      title: "并发后的新议题",
      question: "是否选择正确？",
      constraints: [],
    });
    releaseDetail();
    await oldLoad;
    const created = await createPromise;

    expect(created.activeTopicId).toBe("topic-two");
    expect(created.topics.find((topic) => topic.id === "topic-two")?.title).toBe("并发后的新议题");
    expect(fixture.requests.at(-1)?.url.pathname).toBe("/api/v1/topics/topic-two");
  });

  it("revision 刷新首次失败后有界重试并最终应用同一 revision", async () => {
    const fixture = createApiFixture();
    const stream = new FakeEventStream();
    let failNextList = false;
    let refreshListAttempts = 0;
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (failNextList && url.pathname === "/api/v1/topics" && init?.method !== "POST") {
        failNextList = false;
        refreshListAttempts += 1;
        return Response.json(
          { code: 503, message: "暂时不可用", timestamp: 1 },
          { status: 503 },
        );
      }
      if (url.pathname === "/api/v1/topics" && init?.method !== "POST") {
        refreshListAttempts += 1;
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadWorkspace();

    refreshListAttempts = 0;
    failNextList = true;
    fixture.emitContentChanged(stream, 1);
    await vi.waitFor(() => {
      expect(refreshListAttempts).toBe(2);
    });
    await settleAsyncWork();

    const requestsAfterRecovery = fixture.requests.length;
    fixture.emitContentChanged(stream, 1);
    await settleAsyncWork();
    expect(fixture.requests).toHaveLength(requestsAfterRecovery);
    unsubscribe();
  });

  it("revision 重试耗尽后由显式 load 恢复并消化 pending revision", async () => {
    const fixture = createApiFixture();
    const stream = new FakeEventStream();
    let rejectList = false;
    const syncStatuses: string[] = [];
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (rejectList && url.pathname === "/api/v1/topics" && init?.method !== "POST") {
        return Response.json(
          { code: 503, message: "暂时不可用", timestamp: 1 },
          { status: 503 },
        );
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      eventRefreshMaxAttempts: 1,
      baseUrl: "https://example.com",
      fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe((snapshot) => {
      syncStatuses.push(snapshot.sync.status);
    });
    await repository.loadWorkspace();

    rejectList = true;
    fixture.emitContentChanged(stream, 1);
    await vi.waitFor(() => {
      expect(syncStatuses.at(-1)).toBe("offline");
    });
    await settleAsyncWork();

    rejectList = false;
    await repository.loadWorkspace();
    const requestsAfterRecovery = fixture.requests.length;
    fixture.emitContentChanged(stream, 1);
    await settleAsyncWork();
    expect(fixture.requests).toHaveLength(requestsAfterRecovery);
    unsubscribe();
  });

  it("快速重试全部失败后由低频定时器自动应用同一 revision", async () => {
    const fixture = createApiFixture();
    const stream = new FakeEventStream();
    let rejectList = false;
    let refreshListAttempts = 0;
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/topics" && init?.method !== "POST") {
        refreshListAttempts += 1;
        if (rejectList) {
          return Response.json(
            { code: 503, message: "暂时不可用", timestamp: 1 },
            { status: 503 },
          );
        }
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      eventRecoveryDelayMs: 100,
      baseUrl: "https://example.com",
      fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadWorkspace();

    refreshListAttempts = 0;
    rejectList = true;
    fixture.emitContentChanged(stream, 1);
    await vi.waitFor(() => {
      expect(refreshListAttempts).toBe(2);
    });
    rejectList = false;
    await vi.waitFor(() => {
      expect(refreshListAttempts).toBe(3);
    });
    await settleAsyncWork();

    const requestsAfterRecovery = fixture.requests.length;
    fixture.emitContentChanged(stream, 1);
    await settleAsyncWork();
    expect(fixture.requests).toHaveLength(requestsAfterRecovery);
    unsubscribe();
  });

  it("快速退避期间取消最后一个 listener 会清理 timer 且不发下一次请求", async () => {
    const fixture = createApiFixture();
    const stream = new FakeEventStream();
    let rejectList = false;
    let refreshListAttempts = 0;
    const fetcher: Fetcher = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/topics" && init?.method !== "POST") {
        refreshListAttempts += 1;
        if (rejectList) {
          return Response.json(
            { code: 503, message: "暂时不可用", timestamp: 1 },
            { status: 503 },
          );
        }
      }
      return fixture.fetcher(input, init);
    };
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      eventRefreshRetryDelayMs: 80,
      eventRecoveryDelayMs: 100,
      baseUrl: "https://example.com",
      fetcher,
      eventStreamFactory: () => stream,
    });
    const unsubscribe = repository.subscribe(() => undefined);
    await repository.loadWorkspace();

    refreshListAttempts = 0;
    rejectList = true;
    fixture.emitContentChanged(stream, 1);
    await vi.waitFor(() => {
      expect(refreshListAttempts).toBe(1);
    });
    unsubscribe();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    expect(refreshListAttempts).toBe(1);
    expect(stream.closed).toBe(true);
  });

  it("重新订阅后忽略旧 EventSource 残留事件", async () => {
    const fixture = createApiFixture();
    const streams = [new FakeEventStream(), new FakeEventStream()];
    let streamIndex = 0;
    const repository = new HttpCouncilRepository({
      ...HTTP_OPTIONS,
      baseUrl: "https://example.com",
      fetcher: fixture.fetcher,
      eventStreamFactory: () => streams[streamIndex++] ?? new FakeEventStream(),
    });
    const unsubscribeFirst = repository.subscribe(() => undefined);
    await repository.loadWorkspace();
    unsubscribeFirst();
    const unsubscribeSecond = repository.subscribe(() => undefined);

    const requestsBeforeOldEvent = fixture.requests.length;
    streams[0]?.emit("council.changed", { revision: 1 });
    await settleAsyncWork();
    expect(fixture.requests).toHaveLength(requestsBeforeOldEvent);

    const currentStream = streams[1];
    expect(currentStream).toBeDefined();
    if (currentStream) {
      fixture.emitContentChanged(currentStream, 1);
    }
    await vi.waitFor(() => {
      expect(fixture.requests.length).toBeGreaterThan(requestsBeforeOldEvent);
    });
    unsubscribeSecond();
  });
});
