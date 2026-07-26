/**
 * @input  依赖：最小 canonical v7 DiscussionCycle fixture 与 v8 单步迁移
 * @output 验证：旧 cycle 能力 backfill、停止原因规范化和 accepted trigger 修复
 * @pos    v7→v8 数据级回归；不依赖 fresh DB 重放掩盖现场旧库问题
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  decodeDiscussionCycle,
  type DiscussionCycleRow,
} from "council-orchestrator";
import { migrateVersionEight } from "../src/schema-v8-migration.js";

function openVersionSevenFixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations VALUES (7, 'discussion-cycle', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 7;

    CREATE TABLE discussion_cycles (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      participants_json TEXT NOT NULL,
      turns_json TEXT NOT NULL,
      round_budget INTEGER NOT NULL,
      current_round INTEGER NOT NULL,
      resume_stage TEXT,
      context_cursor_message_id TEXT,
      context_cursor_created_at TEXT,
      proposed_decision_id TEXT,
      state_version INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      stop_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE blocking_questions (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER trg_decisions_cycle_close_insert
      AFTER INSERT ON decisions BEGIN SELECT 1; END;
    CREATE TRIGGER trg_decisions_cycle_close_update
      AFTER UPDATE OF status ON decisions BEGIN SELECT 1; END;

    INSERT INTO discussion_cycles VALUES (
      'cycle_legacy', 'topic_legacy', 'completed', 'abandoned',
      '["claude","kimi"]', '[]', 3, 1, NULL, NULL, NULL, NULL,
      2, 1, 'decision-accepted',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO discussion_cycles VALUES (
      'cycle_active', 'topic_active', 'critique', 'active',
      '["claude","codex"]', '[]', 3, 1, NULL, NULL, NULL, NULL,
      1, 0, NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    );
    INSERT INTO blocking_questions VALUES (
      'question_active', 'cycle_active', 'open', NULL,
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO decisions VALUES (
      'decision_active', 'topic_active', 'proposed',
      '2026-01-01T00:00:00.000Z'
    );
  `);
  return database;
}

test("v8 单步迁移为旧 cycle 生成可读快照并修正 accepted 终止语义", () => {
  const database = openVersionSevenFixture();
  try {
    database.exec("BEGIN;");
    migrateVersionEight(database);
    database.exec("COMMIT;");

    const legacy = database.prepare(`
      SELECT cycle_kind, requirements_json, capability_snapshot_json, stop_reason
      FROM discussion_cycles WHERE id = 'cycle_legacy'
    `).get() as unknown as Record<string, unknown>;
    assert.equal(legacy.cycle_kind, "discussion");
    assert.equal(legacy.stop_reason, "decision_accepted");
    assert.deepEqual(
      JSON.parse(String(legacy.requirements_json)).byParticipant,
      { claude: ["text"], kimi: ["text"] },
    );
    const snapshots = JSON.parse(String(legacy.capability_snapshot_json)) as Array<{
      adapterId: string;
      providerId: string;
      granted: string[];
    }>;
    assert.deepEqual(
      snapshots.map((snapshot) => ({
        adapterId: snapshot.adapterId,
        providerId: snapshot.providerId,
        granted: snapshot.granted,
      })),
      [
        { adapterId: "claude", providerId: "legacy-v7", granted: ["text"] },
        { adapterId: "kimi", providerId: "legacy-v7", granted: ["text"] },
      ],
    );
    const decodedLegacy = decodeDiscussionCycle(
      database.prepare(`
        SELECT * FROM discussion_cycles WHERE id = 'cycle_legacy'
      `).get() as unknown as DiscussionCycleRow,
    );
    assert.equal(decodedLegacy.kind, "discussion");
    assert.deepEqual(decodedLegacy.runtimeCapabilities, snapshots);

    database.prepare(`
      UPDATE decisions SET status = 'accepted', updated_at = ?
      WHERE id = 'decision_active'
    `).run("2026-01-02T00:00:00.000Z");
    const active = database.prepare(`
      SELECT status, stage, proposed_decision_id, stop_reason, completed_at
      FROM discussion_cycles WHERE id = 'cycle_active'
    `).get() as unknown as Record<string, unknown>;
    assert.deepEqual({ ...active }, {
      status: "completed",
      stage: "completed",
      proposed_decision_id: "decision_active",
      stop_reason: "decision_accepted",
      completed_at: "2026-01-02T00:00:00.000Z",
    });
    const question = database.prepare(`
      SELECT status, resolved_at FROM blocking_questions
      WHERE id = 'question_active'
    `).get() as unknown as Record<string, unknown>;
    assert.deepEqual({ ...question }, {
      status: "withdrawn",
      resolved_at: "2026-01-02T00:00:00.000Z",
    });
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 8);
  } finally {
    database.close();
  }
});
