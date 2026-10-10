/**
 * @input  依赖：canonical v17 实施项、委派与运行审计
 * @output 导出：migrateVersionEighteen 与 v17 迁移源验证
 * @pos    v17→v18 任务一等化：实施项/委派/审计的 topic_id 可空，
 *         新增 kind/source/priority/project_path/brief 等任务列与项目索引
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 为什么整表重建而不是 ALTER：SQLite 不能去掉 NOT NULL，只能重建。
 * 重建顺序经实测固定：先删触发器/索引 → 把三张旧表全部改名
 * （父表改名会同步重写子表的外键文本，所以必须三张一起改）→
 * 按最终名字建新表（父表先）→ 拷贝 → 删旧表（子表先，避免级联删除新表数据）
 * → 重建索引与触发器。整个过程由 schema-migrator 的事务包裹。
 */
import type { DatabaseSync } from "node:sqlite";

interface ScalarRow {
  value: unknown;
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name?: unknown;
  }>).map((row) => String(row.name));
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as unknown as ScalarRow;
  return Number(row.value);
}

export function assertVersionSeventeenMigrationSource(database: DatabaseSync): void {
  const workItemColumns = columnNames(database, "work_items");
  if (!workItemColumns.includes("claimed_at") || workItemColumns.includes("source")) {
    throw new Error("Council v17 实施项表结构与预期不符。");
  }
  const delegationColumns = columnNames(database, "work_item_delegations");
  if (!delegationColumns.includes("execution_state_json") || delegationColumns.includes("kind")) {
    throw new Error("Council v17 委派表结构与预期不符。");
  }
  const audit = database.prepare(`
    SELECT name AS value FROM sqlite_master
    WHERE type = 'table' AND name = 'runtime_audit_events'
  `).get() as unknown as ScalarRow | undefined;
  if (audit?.value !== "runtime_audit_events") {
    throw new Error("Council v17 数据库缺少运行审计表。");
  }
}

// ---------------------------------------------------------------------------
// 新表 DDL。旧列的文本必须与 v12/v14/v16 原文逐字一致：
// 桌面核心用 sqlite_master 的 SQL 片段做漂移检查。
// ---------------------------------------------------------------------------

const WORK_ITEM_V18_TABLE_SQL = `
  CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
    decision_id TEXT REFERENCES decisions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'in_progress', 'blocked', 'completed')
    ),
    status_note TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    created_by_snapshot_json TEXT NOT NULL,
    updated_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    updated_by_snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    parent_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
    parent_key TEXT GENERATED ALWAYS AS (COALESCE(parent_id, '')) VIRTUAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'manual' CHECK (
      origin IN ('manual', 'review_finding')
    ),
    severity TEXT CHECK (
      severity IS NULL OR severity IN ('blocking', 'non_blocking')
    ),
    source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    source_cycle_id TEXT REFERENCES discussion_cycles(id) ON DELETE SET NULL,
    review_round INTEGER CHECK (review_round IS NULL OR review_round > 0),
    fix_commit TEXT,
    assignee_actor_id TEXT REFERENCES actor_identities(id),
    claimed_at TEXT,
    kind TEXT NOT NULL DEFAULT 'code' CHECK (
      kind IN ('code', 'image', 'prototype', 'research', 'pipeline')
    ),
    source TEXT NOT NULL DEFAULT 'topic' CHECK (
      source IN ('topic', 'direct', 'pipeline')
    ),
    priority INTEGER NOT NULL DEFAULT 0,
    project_path TEXT,
    brief_json TEXT CHECK (
      brief_json IS NULL OR (json_valid(brief_json) AND json_type(brief_json) = 'object')
    ),
    scope_key TEXT GENERATED ALWAYS AS (COALESCE(topic_id, project_path, '')) VIRTUAL,
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL)
      OR (status <> 'completed' AND completed_at IS NULL)
    ),
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK (origin <> 'review_finding' OR severity IS NOT NULL),
    CHECK (
      (assignee_actor_id IS NOT NULL AND claimed_at IS NOT NULL)
      OR (assignee_actor_id IS NULL AND claimed_at IS NULL)
    ),
    CHECK ((source = 'topic') = (topic_id IS NOT NULL)),
    CHECK (source = 'topic' OR project_path IS NOT NULL)
  );
`;

const WORK_ITEM_V17_COLUMNS = [
  "id", "topic_id", "decision_id", "title", "details", "status", "status_note", "version",
  "created_by_actor_id", "created_by_snapshot_json", "updated_by_actor_id", "updated_by_snapshot_json",
  "created_at", "updated_at", "completed_at", "parent_id", "sort_order", "origin", "severity",
  "source_message_id", "source_cycle_id", "review_round", "fix_commit", "assignee_actor_id", "claimed_at",
].join(", ");

const WORK_ITEM_V18_INDEX_SQL = `
  CREATE INDEX idx_work_items_topic_status
    ON work_items(topic_id, status, created_at);
  CREATE UNIQUE INDEX idx_work_items_parent_title
    ON work_items(scope_key, parent_key, title COLLATE NOCASE);
  CREATE INDEX idx_work_items_parent_order
    ON work_items(scope_key, parent_key, sort_order, created_at);
  CREATE INDEX idx_work_items_project_status
    ON work_items(project_path, status, updated_at);
`;

const WORK_ITEM_V18_TRIGGER_SQL = `
  CREATE TRIGGER trg_work_items_revision_insert
    AFTER INSERT ON work_items BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_work_items_revision_update
    AFTER UPDATE ON work_items BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_work_items_revision_delete
    AFTER DELETE ON work_items BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'content_revision';
    END;
  CREATE TRIGGER trg_work_items_delegation_acceptance
  BEFORE UPDATE OF status ON work_items
  WHEN NEW.status = 'completed' AND NOT EXISTS (
    SELECT 1 FROM work_items child WHERE child.parent_id = NEW.id
  ) AND EXISTS (
    SELECT 1 FROM work_item_delegations d
    WHERE d.rowid = (
      SELECT rowid FROM work_item_delegations WHERE work_item_id = NEW.id
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    ) AND d.completion_policy = 'human'
    AND (NEW.updated_by_actor_id <> 'human'
      OR NEW.status_note IS NULL OR length(trim(NEW.status_note)) = 0)
  ) BEGIN
    SELECT RAISE(ABORT, '实施项需要人工填写验收证据后才能完成。');
  END;
`;

const DELEGATION_V18_TABLE_SQL = `
  CREATE TABLE work_item_delegations (
    id TEXT PRIMARY KEY,
    topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    supervisor_agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
    executor_agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
    permission_profile TEXT NOT NULL CHECK (
      permission_profile IN ('workspace_write', 'danger_full_access')
    ),
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'executing', 'reviewing', 'changes_requested',
        'approved', 'failed', 'cancelled'
      )
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    base_commit TEXT,
    head_commit TEXT,
    branch_name TEXT,
    worktree_path TEXT,
    executor_session_id TEXT,
    supervisor_session_id TEXT,
    summary TEXT,
    review TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    completion_policy TEXT NOT NULL
      DEFAULT 'review' CHECK (completion_policy IN ('review', 'human')),
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    resumed_from_id TEXT
      REFERENCES work_item_delegations(id) ON DELETE SET NULL,
    failure_code TEXT,
    execution_state_json TEXT
      CHECK (execution_state_json IS NULL OR (json_valid(execution_state_json) AND json_type(execution_state_json) = 'object')),
    kind TEXT NOT NULL DEFAULT 'code' CHECK (
      kind IN ('code', 'image', 'prototype', 'research', 'pipeline')
    ),
    input_asset_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
      json_valid(input_asset_ids_json) AND json_type(input_asset_ids_json) = 'array'
    ),
    output_manifest_json TEXT CHECK (
      output_manifest_json IS NULL
      OR (json_valid(output_manifest_json) AND json_type(output_manifest_json) = 'object')
    ),
    CHECK (supervisor_agent_id <> executor_agent_id),
    CHECK (
      (status IN ('approved', 'failed', 'cancelled') AND completed_at IS NOT NULL)
      OR (status NOT IN ('approved', 'failed', 'cancelled') AND completed_at IS NULL)
    )
  );
`;

const DELEGATION_V17_COLUMNS = [
  "id", "topic_id", "work_item_id", "supervisor_agent_id", "executor_agent_id", "permission_profile",
  "status", "attempt", "max_attempts", "base_commit", "head_commit", "branch_name", "worktree_path",
  "executor_session_id", "supervisor_session_id", "summary", "review", "error",
  "created_at", "updated_at", "completed_at", "completion_policy", "acceptance_criteria",
  "resumed_from_id", "failure_code", "execution_state_json",
].join(", ");

const DELEGATION_V18_INDEX_SQL = `
  CREATE INDEX idx_work_item_delegations_topic_updated
    ON work_item_delegations(topic_id, updated_at DESC);
  CREATE INDEX idx_work_item_delegations_work_item
    ON work_item_delegations(work_item_id, updated_at DESC);
  CREATE UNIQUE INDEX idx_work_item_delegations_one_active
    ON work_item_delegations(work_item_id)
    WHERE status IN ('queued', 'executing', 'reviewing', 'changes_requested');
`;

const DELEGATION_V18_TRIGGER_SQL = `
  CREATE TRIGGER trg_work_item_delegations_revision_insert
    AFTER INSERT ON work_item_delegations BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_work_item_delegations_revision_update
    AFTER UPDATE ON work_item_delegations BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_work_item_delegations_revision_delete
    AFTER DELETE ON work_item_delegations BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
`;

const AUDIT_V18_TABLE_SQL = `
  CREATE TABLE runtime_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('run', 'delegation')),
    source_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    created_at TEXT NOT NULL
  );
`;

const AUDIT_COLUMNS = [
  "id", "topic_id", "source_kind", "source_id", "attempt", "kind", "data_json", "created_at",
].join(", ");

const AUDIT_V18_INDEX_AND_TRIGGER_SQL = `
  CREATE INDEX idx_runtime_audit_source
    ON runtime_audit_events(topic_id, source_kind, source_id, id);
  CREATE TRIGGER trg_runtime_audit_revision_insert AFTER INSERT ON runtime_audit_events BEGIN
    UPDATE council_meta SET value = value + 1 WHERE key IN ('revision', 'orchestration_revision');
  END;
  CREATE TRIGGER trg_runtime_audit_immutable BEFORE UPDATE ON runtime_audit_events BEGIN
    SELECT RAISE(ABORT, '运行审计记录不可覆盖。');
  END;
`;

export function migrateVersionEighteen(database: DatabaseSync, recordVersion = true): void {
  assertVersionSeventeenMigrationSource(database);
  const before = {
    workItems: countRows(database, "work_items"),
    delegations: countRows(database, "work_item_delegations"),
    audit: countRows(database, "runtime_audit_events"),
  };

  // 1. 拆掉旧触发器与索引，避免改名/拷贝期间触发 revision 自增或唯一冲突。
  database.exec(`
    DROP TRIGGER trg_work_items_revision_insert;
    DROP TRIGGER trg_work_items_revision_update;
    DROP TRIGGER trg_work_items_revision_delete;
    DROP TRIGGER trg_work_items_delegation_acceptance;
    DROP INDEX idx_work_items_topic_status;
    DROP INDEX idx_work_items_parent_title;
    DROP INDEX idx_work_items_parent_order;
    DROP TRIGGER trg_work_item_delegations_revision_insert;
    DROP TRIGGER trg_work_item_delegations_revision_update;
    DROP TRIGGER trg_work_item_delegations_revision_delete;
    DROP INDEX idx_work_item_delegations_topic_updated;
    DROP INDEX idx_work_item_delegations_work_item;
    DROP INDEX idx_work_item_delegations_one_active;
    DROP TRIGGER trg_runtime_audit_revision_insert;
    DROP TRIGGER trg_runtime_audit_immutable;
    DROP INDEX idx_runtime_audit_source;
  `);

  // 2. 三张旧表一起改名：改名父表会重写子表外键文本，子表必须跟着走。
  database.exec(`
    ALTER TABLE runtime_audit_events RENAME TO runtime_audit_events_v17_old;
    ALTER TABLE work_item_delegations RENAME TO work_item_delegations_v17_old;
    ALTER TABLE work_items RENAME TO work_items_v17_old;
  `);

  // 3. 按最终名字建新表并拷贝（父表先）。议题实施项的 project_path 取自议题。
  database.exec(WORK_ITEM_V18_TABLE_SQL);
  database.exec(`
    INSERT INTO work_items (${WORK_ITEM_V17_COLUMNS}, kind, source, priority, project_path, brief_json)
    SELECT ${WORK_ITEM_V17_COLUMNS}, 'code', 'topic', 0,
      (SELECT t.project_path FROM topics t WHERE t.id = old.topic_id), NULL
    FROM work_items_v17_old old;
  `);
  database.exec(DELEGATION_V18_TABLE_SQL);
  database.exec(`
    INSERT INTO work_item_delegations (${DELEGATION_V17_COLUMNS}, kind, input_asset_ids_json, output_manifest_json)
    SELECT ${DELEGATION_V17_COLUMNS}, 'code', '[]', NULL
    FROM work_item_delegations_v17_old;
  `);
  database.exec(AUDIT_V18_TABLE_SQL);
  database.exec(`
    INSERT INTO runtime_audit_events (${AUDIT_COLUMNS})
    SELECT ${AUDIT_COLUMNS} FROM runtime_audit_events_v17_old ORDER BY id;
    DELETE FROM sqlite_sequence WHERE name = 'runtime_audit_events';
    INSERT INTO sqlite_sequence (name, seq)
      SELECT 'runtime_audit_events', seq FROM sqlite_sequence
      WHERE name = 'runtime_audit_events_v17_old';
  `);

  // 4. 行数自检：assertCountsPreserved 不统计这三张表，这里自己兜底。
  const after = {
    workItems: countRows(database, "work_items"),
    delegations: countRows(database, "work_item_delegations"),
    audit: countRows(database, "runtime_audit_events"),
  };
  if (
    before.workItems !== after.workItems
    || before.delegations !== after.delegations
    || before.audit !== after.audit
  ) {
    throw new Error("Council v18 迁移拷贝后的行数与迁移前不一致。");
  }

  // 5. 删旧表（子表先，否则父表级联会误删新表外键指向的行）并重建索引/触发器。
  database.exec(`
    DROP TABLE runtime_audit_events_v17_old;
    DROP TABLE work_item_delegations_v17_old;
    DROP TABLE work_items_v17_old;
  `);
  database.exec(WORK_ITEM_V18_INDEX_SQL);
  database.exec(WORK_ITEM_V18_TRIGGER_SQL);
  database.exec(DELEGATION_V18_INDEX_SQL);
  database.exec(DELEGATION_V18_TRIGGER_SQL);
  database.exec(AUDIT_V18_INDEX_AND_TRIGGER_SQL);

  const violations = database.prepare("SELECT COUNT(*) AS value FROM pragma_foreign_key_check").get() as unknown as ScalarRow;
  if (Number(violations.value) !== 0) {
    throw new Error("Council v18 迁移后存在外键违例。");
  }

  if (recordVersion) {
    database.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
      .run(18, "task-first-class", new Date().toISOString());
    database.exec("PRAGMA user_version = 18;");
  }
}
