/**
 * @input  依赖：CouncilOrchestrator、Fake Store、Fake Agent 与 Node 测试器
 * @output 导出：轮次、begin/drive、lease、超时、人工门、失败消息边界和恢复测试
 * @pos    自动编排状态机、续租与重启安全边界的主验证套件
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInvocationError,
  classifyRestartDisposition,
  CouncilOrchestrator,
  InvalidRunStateError,
  LeaseLostError,
  MAX_TIMER_DELAY_MS,
  OrchestrationConfigError,
  StoreConflictError,
} from "../src/index.js";
import type {
  ApproveGateInput,
  CreateRunInput,
  OrchestrationPolicy,
  OrchestrationRun,
  RoundPlan,
} from "../src/types.js";
import { deferred, FakeAgentAdapter, FakeCouncilStore } from "./fakes.js";

const BASE_POLICY: OrchestrationPolicy = {
  maxRounds: 4,
  allowedAgents: ["alpha", "beta"],
  agentTimeoutMs: 100,
  agentCleanupTimeoutMs: 50,
  maxAttemptsPerRound: 1,
  maxManualRecoveries: 1,
  confirmation: {
    beforeRounds: [],
    beforeCompletion: false,
  },
};

const LEASE_REQUEST = {
  ownerId: "test-runner",
  ttlMs: 60_000,
  renewIntervalMs: 30_000,
} as const;

function input(
  plan: readonly RoundPlan[],
  policy: OrchestrationPolicy = BASE_POLICY,
): CreateRunInput {
  return { topicId: "topic_test", plan, policy };
}

test("按计划完成多 Agent 多消息类型轮次", async () => {
  const store = new FakeCouncilStore();
  const alpha = new FakeAgentAdapter("alpha", async (invocation) => ({
    content: `alpha-${String(invocation.roundNumber)}`,
  }));
  const beta = new FakeAgentAdapter("beta", async (invocation) => ({
    content: `beta-${String(invocation.roundNumber)}`,
  }));
  const orchestrator = new CouncilOrchestrator(store, [alpha, beta]);
  const created = await orchestrator.createRun(input([
    { adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "给出独立方案" },
    { adapterId: "beta", publicAuthor: "codex", messageKind: "critique", instruction: "进行对抗性审查" },
    { adapterId: "alpha", publicAuthor: "claude", messageKind: "rebuttal", instruction: "回应具体批评" },
  ]));

  assert.equal(created.status, "idle");
  const completed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(completed.status, "completed");
  assert.equal(completed.stopReason, "plan_completed");
  assert.equal(completed.nextRoundIndex, 3);
  assert.deepEqual(store.messages.map((message) => message.kind), [
    "proposal",
    "critique",
    "rebuttal",
  ]);
  assert.deepEqual(store.messages.map((message) => message.author), [
    "claude",
    "codex",
    "claude",
  ]);
  assert.ok(store.statusHistory.includes("running"));
  assert.ok(store.statusHistory.includes("waiting_agent"));
});

test("Agent 可重试失败在尝试上限后进入 failed", async () => {
  const store = new FakeCouncilStore();
  const failing = new FakeAgentAdapter("alpha", async () => {
    throw new AgentInvocationError("测试 Agent 暂时失败。", true);
  });
  const orchestrator = new CouncilOrchestrator(store, [failing]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    {
      ...BASE_POLICY,
      allowedAgents: ["alpha"],
      maxAttemptsPerRound: 2,
    },
  ));

  const failed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.code, "agent_failed");
  assert.doesNotMatch(failed.failure?.message ?? "", /测试 Agent 暂时失败/);
  assert.equal(failing.invocations.length, 2);
  assert.equal(store.messages.length, 0);
});

test("Agent 只有显式声明的安全原因可以进入运行快照", async () => {
  const store = new FakeCouncilStore();
  const failing = new FakeAgentAdapter("alpha", async () => {
    throw new AgentInvocationError(
      "内部诊断不得公开。",
      false,
      "Agent 已达到本轮工具回合上限，请缩小议题范围。",
    );
  });
  const orchestrator = new CouncilOrchestrator(store, [failing]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));

  const failed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.message, "Agent 已达到本轮工具回合上限，请缩小议题范围。");
  assert.doesNotMatch(failed.failure?.message ?? "", /内部诊断/);
});

test("超时后 Adapter 永不 settle 会按 agent_cleanup_timeout 非重试失败", async () => {
  const store = new FakeCouncilStore();
  let observedAbort = false;
  const hanging = new FakeAgentAdapter("alpha", async (_input, { signal }) => {
    signal.addEventListener("abort", () => {
      observedAbort = true;
    }, { once: true });
    return await new Promise(() => undefined);
  });
  const orchestrator = new CouncilOrchestrator(store, [hanging]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    {
      ...BASE_POLICY,
      allowedAgents: ["alpha"],
      agentTimeoutMs: 20,
    },
  ));

  const failed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.code, "agent_cleanup_timeout");
  assert.equal(failed.failure?.retryable, false);
  assert.equal(observedAbort, true);
  assert.equal(store.messages.length, 0);
});

test("超时取消先等待 Adapter 清理完成，再允许下一次调用", async () => {
  const store = new FakeCouncilStore();
  let firstSettled = false;
  let secondStartedBeforeCleanup = false;
  const agent = new FakeAgentAdapter("alpha", async (_input, { signal }, callNumber) => {
    if (callNumber === 1) {
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            firstSettled = true;
            reject(new AgentInvocationError("第一次调用已清理。", true));
          }, 10);
        }, { once: true });
      });
    }
    secondStartedBeforeCleanup = !firstSettled;
    return { content: "第二次调用成功。" };
  });
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    {
      ...BASE_POLICY,
      allowedAgents: ["alpha"],
      agentTimeoutMs: 30,
      maxAttemptsPerRound: 2,
    },
  ));

  const completed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(completed.status, "completed");
  assert.equal(agent.invocations.length, 2);
  assert.equal(secondStartedBeforeCleanup, false);
});

test("Adapter 取消清理超过上限后非重试失败且捕获迟到 Promise", async () => {
  const store = new FakeCouncilStore();
  const agent = new FakeAgentAdapter("alpha", async () => await new Promise(() => undefined));
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    {
      ...BASE_POLICY,
      allowedAgents: ["alpha"],
      agentTimeoutMs: 15,
      maxAttemptsPerRound: 2,
    },
  ));

  const failed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.code, "agent_cleanup_timeout");
  assert.equal(failed.failure?.retryable, false);
  assert.equal(agent.invocations.length, 1);
});

test("Agent 超长公开回复在核心边界失败且不提交消息", async () => {
  const store = new FakeCouncilStore();
  const agent = new FakeAgentAdapter("alpha", async () => ({
    content: "x".repeat(30_001),
  }));
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));

  const failed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.code, "agent_failed");
  assert.equal(store.messages.length, 0);
});

test("等待 Agent 时取消会阻止迟到消息提交", async () => {
  const store = new FakeCouncilStore();
  const started = deferred<void>();
  const waiting = new FakeAgentAdapter("alpha", async (_input, { signal }) => {
    started.resolve();
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const orchestrator = new CouncilOrchestrator(store, [waiting]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));

  const running = orchestrator.start(created.id, LEASE_REQUEST);
  await started.promise;
  const cancelled = await orchestrator.cancel(created.id);
  const settled = await running;

  assert.equal(cancelled.status, "cancelled");
  assert.equal(settled.status, "cancelled");
  assert.equal(store.messages.length, 0);
});

test("达到最大轮数后确定性停止且不执行剩余计划", async () => {
  const store = new FakeCouncilStore();
  const alpha = new FakeAgentAdapter("alpha", async () => ({ content: "alpha" }));
  const beta = new FakeAgentAdapter("beta", async () => ({ content: "beta" }));
  const orchestrator = new CouncilOrchestrator(store, [alpha, beta]);
  const created = await orchestrator.createRun(input([
    { adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "第一轮" },
    { adapterId: "beta", publicAuthor: "codex", messageKind: "critique", instruction: "第二轮" },
    { adapterId: "alpha", publicAuthor: "chair", messageKind: "synthesis", instruction: "第三轮" },
  ], {
    ...BASE_POLICY,
    maxRounds: 2,
  }));

  const completed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(completed.status, "completed");
  assert.equal(completed.stopReason, "max_rounds_reached");
  assert.equal(completed.nextRoundIndex, 2);
  assert.equal(store.messages.length, 2);
  assert.equal(alpha.invocations.length, 1);
});

test("轮前和完成前人工门必须分别确认", async () => {
  const store = new FakeCouncilStore();
  const agent = new FakeAgentAdapter("alpha", async (invocation) => ({
    content: `round-${String(invocation.roundNumber)}`,
  }));
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input([
    { adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "第一轮" },
    { adapterId: "alpha", publicAuthor: "chair", messageKind: "synthesis", instruction: "第二轮" },
  ], {
    ...BASE_POLICY,
    allowedAgents: ["alpha"],
    confirmation: {
      beforeRounds: [2],
      beforeCompletion: true,
    },
  }));

  const beforeSecond = await orchestrator.start(created.id, LEASE_REQUEST);
  assert.equal(beforeSecond.status, "waiting_user");
  assert.equal(beforeSecond.pendingGateId, "before_round:2");
  assert.equal(store.messages.length, 1);

  const beforeCompletion = await orchestrator.approve({
    runId: created.id,
    expectedGateId: beforeSecond.pendingGateId ?? "",
    expectedVersion: beforeSecond.version,
    approvalId: "approval_round_2",
    approvedBy: "human",
  }, LEASE_REQUEST);
  assert.equal(beforeCompletion.status, "waiting_user");
  assert.equal(beforeCompletion.pendingGateId, "before_completion");
  assert.equal(store.messages.length, 2);

  const completed = await orchestrator.approve({
    runId: created.id,
    expectedGateId: beforeCompletion.pendingGateId ?? "",
    expectedVersion: beforeCompletion.version,
    approvalId: "approval_completion",
    approvedBy: "human",
  }, LEASE_REQUEST);
  assert.equal(completed.status, "completed");
  assert.equal(completed.stopReason, "plan_completed");
});

test("显式失败恢复受独立预算限制", async () => {
  const store = new FakeCouncilStore();
  const failing = new FakeAgentAdapter("alpha", async () => {
    throw new AgentInvocationError("持续失败。", false);
  });
  const orchestrator = new CouncilOrchestrator(store, [failing]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    {
      ...BASE_POLICY,
      allowedAgents: ["alpha"],
      maxManualRecoveries: 1,
    },
  ));

  const firstFailure = await orchestrator.start(created.id, LEASE_REQUEST);
  assert.equal(firstFailure.status, "failed");
  const secondFailure = await orchestrator.recover(created.id, LEASE_REQUEST);
  assert.equal(secondFailure.status, "failed");
  assert.equal(secondFailure.manualRecoveriesUsed, 1);
  await assert.rejects(
    orchestrator.recover(created.id, LEASE_REQUEST),
    (error: unknown) =>
      error instanceof InvalidRunStateError && /恢复次数上限/.test(error.message),
  );
});

test("相同 approvalId 重放不会跨过下一道人工门", async () => {
  const store = new FakeCouncilStore();
  const agent = new FakeAgentAdapter("alpha", async (invocation) => ({
    content: `round-${String(invocation.roundNumber)}`,
  }));
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input([
    {
      adapterId: "alpha",
      publicAuthor: "claude",
      messageKind: "proposal",
      instruction: "第一轮",
    },
    {
      adapterId: "alpha",
      publicAuthor: "chair",
      messageKind: "synthesis",
      instruction: "第二轮",
    },
  ], {
    ...BASE_POLICY,
    allowedAgents: ["alpha"],
    confirmation: {
      beforeRounds: [1, 2],
      beforeCompletion: false,
    },
  }));

  const firstGate = await orchestrator.start(created.id, LEASE_REQUEST);
  const firstApproval: ApproveGateInput = {
    runId: created.id,
    expectedGateId: firstGate.pendingGateId ?? "",
    expectedVersion: firstGate.version,
    approvalId: "approval_first_gate",
    approvedBy: "human",
  };
  const secondGate = await orchestrator.approve(firstApproval, LEASE_REQUEST);
  assert.equal(secondGate.pendingGateId, "before_round:2");
  assert.equal(store.messages.length, 1);

  const replayed = await orchestrator.approve(firstApproval, LEASE_REQUEST);
  assert.equal(replayed.pendingGateId, "before_round:2");
  assert.equal(replayed.version, secondGate.version);
  assert.equal(store.messages.length, 1);
  assert.equal(agent.invocations.length, 1);

  await assert.rejects(
    orchestrator.approve({
      ...firstApproval,
      expectedGateId: "before_round:2",
      expectedVersion: secondGate.version,
    }, LEASE_REQUEST),
    StoreConflictError,
  );
  await assert.rejects(
    orchestrator.approve({
      runId: created.id,
      expectedGateId: "before_round:2",
      expectedVersion: firstGate.version,
      approvalId: "approval_stale_version",
      approvedBy: "human",
    }, LEASE_REQUEST),
    StoreConflictError,
  );
});

test("拒绝超过 Node.js 安全计时器上限的超时配置", async () => {
  const store = new FakeCouncilStore();
  const orchestrator = new CouncilOrchestrator(store, []);

  await assert.rejects(
    orchestrator.createRun(input(
      [{
        adapterId: "alpha",
        publicAuthor: "claude",
        messageKind: "proposal",
        instruction: "提出方案",
      }],
      {
        ...BASE_POLICY,
        allowedAgents: ["alpha"],
        agentTimeoutMs: MAX_TIMER_DELAY_MS + 1,
      },
    )),
    (error: unknown) =>
      error instanceof OrchestrationConfigError && /计时器上限/.test(error.message),
  );
});

test("commitRound 失败归类为 store_failed 且不重新调用 Agent", async () => {
  const store = new FakeCouncilStore();
  store.commitFailure = new Error("测试存储提交失败。");
  const agent = new FakeAgentAdapter("alpha", async () => ({ content: "已生成回复" }));
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input(
    [{
      adapterId: "alpha",
      publicAuthor: "claude",
      messageKind: "proposal",
      instruction: "提出方案",
    }],
    {
      ...BASE_POLICY,
      allowedAgents: ["alpha"],
      maxAttemptsPerRound: 3,
    },
  ));

  const failed = await orchestrator.start(created.id, LEASE_REQUEST);

  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.code, "store_failed");
  assert.equal(agent.invocations.length, 1);
  assert.equal(store.commitAttempts, 1);
  assert.equal(store.messages.length, 0);
});

test("缺少 Store lease 时 running 和 waiting_agent 均禁止恢复", async () => {
  const runningStore = new FakeCouncilStore();
  const runningOrchestrator = new CouncilOrchestrator(runningStore, []);
  const runningCreated = await runningOrchestrator.createRun(input(
    [{
      adapterId: "alpha",
      publicAuthor: "claude",
      messageKind: "proposal",
      instruction: "提出方案",
    }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));
  runningStore.corruptRun(runningCreated.id, (run) => ({ ...run, status: "running" }));
  await assert.rejects(
    runningOrchestrator.recover(runningCreated.id, LEASE_REQUEST),
    (error: unknown) =>
      error instanceof InvalidRunStateError && /只有 failed/.test(error.message),
  );

  const waitingStore = new FakeCouncilStore();
  const started = deferred<void>();
  const waitingAgent = new FakeAgentAdapter("alpha", async (_input, { signal }) => {
    started.resolve();
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const activeOrchestrator = new CouncilOrchestrator(waitingStore, [waitingAgent]);
  const recoveryOrchestrator = new CouncilOrchestrator(waitingStore, [waitingAgent]);
  const waitingCreated = await activeOrchestrator.createRun(input(
    [{
      adapterId: "alpha",
      publicAuthor: "claude",
      messageKind: "proposal",
      instruction: "提出方案",
    }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));
  const activeRun = activeOrchestrator.start(waitingCreated.id, LEASE_REQUEST);
  await started.promise;
  await assert.rejects(
    recoveryOrchestrator.recover(waitingCreated.id, LEASE_REQUEST),
    (error: unknown) =>
      error instanceof InvalidRunStateError && /只有 failed/.test(error.message),
  );
  await activeOrchestrator.cancel(waitingCreated.id);
  await activeRun;
});

test("公共入口拒绝 gate、index、attempt 和 activeAgent 不一致的持久化运行", async () => {
  const corruptions: ReadonlyArray<
    (run: OrchestrationRun) => OrchestrationRun
  > = [
    (run) => ({ ...run, nextRoundIndex: 2 }),
    (run) => ({ ...run, status: "waiting_user", pendingGateId: "before_round:1" }),
    (run) => ({ ...run, currentAttempt: run.policy.maxAttemptsPerRound + 1 }),
    (run) => ({ ...run, activeAgentId: "alpha" }),
  ];

  for (const corrupt of corruptions) {
    const store = new FakeCouncilStore();
    const orchestrator = new CouncilOrchestrator(store, []);
    const created = await orchestrator.createRun(input(
      [{
        adapterId: "alpha",
        publicAuthor: "claude",
        messageKind: "proposal",
        instruction: "提出方案",
      }],
      { ...BASE_POLICY, allowedAgents: ["alpha"] },
    ));
    store.corruptRun(created.id, corrupt);
    await assert.rejects(orchestrator.getRun(created.id), InvalidRunStateError);
  }
});

test("begin 只完成原子转换，drive 在独立 lease 下继续执行", async () => {
  const store = new FakeCouncilStore();
  const agent = new FakeAgentAdapter("alpha", async () => ({ content: "公开方案" }));
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));

  const running = await orchestrator.begin(created.id);
  assert.equal(running.status, "running");
  assert.equal(agent.invocations.length, 0);
  const lease = await orchestrator.claimRunLease({
    runId: running.id,
    ownerId: "detached-runner",
    ttlMs: 60_000,
  });
  const completed = await orchestrator.drive(running.id, lease);
  assert.equal(completed.status, "completed");
  assert.equal(agent.invocations.length, 1);
  assert.equal(await orchestrator.releaseRunLease(lease), true);
});

test("同步便捷执行会按调用参数续租慢 Agent", async () => {
  const store = new FakeCouncilStore();
  const agent = new FakeAgentAdapter("alpha", async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    return { content: "慢速公开方案" };
  });
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));

  const completed = await orchestrator.start(created.id, {
    ownerId: "heartbeat-runner",
    ttlMs: 40,
    renewIntervalMs: 10,
  });
  assert.equal(completed.status, "completed");
  assert.equal(store.messages.length, 1);
});

test("重启分类不会自动重放 waiting_agent", async () => {
  const store = new FakeCouncilStore();
  const orchestrator = new CouncilOrchestrator(store, []);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));
  const running = await orchestrator.begin(created.id);
  const lease = await orchestrator.claimRunLease({
    runId: running.id,
    ownerId: "restart-runner",
    ttlMs: 60_000,
  });
  const waiting = await store.replaceRunWithLease(
    {
      ...running,
      status: "waiting_agent",
      activeAgentId: "alpha",
      currentAttempt: 1,
    },
    running.version,
    lease,
  );

  assert.equal(classifyRestartDisposition(running), "resume_running");
  assert.equal(classifyRestartDisposition(waiting), "fail_interrupted_agent");
  await assert.rejects(orchestrator.drive(waiting.id, lease), InvalidRunStateError);
  const interrupted = await orchestrator.markInterruptedAgent(waiting.id, lease);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.failure?.code, "execution_interrupted");
});

test("人工确认门拒绝非 human 批准者", async () => {
  const store = new FakeCouncilStore();
  const orchestrator = new CouncilOrchestrator(store, []);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    {
      ...BASE_POLICY,
      allowedAgents: ["alpha"],
      confirmation: { beforeRounds: [1], beforeCompletion: false },
    },
  ));
  const running = await orchestrator.begin(created.id);
  const lease = await orchestrator.claimRunLease({
    runId: running.id,
    ownerId: "gate-runner",
    ttlMs: 60_000,
  });
  const gate = await orchestrator.drive(running.id, lease);
  await assert.rejects(
    orchestrator.applyApproval({
      runId: gate.id,
      expectedGateId: gate.pendingGateId ?? "",
      expectedVersion: gate.version,
      approvalId: "approval_not_human",
      approvedBy: "claude",
    }),
    OrchestrationConfigError,
  );
});

test("持久化运行不能越过未确认的轮次门", async () => {
  const corruptions: ReadonlyArray<(run: OrchestrationRun) => OrchestrationRun> = [
    (run) => ({ ...run, status: "running", nextRoundIndex: 1 }),
    (run) => ({
      ...run,
      status: "waiting_agent",
      activeAgentId: "alpha",
      currentAttempt: 1,
    }),
  ];
  for (const corrupt of corruptions) {
    const store = new FakeCouncilStore();
    const orchestrator = new CouncilOrchestrator(store, []);
    const created = await orchestrator.createRun(input(
      [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
      {
        ...BASE_POLICY,
        allowedAgents: ["alpha"],
        confirmation: { beforeRounds: [1], beforeCompletion: false },
      },
    ));
    store.corruptRun(created.id, corrupt);
    await assert.rejects(orchestrator.getRun(created.id), InvalidRunStateError);
  }
});

test("续租失败按 lease 丢失中断，不归因 Agent 且不提交迟到消息", async () => {
  const store = new FakeCouncilStore();
  store.renewFailure = new Error("测试 SQLite 续租失败。");
  const agent = new FakeAgentAdapter("alpha", async (_input, { signal }) => {
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const orchestrator = new CouncilOrchestrator(store, [agent]);
  const created = await orchestrator.createRun(input(
    [{ adapterId: "alpha", publicAuthor: "claude", messageKind: "proposal", instruction: "提出方案" }],
    { ...BASE_POLICY, allowedAgents: ["alpha"] },
  ));

  await assert.rejects(
    orchestrator.start(created.id, {
      ownerId: "renew-failure-runner",
      ttlMs: 50,
      renewIntervalMs: 10,
    }),
    LeaseLostError,
  );
  const persisted = await orchestrator.getRun(created.id);
  assert.equal(persisted.status, "waiting_agent");
  assert.equal(persisted.failure, undefined);
  assert.equal(store.messages.length, 0);
});
