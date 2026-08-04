/**
 * @input  依赖：生产迁移器产出的真实当前版本库与 council-orchestrator 收敛仓储
 * @output 验证：开场 brief 提案复用、开局唯一性、能力快照、CAS、提问与收敛终态
 * @pos    收敛协议的持久化验收；刻意跑在真实迁移库上而不是手搭 fixture 上
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
  InvalidRunStateError,
  StoreConflictError,
  abandonDiscussionCycle,
  answerBlockingQuestion,
  completeDiscussionCycle,
  deriveCycleRequirements,
  findReusableProposalMessage,
  openBlockingQuestion,
  readActiveDiscussionCycle,
  readLatestDiscussionCycle,
  recordCycleTurn,
  startDiscussionCycle,
  type DiscussionCycleView,
  type RecordedTurn,
} from "council-orchestrator";
import { ACTOR_SNAPSHOT_SCHEMA_VERSION } from "../src/actor-identity.js";
import { migrateCouncilSchema } from "../src/schema-migrator.js";

const NOW = "2026-01-01T00:00:00.000Z";
const TOPIC = "topic_cycle";
const PARTICIPANTS = ["claude", "codex"] as const;

const ACTOR_SNAPSHOT_SQL = `
  json_object(
    'schemaVersion', ${String(ACTOR_SNAPSHOT_SCHEMA_VERSION)},
    'actorId', id, 'slug', slug, 'displayName', display_name,
    'shortName', short_name, 'role', role
  )
`;

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "council-cycle-"));
  return {
    databasePath: path.join(directory, "council.sqlite3"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function openSeeded(databasePath: string): Promise<DatabaseSync> {
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    INSERT INTO topics (
      id, title, question, constraints_json, project_path, status,
      created_by_actor_id, created_by_snapshot_json, created_by_legacy,
      created_at, updated_at
    )
    SELECT
      '${TOPIC}', '圆桌', '要不要做', '[]', NULL, 'open',
      id, ${ACTOR_SNAPSHOT_SQL}, NULL, '${NOW}', '${NOW}'
    FROM actor_identities WHERE id = 'human';
  `);
  return database;
}

/** 写一条公开消息作为发言/提问/回答的锚点，返回消息 id。 */
function postMessage(
  database: DatabaseSync,
  input: { id: string; actorId: string; kind: string; content?: string },
): string {
  database.prepare(`
    INSERT INTO messages (
      id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
      kind, content, parent_message_id, created_at
    )
    SELECT ?, ?, id, ${ACTOR_SNAPSHOT_SQL}, NULL, ?, ?, NULL, ?
    FROM actor_identities WHERE id = ?
  `).run(input.id, TOPIC, input.kind, input.content ?? "正文", NOW, input.actorId);
  return input.id;
}

test("提案人创建议题时的开场 brief 可冻结为提案并直接进入首位评审", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    database.prepare(`
      UPDATE topics
      SET created_by_actor_id = 'claude',
          created_by_snapshot_json = (
            SELECT ${ACTOR_SNAPSHOT_SQL} FROM actor_identities WHERE id = 'claude'
          )
      WHERE id = ?
    `).run(TOPIC);
    const messageId = postMessage(database, {
      id: "message_existing_brief",
      actorId: "claude",
      kind: "brief",
      content: "已有完整提案与验证证据。",
    });
    const reusable = findReusableProposalMessage(database, TOPIC, "claude");
    assert.equal(reusable?.messageId, messageId);

    const opened = startDiscussionCycle(database, {
      topicId: TOPIC,
      participants: PARTICIPANTS,
      kind: "discussion",
      requirements: deriveCycleRequirements({
        kind: "discussion",
        participants: PARTICIPANTS,
      }),
      runtimeCapabilities: PARTICIPANTS.map((adapterId) => ({
        schemaVersion: 1,
        adapterId,
        actorId: adapterId,
        agentConfigRevision: 1,
        providerId: `provider-${adapterId}`,
        providerConfigRevision: 1,
        bindingRevision: `test:${adapterId}`,
        transportKind: "test",
        declared: ["text"],
        granted: ["text"],
      })),
      roundBudget: 3,
      seedProposalMessageId: messageId,
      now: NOW,
    });

    assert.equal(opened.cycle.stage, "critique");
    assert.deepEqual(opened.cycle.turns, [{
      agentId: "claude",
      stage: "proposal",
      round: 1,
      stance: "agree",
      messageId,
    }]);
    assert.deepEqual(opened.action, {
      kind: "invoke",
      agentId: "codex",
      stage: "critique",
      messageKind: "critique",
      round: 1,
    });
  } finally {
    database.close();
    fixture.cleanup();
  }
});

function start(database: DatabaseSync, roundBudget = 3): DiscussionCycleView {
  return startDiscussionCycle(database, {
    topicId: TOPIC,
    participants: PARTICIPANTS,
    kind: "discussion",
    requirements: deriveCycleRequirements({
      kind: "discussion",
      participants: PARTICIPANTS,
    }),
    runtimeCapabilities: PARTICIPANTS.map((adapterId) => ({
      schemaVersion: 1,
      adapterId,
      actorId: adapterId,
      agentConfigRevision: 1,
      providerId: `provider-${adapterId}`,
      providerConfigRevision: 1,
      bindingRevision: `test:${adapterId}`,
      transportKind: "test",
      declared: ["text"],
      granted: ["text"],
    })),
    roundBudget,
    now: NOW,
  });
}

/** 按状态机指示走一步：发消息、记发言，返回新的视图。 */
function takeTurn(
  database: DatabaseSync,
  current: DiscussionCycleView,
  stance: RecordedTurn["stance"],
  messageId: string,
): DiscussionCycleView {
  assert.equal(current.action.kind, "invoke", "当前状态应当有可召唤的 Agent");
  if (current.action.kind !== "invoke") {
    throw new Error("unreachable");
  }
  postMessage(database, {
    id: messageId,
    actorId: current.action.agentId,
    kind: current.action.messageKind,
  });
  return recordCycleTurn(database, {
    cycleId: current.cycle.id,
    expectedVersion: current.cycle.stateVersion,
    turn: {
      agentId: current.action.agentId,
      stage: current.action.stage,
      round: current.action.round,
      stance,
      messageId,
    },
    now: NOW,
  });
}

test("开局后同议题不能再开第二个 cycle，已决议题根本不能开局", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    const opened = start(database);
    assert.equal(opened.cycle.stage, "proposal");
    assert.deepEqual(opened.action, {
      kind: "invoke",
      agentId: "claude",
      stage: "proposal",
      messageKind: "proposal",
      round: 1,
    });
    assert.throws(() => start(database), StoreConflictError);

    database.prepare(`UPDATE topics SET status = 'decided' WHERE id = ?`).run(TOPIC);
    abandonDiscussionCycle(database, {
      cycleId: opened.cycle.id,
      expectedVersion: opened.cycle.stateVersion,
      reason: "cancelled",
      now: NOW,
    });
    assert.throws(() => start(database), InvalidRunStateError);
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("Cycle 类型与 Runtime 能力快照在数据库重开后保持不变", async () => {
  const fixture = temporaryDatabase();
  let database = await openSeeded(fixture.databasePath);
  try {
    const opened = start(database);
    database.close();

    database = new DatabaseSync(fixture.databasePath);
    database.exec("PRAGMA foreign_keys = ON;");
    const reopened = readLatestDiscussionCycle(database, TOPIC);
    assert.equal(reopened?.cycle.id, opened.cycle.id);
    assert.equal(reopened?.cycle.kind, "discussion");
    assert.deepEqual(reopened?.cycle.requirements, opened.cycle.requirements);
    assert.deepEqual(reopened?.cycle.runtimeCapabilities, opened.cycle.runtimeCapabilities);
    assert.deepEqual(reopened?.action, opened.action);
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("全体同意时一路推进到 synthesis，并以 proposed 决策收敛", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    let current = start(database);
    current = takeTurn(database, current, "agree", "message_1");
    assert.equal(current.cycle.stage, "critique");
    current = takeTurn(database, current, "agree", "message_2");
    assert.equal(current.cycle.stage, "synthesis", "评审放行后应直接进入收敛");
    current = takeTurn(database, current, "agree", "message_3");
    assert.deepEqual(current.action, { kind: "done" });

    database.prepare(`
      INSERT INTO decisions (
        id, topic_id, title, decision, rationale, alternatives_json, status,
        created_by_actor_id, created_by_snapshot_json, created_by_legacy,
        created_at, updated_at
      )
      SELECT 'decision_1', ?, '结论', '就这么做', '因为', '[]', 'proposed',
        id, ${ACTOR_SNAPSHOT_SQL}, NULL, ?, ?
      FROM actor_identities WHERE id = 'claude'
    `).run(TOPIC, NOW, NOW);
    const completed = completeDiscussionCycle(database, {
      cycleId: current.cycle.id,
      expectedVersion: current.cycle.stateVersion,
      proposedDecisionId: "decision_1",
      now: NOW,
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.stopReason, "converged");
    assert.equal(completed.proposedDecisionId, "decision_1");
    assert.equal(readActiveDiscussionCycle(database, TOPIC), undefined);
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("阻塞异议进入反驳并回到评审，预算用尽时放弃且不留未答问题", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    let current = start(database, 2);
    current = takeTurn(database, current, "agree", "message_1");
    current = takeTurn(database, current, "blocking", "message_2");
    assert.equal(current.cycle.stage, "rebuttal");
    current = takeTurn(database, current, "agree", "message_3");
    assert.equal(current.cycle.stage, "critique");
    assert.equal(current.cycle.currentRound, 2, "反驳后必须由评审再看一轮");

    current = takeTurn(database, current, "blocking", "message_4");
    assert.equal(current.cycle.stage, "rebuttal");
    current = takeTurn(database, current, "agree", "message_5");
    assert.deepEqual(current.action, {
      kind: "abandon",
      reason: "round_budget_exhausted",
    });

    const abandoned = abandonDiscussionCycle(database, {
      cycleId: current.cycle.id,
      expectedVersion: current.cycle.stateVersion,
      reason: "round_budget_exhausted",
      now: NOW,
    });
    assert.equal(abandoned.status, "abandoned");
    assert.equal(abandoned.proposedDecisionId, undefined, "放弃不得产出结论");
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("提问挂起后重放同一条提问消息幂等，回答后回到冻结的回归阶段", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    let current = start(database);
    current = takeTurn(database, current, "agree", "message_1");
    const askedAt = current.cycle.stage;
    assert.equal(askedAt, "critique");

    postMessage(database, { id: "message_q", actorId: "codex", kind: "note" });
    current = openBlockingQuestion(database, {
      cycleId: current.cycle.id,
      expectedVersion: current.cycle.stateVersion,
      askedByActorId: "codex",
      askedAtStage: "critique",
      question: {
        question: "定价按订阅还是按次？",
        rationale: "两条路径不可逆",
        options: ["订阅", "按次"],
      },
      questionMessageId: "message_q",
      now: NOW,
    });
    assert.equal(current.cycle.stage, "awaiting_user");
    assert.equal(current.cycle.resumeStage, "critique");
    assert.deepEqual(current.action, { kind: "await_user" });

    // 取消/重启后重放：拿回同一张单子，而不是把用户再问一遍。
    const replayed = openBlockingQuestion(database, {
      cycleId: current.cycle.id,
      expectedVersion: current.cycle.stateVersion,
      askedByActorId: "codex",
      askedAtStage: "critique",
      question: { question: "重放", rationale: "重放", options: [] },
      questionMessageId: "message_q",
      now: NOW,
    });
    assert.equal(replayed.openQuestion?.id, current.openQuestion?.id);
    assert.equal(replayed.cycle.stateVersion, current.cycle.stateVersion);

    postMessage(database, { id: "message_a", actorId: "human", kind: "note" });
    const answered = answerBlockingQuestion(database, {
      questionMessageId: "message_q",
      answerMessageId: "message_a",
      now: NOW,
    });
    assert.equal(answered.cycle.stage, "critique");
    assert.equal(answered.cycle.resumeStage, undefined);
    assert.equal(answered.openQuestion, undefined);
    assert.deepEqual(answered.action, {
      kind: "invoke",
      agentId: "codex",
      stage: "critique",
      messageKind: "critique",
      round: 1,
    }, "恢复后应接着轮到尚未发言的评审");

    // 回答的重放同样必须幂等。
    const answeredAgain = answerBlockingQuestion(database, {
      questionMessageId: "message_q",
      answerMessageId: "message_a",
      now: NOW,
    });
    assert.equal(answeredAgain.cycle.stateVersion, answered.cycle.stateVersion);
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("过期版本的推进被拒绝，重放同一条发言消息不会记两次", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    const opened = start(database);
    const advanced = takeTurn(database, opened, "agree", "message_1");
    assert.ok(advanced.cycle.stateVersion > opened.cycle.stateVersion);

    assert.throws(
      () => recordCycleTurn(database, {
        cycleId: opened.cycle.id,
        expectedVersion: opened.cycle.stateVersion,
        turn: {
          agentId: "codex",
          stage: "critique",
          round: 1,
          stance: "agree",
          messageId: "message_2",
        },
        now: NOW,
      }),
      StoreConflictError,
      "拿着旧版本推进必须失败，而不是覆盖别人的进度",
    );

    const replayed = recordCycleTurn(database, {
      cycleId: advanced.cycle.id,
      expectedVersion: advanced.cycle.stateVersion,
      turn: {
        agentId: "claude",
        stage: "proposal",
        round: 1,
        stance: "agree",
        messageId: "message_1",
      },
      now: NOW,
    });
    assert.equal(replayed.cycle.turns.length, 1);
    assert.equal(replayed.cycle.stateVersion, advanced.cycle.stateVersion);
  } finally {
    database.close();
    fixture.cleanup();
  }
});
