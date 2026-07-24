/**
 * @input  依赖：真实 Express App、SQLite Store、Fake Agent 与后台执行管理器
 * @output 导出：编排 REST 契约、断线、取消、批准、恢复、重启和 sweeper 集成测试
 * @pos    Web 已冻结协议和跨进程自动执行语义的主验收套件
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  AgentInvocationError,
  SQLiteCouncilStore,
  type AgentAdapter,
  type AgentInvocation,
  type AgentInvocationOptions,
  type AgentResult,
  type CreateRunInput,
  type OrchestrationRun,
} from "council-orchestrator";
import { CouncilOrchestrationService } from "../src/orchestration/service.js";
import { readEnvelope, startHttpHarness } from "./http-harness.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

class FakeAgent implements AgentAdapter {
  readonly invocations: AgentInvocation[] = [];

  constructor(
    readonly adapterId: string,
    private readonly handler: (
      input: AgentInvocation,
      options: AgentInvocationOptions,
      callNumber: number,
    ) => Promise<AgentResult>,
  ) {}

  async invoke(input: AgentInvocation, options: AgentInvocationOptions): Promise<AgentResult> {
    this.invocations.push(structuredClone(input));
    return await this.handler(input, options, this.invocations.length);
  }
}

async function waitForRun(
  service: CouncilOrchestrationService,
  runId: string,
  predicate: (run: OrchestrationRun) => boolean,
  timeoutMs = 2_000,
): Promise<OrchestrationRun> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const run = await service.getRun(runId);
    if (predicate(run)) {
      return run;
    }
    if (Date.now() >= deadline) {
      throw new Error(`运行 ${runId} 未在期限内到达目标状态，当前为 ${run.status}。`);
    }
    await delay(10);
  }
}

async function createRunThroughHttp(
  baseUrl: string,
  topicId: string,
  adapterId = "fake",
  confirmationBeforeCompletion?: boolean,
): Promise<OrchestrationRun> {
  const response = await fetch(`${baseUrl}/api/v1/topics/${topicId}/runs`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      confirmationBeforeCompletion,
      plan: [{ adapterId, messageKind: "proposal", instruction: "给出可验证方案" }],
    }),
  });
  assert.equal(response.status, 201);
  const envelope = await readEnvelope<OrchestrationRun>(response);
  assert(envelope.data);
  return envelope.data;
}

async function postAndDisconnect(url: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
    });
    outgoing.once("error", reject);
    outgoing.once("response", (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve(status);
    });
    outgoing.end("{}");
  });
}

function createStoreInput(topicId: string, beforeRounds: readonly number[] = []): CreateRunInput {
  return {
    topicId,
    plan: [{
      adapterId: "fake",
      publicAuthor: "claude",
      messageKind: "proposal",
      instruction: "恢复后执行",
    }],
    policy: {
      maxRounds: 1,
      allowedAgents: ["fake"],
      agentTimeoutMs: 2_000,
      agentCleanupTimeoutMs: 100,
      maxAttemptsPerRound: 1,
      maxManualRecoveries: 1,
      confirmation: { beforeRounds, beforeCompletion: false },
    },
  };
}

test("真实 App 遵守 capabilities/create/list/get/start 冻结契约且断线不取消后台任务", async () => {
  const started = deferred<void>();
  const reply = deferred<AgentResult>();
  const agent = new FakeAgent("fake", async () => {
    started.resolve();
    return await reply.promise;
  });
  const harness = await startHttpHarness({}, [{
    adapter: agent,
    publicAuthor: "claude",
    label: "Fake Claude",
    limitation: "仅用于确定性测试。",
  }]);
  try {
    assert(harness.orchestration);
    const capabilitiesResponse = await fetch(
      `${harness.baseUrl}/api/v1/orchestration/capabilities`,
    );
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await readEnvelope<Record<string, unknown>>(capabilitiesResponse);
    assert.deepEqual(capabilities.data, {
      adapters: [{
        id: "fake",
        label: "Fake Claude",
        available: true,
        publicAuthor: "claude",
        limitation: "仅用于确定性测试。",
      }],
      defaultPolicy: {
        maxRounds: 10,
        agentTimeoutMs: 5_000,
        maxAttemptsPerRound: 1,
        maxManualRecoveries: 1,
        confirmation: { beforeRounds: [], beforeCompletion: false },
      },
      limitations: [
        "V1 不恢复 Agent session。",
        "只有已注册的后台适配器可以自动执行。",
      ],
    });

    const topic = harness.database.createTopic({
      title: "真实路由契约",
      question: "浏览器能否安全启动后台编排？",
      constraints: [],
      createdBy: "human",
    });
    for (const forbidden of [
      { plan: [{ adapterId: "fake", publicAuthor: "claude", messageKind: "proposal", instruction: "x" }] },
      { plan: [{ adapterId: "fake", messageKind: "proposal", instruction: "x" }], allowedAgents: ["fake"] },
    ]) {
      const rejected = await fetch(`${harness.baseUrl}/api/v1/topics/${topic.id}/runs`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(forbidden),
      });
      assert.equal(rejected.status, 400);
    }

    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    assert.equal(run.plan[0]?.publicAuthor, "claude");
    const listResponse = await fetch(`${harness.baseUrl}/api/v1/topics/${topic.id}/runs`);
    const list = await readEnvelope<Record<string, unknown>>(listResponse);
    assert.deepEqual(Object.keys(list.data ?? {}).sort(), [
      "count", "hasMore", "offset", "runs", "total",
    ]);
    const getResponse = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}`);
    assert.equal(getResponse.status, 200);
    assert.equal((await readEnvelope<OrchestrationRun>(getResponse)).data?.id, run.id);
    assert.equal(
      (await fetch(`${harness.baseUrl}/api/v1/orchestration/runs/${run.id}`)).status,
      404,
    );

    const startStatus = await postAndDisconnect(
      `${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`,
    );
    assert.equal(startStatus, 202);
    await started.promise;
    assert.equal((await harness.orchestration.getRun(run.id)).status, "waiting_agent");
    reply.resolve({ content: "断开 HTTP 连接后仍完成的公开回复。" });
    const completed = await waitForRun(
      harness.orchestration,
      run.id,
      (candidate) => candidate.status === "completed",
    );
    assert.equal(completed.stopReason, "plan_completed");
    assert.equal(harness.database.getTopicDetail(topic.id, 20).messageTotal, 1);

    const illegalStart = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
    assert.equal(illegalStart.status, 409);
    const missing = await fetch(`${harness.baseUrl}/api/v1/runs/run_missing`);
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test("不可用 Agent 在 capabilities 标记 false 且 create 严格拒绝", async () => {
  const agent = new FakeAgent("offline", async () => ({ content: "不应调用" }));
  const harness = await startHttpHarness({}, [{
    adapter: agent,
    publicAuthor: "claude",
    label: "Offline Agent",
    checkAvailability: async () => false,
  }]);
  try {
    const response = await fetch(`${harness.baseUrl}/api/v1/orchestration/capabilities`);
    const envelope = await readEnvelope<{
      adapters: Array<{ available: boolean; limitation?: string }>;
    }>(response);
    assert.equal(envelope.data?.adapters[0]?.available, false);
    assert.equal(envelope.data?.adapters[0]?.limitation, "本地 Agent 自动调用当前不可用。");
    const topic = harness.database.createTopic({
      title: "不可用适配器",
      question: "是否应该创建必然失败的运行？",
      constraints: [],
      createdBy: "human",
    });
    const rejected = await fetch(`${harness.baseUrl}/api/v1/topics/${topic.id}/runs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        plan: [{ adapterId: "offline", messageKind: "proposal", instruction: "不要执行" }],
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await harness.orchestration?.listRuns(topic.id, 20, 0))?.total, 0);
  } finally {
    await harness.close();
  }
});

test("不可用 Agent 优先展示注册时提供的可执行 limitation 提示", async () => {
  const agent = new FakeAgent("codex", async () => ({ content: "不应调用" }));
  const harness = await startHttpHarness({}, [{
    adapter: agent,
    publicAuthor: "codex",
    label: "Codex CLI",
    limitationWhenUnavailable: "请安装 codex 并运行 codex login 后重试。",
    checkAvailability: async () => false,
  }]);
  try {
    const response = await fetch(`${harness.baseUrl}/api/v1/orchestration/capabilities`);
    const envelope = await readEnvelope<{
      adapters: Array<{ available: boolean; limitation?: string }>;
    }>(response);
    assert.equal(envelope.data?.adapters[0]?.available, false);
    assert.equal(
      envelope.data?.adapters[0]?.limitation,
      "请安装 codex 并运行 codex login 后重试。",
    );
  } finally {
    await harness.close();
  }
});

test("CLI 登录后无需重启服务：createRun 强制复检并让缓存立即更新", async () => {
  let cliLoggedIn = false;
  let checkCount = 0;
  const agent = new FakeAgent("claude", async () => ({ content: "登录后的公开回复。" }));
  const harness = await startHttpHarness({}, [{
    adapter: agent,
    publicAuthor: "claude",
    label: "Claude Code",
    checkAvailability: async () => {
      checkCount += 1;
      return cliLoggedIn;
    },
  }]);
  try {
    // 启动时检测一次：不可用
    assert.equal(checkCount, 1);
    const stale = await readEnvelope<{
      adapters: Array<{ available: boolean }>;
    }>(await fetch(`${harness.baseUrl}/api/v1/orchestration/capabilities`));
    assert.equal(stale.data?.adapters[0]?.available, false);
    // TTL 内 capabilities 走缓存，不重复拉起 CLI 检测
    assert.equal(checkCount, 1);

    // 模拟用户完成 CLI 登录
    cliLoggedIn = true;

    // 点名不可用适配器创建 run：强制复检后放行，而不是被旧缓存拦截
    const topic = harness.database.createTopic({
      title: "登录后直召",
      question: "登录后是否需要重启服务？",
      constraints: [],
      createdBy: "human",
    });
    const created = await fetch(`${harness.baseUrl}/api/v1/topics/${topic.id}/runs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        plan: [{ adapterId: "claude", messageKind: "note", instruction: "确认已接入" }],
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(checkCount, 2);

    // 强制复检的结果写回缓存：capabilities 立即反映可用，且无额外检测
    const fresh = await readEnvelope<{
      adapters: Array<{ available: boolean; limitation?: string }>;
    }>(await fetch(`${harness.baseUrl}/api/v1/orchestration/capabilities`));
    assert.equal(fresh.data?.adapters[0]?.available, true);
    assert.equal(fresh.data?.adapters[0]?.limitation, undefined);
    assert.equal(checkCount, 2);
  } finally {
    await harness.close();
  }
});

test("产品服务将配置的消息上限传入 Agent 上下文 Store", async () => {
  const agent = new FakeAgent("fake", async () => ({ content: "只使用有界上下文。" }));
  const harness = await startHttpHarness(
    { defaultMessageLimit: 2 },
    [{ adapter: agent, publicAuthor: "claude" }],
  );
  try {
    assert(harness.orchestration);
    const topic = harness.database.createTopic({
      title: "Agent 上下文上限",
      question: "产品服务是否转发存储限制？",
      constraints: [],
      createdBy: "human",
    });
    for (let index = 1; index <= 5; index += 1) {
      harness.database.createMessage({
        topicId: topic.id,
        author: "human",
        kind: "note",
        content: `历史消息 ${String(index)}`,
      });
    }
    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    const started = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
    assert.equal(started.status, 202);
    await waitForRun(
      harness.orchestration,
      run.id,
      (candidate) => candidate.status === "completed",
    );
    assert.deepEqual(
      agent.invocations[0]?.context.messages.map((message) => message.content),
      ["历史消息 4", "历史消息 5"],
    );
  } finally {
    await harness.close();
  }
});

test("cancel 立即中止活动调用且迟到结果不能写入", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const late = deferred<AgentResult>();
  const agent = new FakeAgent("fake", async (_input, { signal }) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    return await late.promise;
  });
  const harness = await startHttpHarness({}, [{ adapter: agent, publicAuthor: "claude" }]);
  try {
    assert(harness.orchestration);
    const topic = harness.database.createTopic({
      title: "取消迟到回复",
      question: "取消后是否还能落消息？",
      constraints: [],
      createdBy: "human",
    });
    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    const start = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    assert.equal(start.status, 202);
    await started.promise;
    const cancel = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/cancel`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    assert.equal(cancel.status, 200);
    assert.equal((await readEnvelope<OrchestrationRun>(cancel)).data?.status, "cancelled");
    await aborted.promise;
    late.resolve({ content: "这个迟到结果不得写入。" });
    await harness.orchestration.manager.waitForIdle();
    assert.equal((await harness.orchestration.getRun(run.id)).status, "cancelled");
    assert.equal(harness.database.getTopicDetail(topic.id, 20).messageTotal, 0);
  } finally {
    await harness.close();
  }
});

test("另一服务实例取消会失效 lease，并在一个心跳内中止当前持有者", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const holderAgent = new FakeAgent("fake", async (_input, { signal }) => {
    return await new Promise<AgentResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted.resolve();
        reject(signal.reason);
      }, { once: true });
      started.resolve();
    });
  });
  const harness = await startHttpHarness({
    orchestrationLeaseTtlMs: 120,
    orchestrationLeaseRenewMs: 20,
    orchestrationSweepIntervalMs: 1_000,
  }, [{ adapter: holderAgent, publicAuthor: "claude" }]);
  let canceller: CouncilOrchestrationService | undefined;
  try {
    assert(harness.orchestration);
    const topic = harness.database.createTopic({
      title: "跨实例取消",
      question: "远端控制面能否中止当前 CLI？",
      constraints: [],
      createdBy: "human",
    });
    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    await started.promise;
    canceller = new CouncilOrchestrationService(harness.config, [{
      adapter: new FakeAgent("fake", async () => ({ content: "不应由取消者调用" })),
      publicAuthor: "claude",
    }]);
    const cancelled = await canceller.cancel(run.id);
    assert.equal(cancelled.status, "cancelled");
    await Promise.race([
      aborted.promise,
      delay(500).then(() => {
        throw new Error("持有者没有在 lease 心跳内收到中止信号。");
      }),
    ]);
    await harness.orchestration.manager.waitForIdle();
    assert.equal((await harness.orchestration.getRun(run.id)).status, "cancelled");
    assert.equal(harness.database.getTopicDetail(topic.id, 20).messageTotal, 0);
  } finally {
    await canceller?.shutdown();
    canceller?.close();
    await harness.close();
  }
});

test("approval 首次 202、重放 200/applied=false，且重放可补调度 running", async () => {
  const agent = new FakeAgent("fake", async () => ({ content: "等待完成确认的回复。" }));
  const harness = await startHttpHarness(
    { orchestrationConfirmCompletion: false, orchestrationSweepIntervalMs: 1_000 },
    [{ adapter: agent, publicAuthor: "claude" }],
  );
  try {
    assert(harness.orchestration);
    const topic = harness.database.createTopic({
      title: "批准幂等",
      question: "批准重放是否跨门？",
      constraints: [],
      createdBy: "human",
    });
    const run = await createRunThroughHttp(harness.baseUrl, topic.id, "fake", true);
    await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    const waiting = await waitForRun(
      harness.orchestration,
      run.id,
      (candidate) => candidate.status === "waiting_user",
    );
    const approval = {
      expectedGateId: waiting.pendingGateId,
      expectedVersion: waiting.version,
      approvalId: "approval_http_replay",
    };
    const forged = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/approvals`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...approval, approvedBy: "claude" }),
    });
    assert.equal(forged.status, 400);

    const first = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/approvals`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify(approval),
    });
    assert.equal(first.status, 202);
    const firstResult = await readEnvelope<{ run: OrchestrationRun; applied: boolean }>(first);
    assert.equal(firstResult.data?.applied, true);
    const replay = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/approvals`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify(approval),
    });
    assert.equal(replay.status, 200);
    assert.equal(
      (await readEnvelope<{ run: OrchestrationRun; applied: boolean }>(replay)).data?.applied,
      false,
    );
    await waitForRun(harness.orchestration, run.id, (candidate) => candidate.status === "completed");

    const replayTopic = harness.database.createTopic({
      title: "重放补调度",
      question: "外部批准提交后重放能否补回后台调度？",
      constraints: [],
      createdBy: "human",
    });
    const replayRun = await createRunThroughHttp(
      harness.baseUrl,
      replayTopic.id,
      "fake",
      true,
    );
    await fetch(`${harness.baseUrl}/api/v1/runs/${replayRun.id}/actions/start`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    const replayWaiting = await waitForRun(
      harness.orchestration,
      replayRun.id,
      (candidate) => candidate.status === "waiting_user",
    );
    const externallyApplied = {
      runId: replayRun.id,
      expectedGateId: replayWaiting.pendingGateId ?? "",
      expectedVersion: replayWaiting.version,
      approvalId: "approval_external_then_replay",
      approvedBy: "human" as const,
    };
    const externalStore = new SQLiteCouncilStore(harness.databasePath, 5_000);
    try {
      assert.equal((await externalStore.approveGate(externallyApplied)).applied, true);
    } finally {
      externalStore.close();
    }
    const replayResponse = await fetch(
      `${harness.baseUrl}/api/v1/runs/${replayRun.id}/approvals`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          expectedGateId: externallyApplied.expectedGateId,
          expectedVersion: externallyApplied.expectedVersion,
          approvalId: externallyApplied.approvalId,
        }),
      },
    );
    assert.equal(replayResponse.status, 200);
    assert.equal(
      (await readEnvelope<{ run: OrchestrationRun; applied: boolean }>(replayResponse)).data?.applied,
      false,
    );
    await waitForRun(
      harness.orchestration,
      replayRun.id,
      (candidate) => candidate.status === "completed",
    );
  } finally {
    await harness.close();
  }
});

test("recover 路由只恢复 failed 并异步完成，非法恢复返回 409", async () => {
  const agent = new FakeAgent("fake", async (_input, _options, callNumber) => {
    if (callNumber === 1) {
      throw new AgentInvocationError("测试失败。", false);
    }
    return { content: "恢复后的公开回复。" };
  });
  const harness = await startHttpHarness({}, [{ adapter: agent, publicAuthor: "claude" }]);
  try {
    assert(harness.orchestration);
    const topic = harness.database.createTopic({
      title: "显式恢复",
      question: "失败后能否受预算恢复？",
      constraints: [],
      createdBy: "human",
    });
    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    await waitForRun(harness.orchestration, run.id, (candidate) => candidate.status === "failed");
    const recover = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/recover`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    assert.equal(recover.status, 202);
    assert.equal((await readEnvelope<OrchestrationRun>(recover)).data?.status, "running");
    await waitForRun(harness.orchestration, run.id, (candidate) => candidate.status === "completed");
    const illegal = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/recover`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    assert.equal(illegal.status, 409);
  } finally {
    await harness.close();
  }
});

test("损坏运行快照只返回通用 500，不泄露 codec 或 SQLite 细节", async () => {
  const agent = new FakeAgent("fake", async () => ({ content: "不应执行" }));
  const harness = await startHttpHarness({}, [{ adapter: agent, publicAuthor: "claude" }]);
  try {
    const topic = harness.database.createTopic({
      title: "损坏快照",
      question: "HTTP 是否泄露内部结构？",
      constraints: [],
      createdBy: "human",
    });
    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    const raw = new DatabaseSync(harness.databasePath);
    try {
      raw.prepare("UPDATE orchestration_runs SET snapshot_json = ? WHERE id = ?")
        .run("{broken", run.id);
    } finally {
      raw.close();
    }

    const response = await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}`);
    assert.equal(response.status, 500);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.message, "服务器内部错误。");
    assert.doesNotMatch(JSON.stringify(envelope), /snapshot|json|sqlite|codec|broken/i);
  } finally {
    await harness.close();
  }
});

test("启动恢复按 active status 完整分页：忽略大量终态、恢复 running、中断 waiting_agent、保留 waiting_user", async () => {
  const harness = await startHttpHarness({ orchestrationRunPageLimit: 1 });
  let service: CouncilOrchestrationService | undefined;
  try {
    const oldTopic = harness.database.createTopic({
      title: "旧议题",
      question: "大量终态后活动运行会被漏掉吗？",
      constraints: [],
      createdBy: "human",
    });
    const interruptedTopic = harness.database.createTopic({
      title: "中断议题", question: "未知 Agent 结果如何处理？", constraints: [], createdBy: "human",
    });
    const waitingTopic = harness.database.createTopic({
      title: "用户确认", question: "等待用户时是否自动推进？", constraints: [], createdBy: "human",
    });
    const store = new SQLiteCouncilStore(harness.databasePath, 5_000);
    let running: OrchestrationRun;
    let interrupted: OrchestrationRun;
    let waitingUser: OrchestrationRun;
    try {
      for (let index = 0; index < 25; index += 1) {
        const terminal = await store.createRun(createStoreInput(oldTopic.id));
        await store.cancelRun(terminal.id);
      }
      const idle = await store.createRun(createStoreInput(oldTopic.id));
      running = await store.replaceRun({ ...idle, status: "running" }, idle.version);
      const idleInterrupted = await store.createRun(createStoreInput(interruptedTopic.id));
      const activeInterrupted = await store.replaceRun(
        { ...idleInterrupted, status: "running" },
        idleInterrupted.version,
      );
      interrupted = await store.replaceRun({
        ...activeInterrupted,
        status: "waiting_agent",
        activeAgentId: "fake",
        currentAttempt: 1,
      }, activeInterrupted.version);
      const idleWaiting = await store.createRun(createStoreInput(waitingTopic.id, [1]));
      waitingUser = await store.replaceRun({
        ...idleWaiting,
        status: "waiting_user",
        pendingGateId: "before_round:1",
      }, idleWaiting.version);
    } finally {
      store.close();
    }
    const agent = new FakeAgent("fake", async () => ({ content: "启动恢复回复。" }));
    service = new CouncilOrchestrationService(harness.config, [
      { adapter: agent, publicAuthor: "claude" },
    ]);
    await service.initialize();
    await service.manager.waitForIdle();
    assert.equal((await service.getRun(running.id)).status, "completed");
    const failed = await service.getRun(interrupted.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.code, "execution_interrupted");
    assert.equal((await service.getRun(waitingUser.id)).status, "waiting_user");
    assert.deepEqual(agent.invocations.map((item) => item.runId), [running.id]);
  } finally {
    await service?.shutdown();
    service?.close();
    await harness.close();
  }
});

test("旧有效 lease 到期后 sweeper 无需二次重启即可接管 running 与 waiting_agent", async () => {
  const harness = await startHttpHarness({
    orchestrationLeaseTtlMs: 100,
    orchestrationLeaseRenewMs: 30,
    orchestrationSweepIntervalMs: 20,
  });
  let service: CouncilOrchestrationService | undefined;
  try {
    const runningTopic = harness.database.createTopic({
      title: "旧 running lease", question: "TTL 后是否接管？", constraints: [], createdBy: "human",
    });
    const waitingTopic = harness.database.createTopic({
      title: "旧 waiting lease", question: "TTL 后是否中断？", constraints: [], createdBy: "human",
    });
    const store = new SQLiteCouncilStore(harness.databasePath, 5_000);
    let running: OrchestrationRun;
    let waiting: OrchestrationRun;
    try {
      const first = await store.createRun(createStoreInput(runningTopic.id));
      running = await store.replaceRun({ ...first, status: "running" }, first.version);
      await store.claimRunLease({ runId: running.id, ownerId: "old-owner-a", ttlMs: 100 });
      const second = await store.createRun(createStoreInput(waitingTopic.id));
      const secondRunning = await store.replaceRun({ ...second, status: "running" }, second.version);
      waiting = await store.replaceRun({
        ...secondRunning,
        status: "waiting_agent",
        activeAgentId: "fake",
        currentAttempt: 1,
      }, secondRunning.version);
      await store.claimRunLease({ runId: waiting.id, ownerId: "old-owner-b", ttlMs: 100 });
    } finally {
      store.close();
    }
    const agent = new FakeAgent("fake", async () => ({ content: "TTL 接管后的回复。" }));
    service = new CouncilOrchestrationService(harness.config, [
      { adapter: agent, publicAuthor: "claude" },
    ]);
    await service.initialize();
    await waitForRun(service, running.id, (candidate) => candidate.status === "completed", 2_000);
    const failed = await waitForRun(service, waiting.id, (candidate) => candidate.status === "failed", 2_000);
    assert.equal(failed.failure?.code, "execution_interrupted");
  } finally {
    await service?.shutdown();
    service?.close();
    await harness.close();
  }
});

test("扫描上限明确阻止启动，shutdown 清理 sweeper", async () => {
  const harness = await startHttpHarness({
    orchestrationStartupScanLimit: 1,
    orchestrationSweepIntervalMs: 20,
  });
  let service: CouncilOrchestrationService | undefined;
  try {
    const topics = [0, 1].map((index) => harness.database.createTopic({
      title: `上限议题 ${String(index)}`,
      question: "是否明确失败？",
      constraints: [],
      createdBy: "human",
    }));
    const store = new SQLiteCouncilStore(harness.databasePath, 5_000);
    try {
      for (const topic of topics) {
        const idle = await store.createRun(createStoreInput(topic.id));
        await store.replaceRun({ ...idle, status: "running" }, idle.version);
      }
    } finally {
      store.close();
    }
    service = new CouncilOrchestrationService(harness.config, [
      { adapter: new FakeAgent("fake", async () => ({ content: "不应执行" })), publicAuthor: "claude" },
    ]);
    await assert.rejects(service.initialize(), /超过配置上限/);
    await service.shutdown();
    await delay(60);
    const check = new SQLiteCouncilStore(harness.databasePath, 5_000);
    try {
      for (const topic of topics) {
        const page = await check.listRunsForTopic({ topicId: topic.id, limit: 10, offset: 0 });
        assert.equal(page.runs[0]?.status, "running");
      }
    } finally {
      check.close();
    }
  } finally {
    service?.close();
    await harness.close();
  }
});

test("续租丢失留下的 waiting_agent 由同一进程 sweeper 收敛为中断失败", async () => {
  const started = deferred<void>();
  const agent = new FakeAgent("fake", async (_input, { signal }) => {
    started.resolve();
    return await new Promise<AgentResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const harness = await startHttpHarness({
    orchestrationLeaseTtlMs: 120,
    orchestrationLeaseRenewMs: 20,
    orchestrationSweepIntervalMs: 20,
  }, [{ adapter: agent, publicAuthor: "claude" }]);
  try {
    assert(harness.orchestration);
    const topic = harness.database.createTopic({
      title: "续租丢失", question: "同一进程能否自愈？", constraints: [], createdBy: "human",
    });
    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    await started.promise;
    const raw = new SQLiteCouncilStore(harness.databasePath, 5_000);
    try {
      const page = await raw.listRestartCandidates({ limit: 10, offset: 0 });
      assert.equal(page.runs.some((item) => item.id === run.id), true);
    } finally {
      raw.close();
    }
    const direct = new DatabaseSync(harness.databasePath);
    direct.prepare("DELETE FROM orchestration_run_leases WHERE run_id = ?").run(run.id);
    direct.close();
    const failed = await waitForRun(
      harness.orchestration,
      run.id,
      (candidate) => candidate.status === "failed",
      2_000,
    );
    assert.equal(failed.failure?.code, "execution_interrupted");
  } finally {
    await harness.close();
  }
});

test("shutdown 等待取消清理但受总预算限制，永不 settle 的 Adapter 不再写 Store", async () => {
  const started = deferred<void>();
  let observedAbort = false;
  const agent = new FakeAgent("fake", async (_input, { signal }) => {
    signal.addEventListener("abort", () => {
      observedAbort = true;
    }, { once: true });
    started.resolve();
    return await new Promise<AgentResult>(() => undefined);
  });
  const harness = await startHttpHarness({
    orchestrationAgentCleanupTimeoutMs: 30,
    orchestrationShutdownTimeoutMs: 50,
    orchestrationSweepIntervalMs: 20,
  }, [{ adapter: agent, publicAuthor: "claude" }]);
  try {
    assert(harness.orchestration);
    const topic = harness.database.createTopic({
      title: "关闭清理屏障",
      question: "永不退出的 Adapter 会否拖死关闭？",
      constraints: [],
      createdBy: "human",
    });
    const run = await createRunThroughHttp(harness.baseUrl, topic.id);
    await fetch(`${harness.baseUrl}/api/v1/runs/${run.id}/actions/start`, {
      method: "POST", headers: JSON_HEADERS, body: "{}",
    });
    await started.promise;
    const before = Date.now();
    await harness.orchestration.shutdown();
    assert.ok(Date.now() - before < 200);
    assert.equal(observedAbort, true);
    await delay(60);
    assert.equal((await harness.orchestration.getRun(run.id)).status, "waiting_agent");
    assert.equal(harness.database.getTopicDetail(topic.id, 20).messageTotal, 0);
  } finally {
    await harness.close();
  }
});
