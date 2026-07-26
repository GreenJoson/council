/**
 * @input  依赖：canonical v7 DiscussionCycle 与 Runtime 能力快照纯契约
 * @output 导出：migrateVersionEight 与 v7 迁移源验证
 * @pos    v7→v8 原子增加 cycle 类型、需求快照和 Runtime 能力快照
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import {
  deriveCycleRequirements,
  type RuntimeCapabilitySnapshot,
} from "council-orchestrator";

interface ColumnRow {
  name: unknown;
}

interface CycleRow {
  id: unknown;
  participants_json: unknown;
}

function columnNames(database: DatabaseSync): Set<string> {
  return new Set(
    (database.prepare("PRAGMA table_info(discussion_cycles)").all() as unknown as ColumnRow[])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function participantsOf(row: CycleRow): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.participants_json)) as unknown;
  } catch {
    throw new Error("Council v7 cycle 名册不是有效 JSON。");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error("Council v7 cycle 名册无效。");
  }
  return parsed;
}

export function assertVersionSevenMigrationSource(database: DatabaseSync): void {
  const columns = columnNames(database);
  if (!columns.has("participants_json") || !columns.has("turns_json")) {
    throw new Error("Council v7 数据库缺少 DiscussionCycle 核心字段。");
  }
  for (const premature of [
    "cycle_kind",
    "requirements_json",
    "capability_snapshot_json",
    "outcome_json",
  ]) {
    if (columns.has(premature)) {
      throw new Error(`Council v7 数据库包含提前出现的字段：${premature}。`);
    }
  }
}

export function migrateVersionEight(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionSevenMigrationSource(database);
  database.exec(`
    ALTER TABLE discussion_cycles
      ADD COLUMN cycle_kind TEXT NOT NULL DEFAULT 'discussion'
      CHECK (cycle_kind IN ('discussion', 'fix_review'));
    ALTER TABLE discussion_cycles
      ADD COLUMN requirements_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(requirements_json) AND json_type(requirements_json) = 'object');
    ALTER TABLE discussion_cycles
      ADD COLUMN capability_snapshot_json TEXT NOT NULL DEFAULT '[]'
      CHECK (
        json_valid(capability_snapshot_json)
        AND json_type(capability_snapshot_json) = 'array'
      );
    ALTER TABLE discussion_cycles
      ADD COLUMN outcome_json TEXT
      CHECK (
        outcome_json IS NULL
        OR (json_valid(outcome_json) AND json_type(outcome_json) = 'object')
      );
  `);

  const update = database.prepare(`
    UPDATE discussion_cycles
    SET requirements_json = ?, capability_snapshot_json = ?
    WHERE id = ?
  `);
  const rows = database.prepare(`
    SELECT id, participants_json FROM discussion_cycles
  `).all() as unknown as CycleRow[];
  for (const row of rows) {
    if (typeof row.id !== "string" || !row.id) {
      throw new Error("Council v7 cycle id 无效。");
    }
    const participants = participantsOf(row);
    const requirements = deriveCycleRequirements({
      kind: "discussion",
      participants,
    });
    const snapshots: RuntimeCapabilitySnapshot[] = participants.map((adapterId) => ({
      schemaVersion: 1,
      adapterId,
      actorId: adapterId,
      agentConfigRevision: 0,
      providerId: "legacy-v7",
      providerConfigRevision: 0,
      bindingRevision: "legacy-v7",
      transportKind: "legacy-unknown",
      declared: ["text"],
      granted: ["text"],
    }));
    update.run(
      JSON.stringify(requirements),
      JSON.stringify(snapshots),
      row.id,
    );
  }
  database.exec(`
    UPDATE discussion_cycles
    SET stop_reason = 'decision_accepted'
    WHERE stop_reason = 'decision-accepted';

    DROP TRIGGER trg_decisions_cycle_close_insert;
    DROP TRIGGER trg_decisions_cycle_close_update;

    CREATE TRIGGER trg_decisions_cycle_close_insert
      AFTER INSERT ON decisions
      WHEN NEW.status = 'accepted'
      BEGIN
        UPDATE blocking_questions
        SET status = 'withdrawn',
            resolved_at = NEW.updated_at,
            updated_at = NEW.updated_at
        WHERE status = 'open'
          AND cycle_id IN (
            SELECT id FROM discussion_cycles
            WHERE topic_id = NEW.topic_id AND status = 'active'
          );
        UPDATE discussion_cycles
        SET status = 'completed',
            stage = 'completed',
            resume_stage = NULL,
            proposed_decision_id = NEW.id,
            state_version = state_version + 1,
            epoch = epoch + 1,
            stop_reason = 'decision_accepted',
            updated_at = NEW.updated_at,
            completed_at = NEW.updated_at
        WHERE topic_id = NEW.topic_id AND status = 'active';
      END;

    CREATE TRIGGER trg_decisions_cycle_close_update
      AFTER UPDATE OF status ON decisions
      WHEN OLD.status <> 'accepted' AND NEW.status = 'accepted'
      BEGIN
        UPDATE blocking_questions
        SET status = 'withdrawn',
            resolved_at = NEW.updated_at,
            updated_at = NEW.updated_at
        WHERE status = 'open'
          AND cycle_id IN (
            SELECT id FROM discussion_cycles
            WHERE topic_id = NEW.topic_id AND status = 'active'
          );
        UPDATE discussion_cycles
        SET status = 'completed',
            stage = 'completed',
            resume_stage = NULL,
            proposed_decision_id = NEW.id,
            state_version = state_version + 1,
            epoch = epoch + 1,
            stop_reason = 'decision_accepted',
            updated_at = NEW.updated_at,
            completed_at = NEW.updated_at
        WHERE topic_id = NEW.topic_id AND status = 'active';
      END;
  `);

  if (recordVersion) {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(8, "cycle-runtime-capabilities", now);
    database.exec("PRAGMA user_version = 8;");
  }
}
