/**
 * @input  依赖：真实迁移库上的 SQLiteCouncilStore、伪 Run 执行器与伪决策写入
 * @output 验证：开局后自动交接到每一位、提问处停住、收敛写 proposed 决策、预算用尽放弃
 * @pos    自动交接的行为验收；Run/lease 那一半由 sqlite-council-store 的原子提交测试覆盖
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  SQLiteCouncilStore,
  commitCycleTurn,
  deriveCycleRequirements,
} from "council-orchestrator";
import { ACTOR_SNAPSHOT_SCHEMA_VERSION } from "../src/actor-identity.js";
import { CycleDriver, type CycleRunner } from "../src/orchestration/cycle-driver.js";
import { migrateCouncilSchema } from "../src/schema-migrator.js";

const TOPIC = "topic_driver";
const NOW = "2026-01-01T00:00:00.000Z";
const PARTICIPANTS = ["claude", "codex"] as const;

function cycleStartInput(roundBudget?: number) {
  return {
    topicId: TOPIC,
    participants: PARTICIPANTS,
    kind: "discussion" as const,
    requirements: deriveCycleRequirements({
      kind: "discussion",
      participants: PARTICIPANTS,
    }),
    runtimeCapabilities: PARTICIPANTS.map((adapterId) => ({
      schemaVersion: 1 as const,
      adapterId,
      actorId: adapterId,
      agentConfigRevision: 1,
      providerId: `provider-${adapterId}`,
      providerConfigRevision: 1,
      bindingRevision: `test:${adapterId}`,
      transportKind: "test",
      declared: ["text" as const],
      granted: ["text" as const],
    })),
    ...(roundBudget === undefined ? {} : { roundBudget }),
  };
}

const ACTOR_SNAPSHOT_SQL = `
  json_object(
    'schemaVersion', ${String(ACTOR_SNAPSHOT_SCHEMA_VERSION)},
    'actorId', id, 'slug', slug, 'displayName', display_name,
    'shortName', short_name, 'role', role
  )
`;

interface Invocation {
  adapterId: string;
  messageKind: string;
  instruction: string;
}

interface Harness {
  store: SQLiteCouncilStore;
  driver: CycleDriver;
  invocations: Invocation[];
  decisions: string[];
  /** 让下一次被召唤的 Agent 以给定立场发言；可附带一个阻塞提问。 */
  replyWith: (stance: string, question?: boolean) => void;
  /** 以用户身份发一条公开消息，返回消息 id。 */
  postHumanMessage: (content: string) => string;
  cleanup: () => void;
}

async function createHarness(): Promise<Harness> {
  const directory = mkdtempSync(path.join(tmpdir(), "council-driver-"));
  const databasePath = path.join(directory, "council.sqlite3");
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });

  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    INSERT INTO topics (
      id, title, question, constraints_json, project_path, status,
      created_by_actor_id, created_by_snapshot_json, created_by_legacy,
      created_at, updated_at
    )
    SELECT '${TOPIC}', '圆桌', '要不要做', '[]', NULL, 'open',
      id, ${ACTOR_SNAPSHOT_SQL}, NULL, '${NOW}', '${NOW}'
    FROM actor_identities WHERE id = 'human';
  `);

  const store = new SQLiteCouncilStore(databasePath, 5_000);
  const invocations: Invocation[] = [];
  const decisions: string[] = [];
  let nextStance = "agree";
  let nextQuestion = false;
  let messageSequence = 0;

  /**
   * 伪执行器：不真的召唤模型，直接把「Agent 回复」按生产同一条路径落库——
   * 写公开消息 + 在同一处记录发言。Run/lease 的原子性另有测试覆盖。
   */
  const runner: CycleRunner = {
    createRun: (_topicId, plan) => {
      const round = plan[0];
      if (!round) {
        throw new Error("计划为空");
      }
      invocations.push({
        adapterId: round.adapterId,
        messageKind: round.messageKind,
        instruction: round.instruction,
      });
      return Promise.resolve({ id: `run_${String(invocations.length)}` });
    },
    startRun: (runId) => {
      const invocation = invocations[invocations.length - 1];
      if (!invocation) {
        throw new Error(`运行 ${runId} 没有对应调用`);
      }
      messageSequence += 1;
      const messageId = `message_${String(messageSequence)}`;
      const content = [
        `${invocation.messageKind} 正文。`,
        "",
        "```council-verdict",
        `{"stance":"${nextStance}","summary":"立场说明"}`,
        "```",
        ...(nextQuestion
          ? [
            "",
            "```council-question",
            '{"question":"按订阅还是按次？","rationale":"不可逆","options":["订阅","按次"]}',
            "```",
          ]
          : []),
      ].join("\n");
      seed.prepare(`
        INSERT INTO messages (
          id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
          kind, content, parent_message_id, created_at
        )
        SELECT ?, ?, id, ${ACTOR_SNAPSHOT_SQL}, NULL, ?, ?, NULL, ?
        FROM actor_identities WHERE id = ?
      `).run(
        messageId,
        TOPIC,
        invocation.messageKind,
        content,
        NOW,
        invocation.adapterId,
      );
      commitCycleTurn(seed, {
        topicId: TOPIC,
        agentId: invocation.adapterId,
        messageKind: invocation.messageKind as never,
        messageId,
        actorId: invocation.adapterId,
        content,
        now: NOW,
      });
      nextQuestion = false;
      return Promise.resolve(undefined);
    },
  };

  const driver = new CycleDriver({
    store,
    runner,
    decisions: {
      recordProposedDecision: (input) => {
        decisions.push(input.synthesisMessageId);
        seed.prepare(`
          INSERT INTO decisions (
            id, topic_id, title, decision, rationale, alternatives_json, status,
            created_by_actor_id, created_by_snapshot_json, created_by_legacy,
            created_at, updated_at
          )
          SELECT ?, ?, '结论', '就这么做', '因为', '[]', 'proposed',
            id, ${ACTOR_SNAPSHOT_SQL}, NULL, ?, ?
          FROM actor_identities WHERE id = 'claude'
        `).run(`decision_${String(decisions.length)}`, TOPIC, NOW, NOW);
        return Promise.resolve({ id: `decision_${String(decisions.length)}` });
      },
    },
    now: () => NOW,
  });

  return {
    store,
    driver,
    invocations,
    decisions,
    replyWith: (stance, question = false) => {
      nextStance = stance;
      nextQuestion = question;
    },
    postHumanMessage: (content) => {
      messageSequence += 1;
      const messageId = `message_${String(messageSequence)}`;
      seed.prepare(`
        INSERT INTO messages (
          id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
          kind, content, parent_message_id, created_at
        )
        SELECT ?, ?, id, ${ACTOR_SNAPSHOT_SQL}, NULL, 'note', ?, NULL, ?
        FROM actor_identities WHERE id = 'human'
      `).run(messageId, TOPIC, content, NOW);
      return messageId;
    },
    cleanup: () => {
      store.close();
      seed.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 反复推进直到没有 active cycle 或状态不再变化。 */
async function drive(harness: Harness, maxSteps = 20): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    const before = harness.invocations.length;
    const view = await harness.driver.advance(TOPIC);
    if (!view || view.action.kind === "await_user") {
      return;
    }
    if (harness.invocations.length === before) {
      return;
    }
  }
  throw new Error("驱动器未在步数上限内停止。");
}

test("开局后自动交接：用户只点一次，提案与全体评审依次被召唤", async () => {
  const harness = await createHarness();
  try {
    await harness.driver.start(cycleStartInput());
    await drive(harness);

    assert.deepEqual(
      harness.invocations.map((item) => `${item.adapterId}/${item.messageKind}`),
      ["claude/proposal", "codex/critique", "claude/synthesis"],
      "全程无需用户再点一次",
    );
    assert.ok(
      harness.invocations[1]?.instruction.includes("默认不同意"),
      "评审拿到的必须是对抗性审查指令",
    );
    assert.equal(harness.decisions.length, 1, "收敛后应产出一条 proposed 决策");
    assert.equal(
      harness.store.readActiveDiscussionCycle(TOPIC),
      undefined,
      "结算后不应再有活动 cycle",
    );
  } finally {
    harness.cleanup();
  }
});

test("阻塞异议自动触发反驳并回到评审，不需要用户居中调度", async () => {
  const harness = await createHarness();
  try {
    // start() 已经跑完提案，所以立场要在下一次召唤之前设好。
    await harness.driver.start(cycleStartInput());
    harness.replyWith("blocking");
    await harness.driver.advance(TOPIC);
    harness.replyWith("agree");
    await drive(harness);

    assert.deepEqual(
      harness.invocations.map((item) => `${item.adapterId}/${item.messageKind}`),
      [
        "claude/proposal",
        "codex/critique",
        "claude/rebuttal",
        "codex/critique",
        "claude/synthesis",
      ],
    );
  } finally {
    harness.cleanup();
  }
});

test("Agent 提问时驱动器停住，不在未决前提上继续推进", async () => {
  const harness = await createHarness();
  try {
    harness.replyWith("agree", true);
    await harness.driver.start(cycleStartInput());
    await drive(harness);

    const view = harness.store.readActiveDiscussionCycle(TOPIC);
    assert.equal(view?.cycle.stage, "awaiting_user");
    assert.equal(view?.openQuestion?.question, "按订阅还是按次？");
    assert.equal(harness.invocations.length, 1, "提问后不得再召唤下一位");

    // 用户回答后应当接着往下走，而不是重来一遍已经说过的那一段。
    const answerId = harness.postHumanMessage("按订阅。");
    harness.store.answerBlockingQuestion({
      questionMessageId: view?.openQuestion?.questionMessageId ?? "",
      answerMessageId: answerId,
      now: NOW,
    });
    await drive(harness);
    assert.deepEqual(
      harness.invocations.map((item) => `${item.adapterId}/${item.messageKind}`),
      ["claude/proposal", "codex/critique", "claude/synthesis"],
      "恢复后接着轮到评审，提案不重来",
    );
    assert.equal(harness.decisions.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("预算用尽仍有阻塞时自动放弃，不产出没人认可的结论", async () => {
  const harness = await createHarness();
  try {
    harness.replyWith("blocking");
    await harness.driver.start(cycleStartInput(2));
    await drive(harness);

    assert.equal(harness.decisions.length, 0, "放弃路径不得写决策");
    assert.equal(harness.store.readActiveDiscussionCycle(TOPIC), undefined);
    const terminal = harness.store.readLatestDiscussionCycle(TOPIC);
    assert.equal(terminal?.cycle.stopReason, "round_budget_exhausted");
    assert.equal(terminal?.cycle.outcome?.kind, "blocking_disagreements");
    assert.ok(
      (terminal?.cycle.outcome?.items.length ?? 0) > 0,
      "预算耗尽必须原子保留仍未解决的 blocking 发言",
    );
    assert.ok(
      harness.invocations.every((item) => item.messageKind !== "synthesis"),
      "放弃路径不得进入 synthesis",
    );
  } finally {
    harness.cleanup();
  }
});
