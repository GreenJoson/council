/**
 * @input  依赖：canonical v12 决策、RuntimeBinding 与 DiscussionCycle 触发器
 * @output 导出：migrateVersionThirteen 与 v12 迁移源验证
 * @pos    v12→v13 决策包状态机迁移：仅在最后一条拟议决策完成接受后关闭议题运行时
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";

interface NameRow {
  name: unknown;
}

const REQUIRED_SOURCE_TRIGGERS = [
  "trg_decisions_runtime_close_insert",
  "trg_decisions_runtime_close_update",
  "trg_decisions_cycle_close_insert",
  "trg_decisions_cycle_close_update",
] as const;

export function assertVersionTwelveMigrationSource(database: DatabaseSync): void {
  for (const name of REQUIRED_SOURCE_TRIGGERS) {
    const row = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `).get(name) as unknown as NameRow | undefined;
    if (row?.name !== name) {
      throw new Error(`Council v12 数据库缺少决策状态触发器 ${name}。`);
    }
  }
}

/**
 * 一个议题可以包含多条独立的拟议决策。接受其中一条只改变该条状态；只有当前议题
 * 已经没有 proposed 决策时，才关闭持久会话与讨论周期。批量接受在同一事务里逐条
 * 更新，最后一条更新自然成为唯一触发关闭边界的状态转换。
 */
export function migrateVersionThirteen(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionTwelveMigrationSource(database);
  database.exec(`
    DROP TRIGGER trg_decisions_runtime_close_insert;
    DROP TRIGGER trg_decisions_runtime_close_update;
    DROP TRIGGER trg_decisions_cycle_close_insert;
    DROP TRIGGER trg_decisions_cycle_close_update;

    CREATE TRIGGER trg_decisions_runtime_close_insert
      AFTER INSERT ON decisions
      WHEN NEW.status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM decisions
          WHERE topic_id = NEW.topic_id AND status = 'proposed'
        )
      BEGIN
        UPDATE runtime_bindings
        SET status = 'closing',
            state_version = state_version + 1,
            epoch = epoch + 1,
            close_reason = 'decision-accepted',
            updated_at = NEW.updated_at,
            last_activity_at = NEW.updated_at
        WHERE topic_id = NEW.topic_id
          AND status NOT IN ('closing', 'closed');
        DELETE FROM runtime_binding_leases
        WHERE binding_id IN (
          SELECT id FROM runtime_bindings
          WHERE topic_id = NEW.topic_id AND status = 'closing'
        );
      END;

    CREATE TRIGGER trg_decisions_runtime_close_update
      AFTER UPDATE OF status ON decisions
      WHEN OLD.status <> 'accepted'
        AND NEW.status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM decisions
          WHERE topic_id = NEW.topic_id AND status = 'proposed'
        )
      BEGIN
        UPDATE runtime_bindings
        SET status = 'closing',
            state_version = state_version + 1,
            epoch = epoch + 1,
            close_reason = 'decision-accepted',
            updated_at = NEW.updated_at,
            last_activity_at = NEW.updated_at
        WHERE topic_id = NEW.topic_id
          AND status NOT IN ('closing', 'closed');
        DELETE FROM runtime_binding_leases
        WHERE binding_id IN (
          SELECT id FROM runtime_bindings
          WHERE topic_id = NEW.topic_id AND status = 'closing'
        );
      END;

    CREATE TRIGGER trg_decisions_cycle_close_insert
      AFTER INSERT ON decisions
      WHEN NEW.status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM decisions
          WHERE topic_id = NEW.topic_id AND status = 'proposed'
        )
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
      WHEN OLD.status <> 'accepted'
        AND NEW.status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM decisions
          WHERE topic_id = NEW.topic_id AND status = 'proposed'
        )
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
    `).run(13, "decision-package-acceptance", now);
    database.exec("PRAGMA user_version = 13;");
  }
}
