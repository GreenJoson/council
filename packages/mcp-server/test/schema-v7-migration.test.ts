/**
 * @input  依赖：临时 SQLite、生产迁移入口与 v7 圆桌收敛 DDL
 * @output 验证：DiscussionCycle / BlockingQuestion 的并发唯一性、状态不变量与 revision
 * @pos    v7 持久化模型的安全主验收；状态机行为由编排层测试另行覆盖
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ACTOR_SNAPSHOT_SCHEMA_VERSION } from "../src/actor-identity.js";
import { migrateCouncilSchema } from "../src/schema-migrator.js";

const NOW = "2026-01-01T00:00:00.000Z";

interface CountRow {
  count: number;
}

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "council-schema-v7-"));
  return {
    databasePath: path.join(directory, "council.sqlite3"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** 冻结快照按 actor 当前行现算，避免测试写死一份会漂移的字面量。 */
const ACTOR_SNAPSHOT_SQL = `
  json_object(
    'schemaVersion', ${String(ACTOR_SNAPSHOT_SCHEMA_VERSION)},
    'actorId', id, 'slug', slug, 'displayName', display_name,
    'shortName', short_name, 'role', role
  )
`;

/** 迁移到当前版本并写入一个议题 / 两条消息 / 一个 proposed 决策作为外键锚点。 */
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
      'topic_v7', '圆桌', '要不要做', '[]', NULL, 'open',
      id, ${ACTOR_SNAPSHOT_SQL}, NULL, '${NOW}', '${NOW}'
    FROM actor_identities WHERE id = 'human';

    INSERT INTO messages (
      id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
      kind, content, parent_message_id, created_at
    )
    SELECT
      'message_q', 'topic_v7', id, ${ACTOR_SNAPSHOT_SQL}, NULL,
      'note', '这个取舍我判断不了', NULL, '${NOW}'
    FROM actor_identities WHERE id = 'claude';

    INSERT INTO messages (
      id, topic_id, author_actor_id, author_snapshot_json, author_legacy,
      kind, content, parent_message_id, created_at
    )
    SELECT
      'message_a', 'topic_v7', id, ${ACTOR_SNAPSHOT_SQL}, NULL,
      'note', '选 B', 'message_q', '${NOW}'
    FROM actor_identities WHERE id = 'human';

    INSERT INTO decisions (
      id, topic_id, title, decision, rationale, alternatives_json, status,
      created_by_actor_id, created_by_snapshot_json, created_by_legacy,
      created_at, updated_at
    )
    SELECT
      'decision_v7', 'topic_v7', '结论', '就这么做', '因为', '[]', 'proposed',
      id, ${ACTOR_SNAPSHOT_SQL}, NULL, '${NOW}', '${NOW}'
    FROM actor_identities WHERE id = 'claude';
  `);
  return database;
}

function insertRow(
  database: DatabaseSync,
  table: string,
  row: Readonly<Record<string, unknown>>,
): void {
  const columns = Object.keys(row);
  database.prepare(`
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => row[column] as never));
}

function insertCycle(
  database: DatabaseSync,
  overrides: Readonly<Record<string, unknown>> = {},
): void {
  const row: Record<string, unknown> = {
    id: "cycle_1",
    topic_id: "topic_v7",
    stage: "proposal",
    status: "active",
    round_budget: 3,
    current_round: 1,
    resume_stage: null,
    context_cursor_message_id: null,
    context_cursor_created_at: null,
    proposed_decision_id: null,
    state_version: 1,
    epoch: 0,
    stop_reason: null,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  };
  insertRow(database, "discussion_cycles", row);
}

function insertQuestion(
  database: DatabaseSync,
  overrides: Readonly<Record<string, unknown>> = {},
): void {
  const row: Record<string, unknown> = {
    id: "question_1",
    cycle_id: "cycle_1",
    asked_by_actor_id: "claude",
    asked_at_stage: "critique",
    question: "定价按订阅还是按次？",
    rationale: "两条实现路径不可逆，选错要重写存储层",
    options_json: '["订阅","按次"]',
    status: "open",
    question_message_id: "message_q",
    answer_message_id: null,
    created_at: NOW,
    updated_at: NOW,
    resolved_at: null,
    ...overrides,
  };
  insertRow(database, "blocking_questions", row);
}

test("v7 一个议题同时只允许一个 active cycle，议题分裂在存储层就被挡住", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    insertCycle(database);
    assert.throws(
      () => { insertCycle(database, { id: "cycle_2" }); },
      /UNIQUE/iu,
    );

    // 同一议题的历史 cycle 可以任意多个，只有 active 是互斥的。
    database.prepare(`
      UPDATE discussion_cycles
      SET status = 'abandoned', stop_reason = 'round_budget_exhausted',
        completed_at = ?
      WHERE id = 'cycle_1'
    `).run(NOW);
    insertCycle(database, { id: "cycle_2" });
    const active = database.prepare(`
      SELECT COUNT(*) AS count FROM discussion_cycles WHERE status = 'active'
    `).get() as unknown as CountRow;
    assert.equal(active.count, 1);
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("v7 cycle 终态不变量：预算上限、completed_at 与 proposed 决策都不可省略", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    assert.throws(
      () => { insertCycle(database, { current_round: 4, round_budget: 3 }); },
      /CHECK/iu,
      "轮次预算是硬停止条件，超出必须写不进去",
    );
    assert.throws(
      () => { insertCycle(database, { status: "completed" }); },
      /CHECK/iu,
      "终态必须带 completed_at",
    );
    assert.throws(
      () => {
        insertCycle(database, {
          status: "completed",
          stage: "completed",
          completed_at: NOW,
        });
      },
      /CHECK/iu,
      "收敛成功必须产出 proposed Decision，否则只能是 abandoned",
    );
    insertCycle(database, {
      status: "completed",
      stage: "completed",
      completed_at: NOW,
      proposed_decision_id: "decision_v7",
    });
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("v7 awaiting_user 与 resume_stage 双向绑定，提问不会丢失回归点", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    assert.throws(
      () => { insertCycle(database, { stage: "awaiting_user" }); },
      /CHECK/iu,
      "挂起提问却不记录回归阶段，用户答完就无处可回",
    );
    assert.throws(
      () => { insertCycle(database, { stage: "critique", resume_stage: "critique" }); },
      /CHECK/iu,
      "没挂起却带回归点，说明状态机写错了",
    );
    insertCycle(database, { stage: "awaiting_user", resume_stage: "critique" });
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("v7 每个 cycle 最多一个未答问题，同一条提问消息不能重复建单", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    insertCycle(database, { stage: "awaiting_user", resume_stage: "critique" });
    insertQuestion(database);

    assert.throws(
      () => { insertQuestion(database, { id: "question_2" }); },
      /UNIQUE/iu,
      "同时挂两个问题，用户就不知道该先答哪个",
    );

    // 取消/重启后重放同一条提问消息：唯一约束让恢复天然幂等。
    assert.throws(
      () => {
        insertQuestion(database, {
          id: "question_3",
          status: "withdrawn",
          resolved_at: NOW,
        });
      },
      /UNIQUE/iu,
    );

    assert.throws(
      () => {
        database.prepare(`
          UPDATE blocking_questions SET status = 'answered', resolved_at = ?
          WHERE id = 'question_1'
        `).run(NOW);
      },
      /CHECK/iu,
      "已答必须指向公开回答消息，口头答复不算",
    );

    database.prepare(`
      UPDATE blocking_questions
      SET status = 'answered', answer_message_id = 'message_a',
        resolved_at = ?, updated_at = ?
      WHERE id = 'question_1'
    `).run(NOW, NOW);
    insertQuestion(database, { id: "question_4", question_message_id: "message_a" });
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("v7 accepted 决策同时终结 cycle 与未答问题，自动交接不会在已决议题上继续", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    insertCycle(database, { stage: "awaiting_user", resume_stage: "critique" });
    insertQuestion(database);

    database.prepare(`
      UPDATE decisions SET status = 'accepted', updated_at = ? WHERE id = 'decision_v7'
    `).run("2026-01-02T00:00:00.000Z");

    const cycle = database.prepare(`
      SELECT status, stage, resume_stage, proposed_decision_id, stop_reason,
        completed_at, epoch
      FROM discussion_cycles WHERE id = 'cycle_1'
    `).get() as unknown as Record<string, unknown>;
    assert.equal(cycle.status, "completed");
    assert.equal(cycle.stage, "completed");
    assert.equal(cycle.resume_stage, null);
    assert.equal(cycle.proposed_decision_id, "decision_v7");
    assert.equal(cycle.stop_reason, "decision-accepted");
    assert.equal(cycle.completed_at, "2026-01-02T00:00:00.000Z");
    assert.equal(cycle.epoch, 1);

    const question = database.prepare(`
      SELECT status, resolved_at FROM blocking_questions WHERE id = 'question_1'
    `).get() as unknown as Record<string, unknown>;
    assert.equal(question.status, "withdrawn");
    assert.equal(question.resolved_at, "2026-01-02T00:00:00.000Z");
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("v7 未答问题锚定的公开消息不可单独删除，提问记录不会被悄悄抹掉", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    insertCycle(database, { stage: "awaiting_user", resume_stage: "critique" });
    insertQuestion(database);
    assert.throws(
      () => {
        database.prepare("DELETE FROM messages WHERE id = 'message_q'").run();
      },
      /FOREIGN KEY/iu,
    );
  } finally {
    database.close();
    fixture.cleanup();
  }
});

test("v7 收敛状态写入会推进 revision，并随议题级联清理", async () => {
  const fixture = temporaryDatabase();
  const database = await openSeeded(fixture.databasePath);
  try {
    const readRevision = (key: string): number => {
      const row = database
        .prepare("SELECT value AS count FROM council_meta WHERE key = ?")
        .get(key) as unknown as CountRow;
      return row.count;
    };
    const before = {
      revision: readRevision("revision"),
      orchestration: readRevision("orchestration_revision"),
    };
    insertCycle(database, { stage: "awaiting_user", resume_stage: "critique" });
    insertQuestion(database);
    assert.ok(readRevision("revision") > before.revision);
    assert.ok(readRevision("orchestration_revision") > before.orchestration);

    database.prepare("DELETE FROM topics WHERE id = 'topic_v7'").run();
    const remaining = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM discussion_cycles)
        + (SELECT COUNT(*) FROM blocking_questions) AS count
    `).get() as unknown as CountRow;
    assert.equal(remaining.count, 0);
  } finally {
    database.close();
    fixture.cleanup();
  }
});
