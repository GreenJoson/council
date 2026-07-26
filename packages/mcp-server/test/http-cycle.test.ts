/**
 * @input  依赖：真实 Express App、两个确定性 Fake Agent 与完整编排执行面
 * @output 验证：一次开局跑完全程、提问处停住、决策正文与 synthesis 一致、diff 互审与运行度量
 * @pos    自动交接/决策同步/diff 互审/度量的端到端验收；单元语义另有 cycle-driver 与 convergence 测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  AgentInvocationError,
  type AgentAdapter,
  type AgentInvocation,
  type AgentResult,
} from "council-orchestrator";
import { readEnvelope, startHttpHarness } from "./http-harness.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface CycleView {
  cycle: {
    id: string;
    kind: "discussion" | "fix_review";
    stage: string;
    status: string;
    participants: string[];
    runtimeCapabilities: {
      adapterId: string;
      agentConfigRevision: number;
      providerConfigRevision: number;
      bindingRevision: string;
      granted: string[];
    }[];
    turns: {
      agentId: string;
      stage: string;
      stance: string;
      verdictDeclared?: boolean;
    }[];
    currentRound: number;
    roundBudget: number;
  };
  openQuestion?: { question: string; questionMessageId: string };
}

interface TopicDetail {
  messages: { id: string; kind: string; content: string }[];
  decisions: { id: string; title: string; decision: string; status: string }[];
}

function verdict(stance: string): string {
  return ["```council-verdict", `{"stance":"${stance}","summary":"立场"}`, "```"].join("\n");
}

/** 按「谁被召唤 + 什么阶段」给出确定性回复，避免测试依赖时序。 */
class ScriptedAgent implements AgentAdapter {
  readonly seen: string[] = [];
  readonly instructions: string[] = [];

  constructor(
    readonly adapterId: string,
    private readonly reply: (kind: string, call: number) => string,
  ) {}

  invoke(input: AgentInvocation): Promise<AgentResult> {
    this.seen.push(input.messageKind);
    this.instructions.push(input.instruction);
    return Promise.resolve({
      content: this.reply(input.messageKind, this.seen.length),
    } as AgentResult);
  }
}

async function createTopic(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/topics`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      title: "要不要引入收敛状态机",
      question: "自动交接能不能替代人工调度？",
      constraints: [],
    }),
  });
  assert.equal(response.status, 201);
  const envelope = await readEnvelope<{ id: string }>(response);
  assert(envelope.data);
  return envelope.data.id;
}

async function readCycle(baseUrl: string, topicId: string): Promise<CycleView | null> {
  const response = await fetch(`${baseUrl}/api/v1/topics/${topicId}/cycle`);
  assert.equal(response.status, 200);
  return (await readEnvelope<CycleView | null>(response)).data ?? null;
}

async function readLatestCycle(baseUrl: string, topicId: string): Promise<CycleView | null> {
  const response = await fetch(`${baseUrl}/api/v1/topics/${topicId}/cycle/latest`);
  assert.equal(response.status, 200);
  return (await readEnvelope<CycleView | null>(response)).data ?? null;
}

async function readTopic(baseUrl: string, topicId: string): Promise<TopicDetail> {
  const response = await fetch(`${baseUrl}/api/v1/topics/${topicId}`);
  assert.equal(response.status, 200);
  const envelope = await readEnvelope<TopicDetail>(response);
  assert(envelope.data);
  return envelope.data;
}

/** 等到圆桌结算或停在等用户；自动交接是异步的，只能等状态而不是等固定时长。 */
async function settle(
  baseUrl: string,
  topicId: string,
  timeoutMs = 5_000,
): Promise<CycleView | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await readCycle(baseUrl, topicId);
    if (!view || view.cycle.stage === "awaiting_user") {
      return view;
    }
    await delay(15);
  }
  throw new Error("圆桌未在期限内到达终态或提问点。");
}

function harnessWith(
  proposer: ScriptedAgent,
  reviewer: ScriptedAgent,
  runtimeCapabilities: readonly (
    "text" | "repository_read" | "git_diff"
  )[] = ["text"],
): Promise<Awaited<ReturnType<typeof startHttpHarness>>> {
  return startHttpHarness({}, [
    {
      adapter: proposer,
      actorAlias: "claude",
      label: "Claude",
      runtimeCapabilities,
    },
    {
      adapter: reviewer,
      actorAlias: "codex",
      label: "Codex",
      runtimeCapabilities,
    },
  ]);
}

test("点一次开始圆桌即跑完全程，决策正文与最终 synthesis 逐字一致", async () => {
  const synthesisBody = "## 方案\n\n采用收敛状态机，预算 3 轮。\n\n## 风险\n\n预算耗尽需人工接管。";
  const proposer = new ScriptedAgent("claude", (kind) =>
    kind === "synthesis"
      ? `${synthesisBody}\n\n${verdict("agree")}`
      : `${kind} 正文。\n\n${verdict("agree")}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(proposer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude", "codex"], roundBudget: 3 }),
    });
    assert.equal(response.status, 201);

    assert.equal(await settle(harness.baseUrl, topicId), null, "收敛后不应留下活动 cycle");
    assert.deepEqual(proposer.seen, ["proposal", "synthesis"]);
    assert.deepEqual(reviewer.seen, ["critique"], "评审必须由另一位 Agent 做");

    const persisted = await readLatestCycle(harness.baseUrl, topicId);
    assert.equal(persisted?.cycle.kind, "discussion");
    const snapshots = persisted?.cycle.runtimeCapabilities ?? [];
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.adapterId),
      ["claude", "codex"],
    );
    for (const snapshot of snapshots) {
      assert.ok(snapshot.agentConfigRevision > 0);
      assert.ok(snapshot.providerConfigRevision > 0);
      assert.ok(snapshot.bindingRevision.length > 0);
      assert.deepEqual(snapshot.granted, ["text"]);
    }

    const detail = await readTopic(harness.baseUrl, topicId);
    assert.equal(detail.decisions.length, 1);
    const decision = detail.decisions[0];
    assert.equal(decision?.status, "proposed", "接受与否只能由用户决定");
    assert.equal(
      decision?.decision,
      synthesisBody,
      "决策正文必须是 synthesis 原文，协议尾块要剥掉",
    );
  } finally {
    await harness.close();
  }
});

test("Agent 提问时停在原地，用户回答后接着往下走且不重跑已说过的阶段", async () => {
  const question = [
    "```council-question",
    '{"question":"按订阅还是按次计费？","rationale":"影响不可逆","options":["订阅","按次"]}',
    "```",
  ].join("\n");
  const proposer = new ScriptedAgent("claude", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}\n\n${kind === "proposal" ? question : ""}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(proposer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude", "codex"] }),
    });

    const blocked = await settle(harness.baseUrl, topicId);
    assert.equal(blocked?.cycle.stage, "awaiting_user");
    assert.equal(blocked?.openQuestion?.question, "按订阅还是按次计费？");
    assert.deepEqual(reviewer.seen, [], "问题没答之前不得召唤下一位");

    const questionMessageId = blocked?.openQuestion?.questionMessageId ?? "";
    const answer = await fetch(
      `${harness.baseUrl}/api/v1/topics/${topicId}/cycle/answers`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ questionMessageId, content: "按订阅。" }),
      },
    );
    assert.equal(answer.status, 202);

    assert.equal(await settle(harness.baseUrl, topicId), null);
    assert.deepEqual(proposer.seen, ["proposal", "synthesis"], "提案不得重来一遍");
    assert.deepEqual(reviewer.seen, ["critique"]);

    const detail = await readTopic(harness.baseUrl, topicId);
    const answers = detail.messages.filter((message) => message.content === "按订阅。");
    assert.equal(answers.length, 1, "回答必须作为公开消息留在讨论里，且只留一条");
  } finally {
    await harness.close();
  }
});

test("重复提交同一个回答是幂等的，不会灌进第二条公开消息", async () => {
  const question = [
    "```council-question",
    '{"question":"要不要做？","rationale":"不可逆","options":[]}',
    "```",
  ].join("\n");
  const proposer = new ScriptedAgent("claude", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}\n\n${kind === "proposal" ? question : ""}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(proposer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude", "codex"] }),
    });
    const blocked = await settle(harness.baseUrl, topicId);
    const questionMessageId = blocked?.openQuestion?.questionMessageId ?? "";
    const body = JSON.stringify({ questionMessageId, content: "要做。" });
    const send = (): Promise<Response> =>
      fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle/answers`, {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      });

    assert.equal((await send()).status, 202);
    assert.equal((await send()).status, 202, "重放必须成功而不是报冲突");

    await settle(harness.baseUrl, topicId);
    const detail = await readTopic(harness.baseUrl, topicId);
    const answers = detail.messages.filter((message) => message.content === "要做。");
    assert.equal(answers.length, 1);
  } finally {
    await harness.close();
  }
});

test("名册不足两位时拒绝开局：一个人自说自话不构成互审", async () => {
  const proposer = new ScriptedAgent("claude", () => `正文。\n\n${verdict("agree")}`);
  const reviewer = new ScriptedAgent("codex", () => `正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(proposer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude"] }),
    });
    assert.equal(response.status, 400);
    assert.equal(await readCycle(harness.baseUrl, topicId), null);
    assert.deepEqual(proposer.seen, []);
  } finally {
    await harness.close();
  }
});

test("bug 修复互审只读核对交互式任务产生的 commit，不要求 Agent 修改或提交", async () => {
  const reviewedCommit = "a1b2c3d4e5f6";
  const fixer = new ScriptedAgent("claude", (kind) => kind === "proposal"
    ? [
        `${kind} 正文。`,
        "",
        "```council-fix",
        `{"commit":"${reviewedCommit}","summary":"核对已有修复"}`,
        "```",
        "",
        verdict("agree"),
      ].join("\n")
    : `${kind} 正文。\n\n${verdict("agree")}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(
    fixer,
    reviewer,
    ["text", "repository_read", "git_diff"],
  );
  try {
    const topicId = await createTopic(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        participants: ["claude", "codex"],
        kind: "fix_review",
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(await settle(harness.baseUrl, topicId), null);
    assert.deepEqual(fixer.seen, ["proposal", "synthesis"]);
    assert.deepEqual(reviewer.seen, ["critique"]);
    assert.match(fixer.instructions[0] ?? "", /只读 bug 修复互审/);
    assert.doesNotMatch(fixer.instructions[0] ?? "", /先自审并提交/);
    assert.match(reviewer.instructions[0] ?? "", new RegExp(`git show ${reviewedCommit}`));
  } finally {
    await harness.close();
  }
});

test("task 附件能力同样在开局前检查，文本 Runtime 不能假装读取媒体", async () => {
  const fixer = new ScriptedAgent("claude", (kind) =>
    `我已经改好并提交了，请复审。\n\n${verdict("agree")}\n\n${kind}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(fixer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        participants: ["claude", "codex"],
        kind: "discussion",
        taskRequirements: { all: ["media_read", "vision"] },
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(fixer.seen, []);
    assert.deepEqual(reviewer.seen, []);
  } finally {
    await harness.close();
  }
});

test("度量从既有落库状态推算：轮次、耗时、提问次数与决策一致性", async () => {
  const synthesisBody = "## 方案\n\n就这么做。";
  const question = [
    "```council-question",
    '{"question":"要不要做？","rationale":"不可逆","options":[]}',
    "```",
  ].join("\n");
  const proposer = new ScriptedAgent("claude", (kind) =>
    kind === "synthesis"
      ? `${synthesisBody}\n\n${verdict("agree")}`
      : `${kind} 正文。\n\n${verdict("agree")}\n\n${kind === "proposal" ? question : ""}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(proposer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude", "codex"] }),
    });
    const blocked = await settle(harness.baseUrl, topicId);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle/answers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        questionMessageId: blocked?.openQuestion?.questionMessageId ?? "",
        content: "做。",
      }),
    });
    await settle(harness.baseUrl, topicId);

    const response = await fetch(
      `${harness.baseUrl}/api/v1/orchestration/cycle-metrics`,
    );
    assert.equal(response.status, 200);
    const metrics = (await readEnvelope<{
      cycles: {
        total: number;
        converged: number;
        abandoned: number;
        active: number;
        awaitingUser: number;
      };
      rounds: { count: number; max: number };
      wallClockMs: { count: number };
      questions: { total: number; open: number; perCycle: number };
      verdicts: { checked: number; missing: number; missingCycleIds: string[] };
      decisionConsistency: { checked: number; divergedCycleIds: string[] };
    }>(response)).data;
    assert(metrics);

    assert.deepEqual(metrics.cycles, {
      total: 1,
      converged: 1,
      abandoned: 0,
      active: 0,
      awaitingUser: 0,
    });
    assert.equal(metrics.rounds.count, 1);
    assert.equal(metrics.rounds.max, 1, "全体同意时不该多走轮次");
    assert.equal(metrics.wallClockMs.count, 1);
    assert.deepEqual(metrics.questions, { total: 1, open: 0, perCycle: 1 });
    assert.deepEqual(metrics.verdicts, {
      checked: 3,
      missing: 0,
      missingCycleIds: [],
    });
    assert.equal(metrics.decisionConsistency.checked, 1);
    assert.deepEqual(
      metrics.decisionConsistency.divergedCycleIds,
      [],
      "刚写完就该一致；不一致说明步骤 6 的搬运有问题",
    );
  } finally {
    await harness.close();
  }
});

test("缺少 verdict 的发言进入可观测度量，不能只在运行日志里悄悄降级", async () => {
  const proposer = new ScriptedAgent("claude", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(proposer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude", "codex"] }),
    });
    await settle(harness.baseUrl, topicId);

    const raw = new (await import("node:sqlite")).DatabaseSync(harness.databasePath);
    try {
      raw.exec(`
        UPDATE discussion_cycles
        SET turns_json = json_set(turns_json, '$[0].verdictDeclared', json('false'))
      `);
    } finally {
      raw.close();
    }

    const response = await fetch(
      `${harness.baseUrl}/api/v1/orchestration/cycle-metrics`,
    );
    const metrics = (await readEnvelope<{
      verdicts: { checked: number; missing: number; missingCycleIds: string[] };
    }>(response)).data;
    assert.equal(metrics?.verdicts.checked, 3);
    assert.equal(metrics?.verdicts.missing, 1);
    assert.equal(metrics?.verdicts.missingCycleIds.length, 1);
  } finally {
    await harness.close();
  }
});

test("决策正文被事后改写时，一致性核对必须报出来而不是继续说一切正常", async () => {
  const proposer = new ScriptedAgent("claude", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(proposer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude", "codex"] }),
    });
    await settle(harness.baseUrl, topicId);

    // 绕过应用层直接改库，模拟"决策被人改了但讨论没动"这一类事后背离。
    const raw = new (await import("node:sqlite")).DatabaseSync(harness.databasePath);
    try {
      raw.exec("UPDATE decisions SET decision = '偷偷换掉的结论'");
    } finally {
      raw.close();
    }

    const response = await fetch(
      `${harness.baseUrl}/api/v1/orchestration/cycle-metrics`,
    );
    const metrics = (await readEnvelope<{
      decisionConsistency: { checked: number; divergedCycleIds: string[] };
    }>(response)).data;
    assert.equal(metrics?.decisionConsistency.checked, 1);
    assert.equal(metrics?.decisionConsistency.divergedCycleIds.length, 1);
  } finally {
    await harness.close();
  }
});

test("Agent 反复失败时圆桌停住等人，不对同一阶段无限重召唤", async () => {
  class AlwaysFails implements AgentAdapter {
    calls = 0;
    constructor(readonly adapterId: string) {}
    invoke(): Promise<AgentResult> {
      this.calls += 1;
      return Promise.reject(new AgentInvocationError("假失败", true, "Agent 调用失败"));
    }
  }
  const proposer = new AlwaysFails("claude");
  const reviewer = new AlwaysFails("codex");
  const harness = await startHttpHarness({}, [
    { adapter: proposer, actorAlias: "claude", label: "Claude" },
    { adapter: reviewer, actorAlias: "codex", label: "Codex" },
  ]);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ participants: ["claude", "codex"] }),
    });
    await delay(600);

    // Run 自身的 maxAttemptsPerRound 允许有限重试；不设防时这里会是几十次。
    assert.ok(
      proposer.calls <= 2,
      `提案人被召唤了 ${String(proposer.calls)} 次，说明失败后仍在自动重召唤`,
    );
    assert.equal(reviewer.calls, 0, "提案没成功就不该往下交接");

    // 卡住的圆桌必须留有出口，否则这个议题再也开不了新圆桌。
    const view = await readCycle(harness.baseUrl, topicId);
    assert.equal(view?.cycle.status, "active");
    const abandoned = await fetch(
      `${harness.baseUrl}/api/v1/topics/${topicId}/cycle`,
      { method: "DELETE" },
    );
    assert.equal(abandoned.status, 200);
    assert.equal(await readCycle(harness.baseUrl, topicId), null);
  } finally {
    await harness.close();
  }
});
