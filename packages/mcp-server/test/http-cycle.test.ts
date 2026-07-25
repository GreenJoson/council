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
import type {
  AgentAdapter,
  AgentInvocation,
  AgentResult,
} from "council-orchestrator";
import { readEnvelope, startHttpHarness } from "./http-harness.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface CycleView {
  cycle: {
    id: string;
    stage: string;
    status: string;
    participants: string[];
    turns: { agentId: string; stage: string; stance: string }[];
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
): Promise<Awaited<ReturnType<typeof startHttpHarness>>> {
  return startHttpHarness({}, [
    { adapter: proposer, actorAlias: "claude", label: "Claude" },
    { adapter: reviewer, actorAlias: "codex", label: "Codex" },
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

test("bug 修复互审：复审者拿到修复者提交的 commit，并被要求只读地读 diff", async () => {
  const commit = "a1b2c3d4e5f6a7b8";
  const fixer = new ScriptedAgent("claude", (kind) =>
    kind === "proposal"
      ? [
        "修好了越界读。",
        "",
        "```council-fix",
        `{"commit":"${commit}","summary":"修正边界判断"}`,
        "```",
        "",
        verdict("agree"),
      ].join("\n")
      : `${kind} 正文。\n\n${verdict("agree")}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(fixer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        participants: ["claude", "codex"],
        requiresCommitRef: true,
      }),
    });
    await settle(harness.baseUrl, topicId);

    assert.ok(
      fixer.instructions[0]?.includes("```council-fix\n"),
      "修复者开局就该被要求提交并附上 commit",
    );
    const review = reviewer.instructions[0] ?? "";
    assert.ok(review.includes(`git show ${commit}`), "复审者必须拿到被审的那份 diff");
    assert.ok(review.includes("只读复审"), "复审者不得改代码或部署");
    assert.notEqual(reviewer.adapterId, fixer.adapterId, "复审必须换人");
  } finally {
    await harness.close();
  }
});

test("修复者只在正文里声称改好而不给 commit 时，复审者仍被要求拦下来", async () => {
  const fixer = new ScriptedAgent("claude", (kind) =>
    `我已经改好并提交了，请复审。\n\n${verdict("agree")}\n\n${kind}`);
  const reviewer = new ScriptedAgent("codex", (kind) =>
    `${kind} 正文。\n\n${verdict("agree")}`);
  const harness = await harnessWith(fixer, reviewer);
  try {
    const topicId = await createTopic(harness.baseUrl);
    await fetch(`${harness.baseUrl}/api/v1/topics/${topicId}/cycle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        participants: ["claude", "codex"],
        requiresCommitRef: true,
      }),
    });
    await settle(harness.baseUrl, topicId);

    const review = reviewer.instructions[0] ?? "";
    assert.ok(!review.includes("git show"), "没有引用就没有可读的 diff，不该编一个出来");
    assert.ok(
      review.includes("验证不了的改动"),
      "缺引用恰恰是复审必须拦截的情形，规则不能只在有引用时才下发",
    );
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
