/**
 * @input  依赖：已由 Council Node 迁移器准备的 SQLite 与 node:sqlite
 * @output 导出：编排 / RuntimeBinding / 圆桌收敛 schema SQL 和只读兼容性验证
 * @pos    Node 唯一迁移器与 SQLiteCouncilStore 共享的编排结构契约
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { DatabaseSync } from "node:sqlite";

interface RequiredTableRow {
  name: unknown;
}

interface SchemaVersionRow {
  value: unknown;
}

const REQUIRED_COUNCIL_TABLES = [
  "topics",
  "messages",
  "council_meta",
  "actor_identities",
  "actor_aliases",
  "decisions",
  "provider_profiles",
  "agent_definitions",
  "runtime_bindings",
  "runtime_binding_leases",
  "discussion_cycles",
  "blocking_questions",
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
] as const;

const REQUIRED_ORCHESTRATION_TABLES = [
  "orchestration_runs",
  "orchestration_approvals",
  "orchestration_run_leases",
] as const;

const REQUIRED_ORCHESTRATION_INDEXES = [
  "idx_orchestration_runs_topic_updated",
  "idx_orchestration_runs_status_updated",
  "idx_orchestration_runs_one_active_topic",
  "idx_orchestration_run_leases_expiry",
] as const;

const REQUIRED_ORCHESTRATION_TRIGGERS = [
  "trg_orchestration_runs_revision_insert",
  "trg_orchestration_runs_revision_update",
  "trg_orchestration_runs_revision_delete",
] as const;

export const ORCHESTRATION_SCHEMA_VERSION = 4;

function orchestrationSchemaSql(
  schemaVersion: number,
  snapshotVersions: string,
): string {
  return `
  INSERT OR IGNORE INTO council_meta (key, value) VALUES ('revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value)
    VALUES ('content_revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value)
    VALUES ('orchestration_revision', 0);
  INSERT OR IGNORE INTO council_meta (key, value)
    VALUES ('orchestration_schema_version', ${String(schemaVersion)});

  CREATE TABLE IF NOT EXISTS orchestration_runs (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
      status IN ('idle', 'running', 'waiting_agent', 'waiting_user', 'completed', 'failed', 'cancelled')
    ),
    snapshot_schema_version INTEGER NOT NULL CHECK (
      snapshot_schema_version IN (${snapshotVersions})
    ),
    snapshot_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orchestration_approvals (
    run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
    approval_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version > 0),
    approved_by_actor_id TEXT NOT NULL REFERENCES actor_identities(id),
    approved_by_legacy TEXT,
    applied_run_version INTEGER NOT NULL CHECK (applied_run_version > expected_version),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, approval_id)
  );

  CREATE TABLE IF NOT EXISTS orchestration_run_leases (
    run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orchestration_runs_topic_updated
    ON orchestration_runs(topic_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_updated
    ON orchestration_runs(status, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_runs_one_active_topic
    ON orchestration_runs(topic_id)
    WHERE status IN ('idle', 'running', 'waiting_agent', 'waiting_user');
  CREATE INDEX IF NOT EXISTS idx_orchestration_run_leases_expiry
    ON orchestration_run_leases(expires_at_ms);

  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_insert;
  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_update;
  DROP TRIGGER IF EXISTS trg_orchestration_runs_revision_delete;

  CREATE TRIGGER trg_orchestration_runs_revision_insert
    AFTER INSERT ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_orchestration_runs_revision_update
    AFTER UPDATE ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_orchestration_runs_revision_delete
    AFTER DELETE ON orchestration_runs BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
`;
}

/** 只用于构造/验证历史 Council v2/v3 数据库，禁止新 Run 写入。 */
export const LEGACY_ORCHESTRATION_SCHEMA_V2_SQL = orchestrationSchemaSql(2, "1, 2");
export const ORCHESTRATION_SCHEMA_SQL = orchestrationSchemaSql(
  ORCHESTRATION_SCHEMA_VERSION,
  "1, 2, 3, 4",
);

/** RuntimeBinding DDL 的唯一正本；由 Node 迁移器执行，Store/Rust 只验证。 */
export const RUNTIME_BINDING_SCHEMA_SQL = `
  CREATE TABLE runtime_bindings (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES actor_identities(id) ON DELETE RESTRICT,
    provider_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
    binding_revision TEXT NOT NULL,
    agent_config_revision INTEGER NOT NULL CHECK (agent_config_revision > 0),
    provider_config_revision INTEGER NOT NULL CHECK (provider_config_revision > 0),
    project_path TEXT,
    transport_kind TEXT NOT NULL CHECK (
      transport_kind IN ('claude-resume', 'codex-resume', 'openai-sessionless')
    ),
    session_id TEXT,
    cursor_created_at TEXT,
    cursor_message_id TEXT,
    status TEXT NOT NULL CHECK (
      status IN (
        'starting', 'ready', 'thinking', 'streaming', 'idle',
        'interrupted', 'closing', 'closed'
      )
    ),
    state_version INTEGER NOT NULL CHECK (state_version > 0),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    process_instance_id TEXT,
    last_activity_at TEXT NOT NULL,
    close_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    CHECK (
      (cursor_created_at IS NULL AND cursor_message_id IS NULL)
      OR (cursor_created_at IS NOT NULL AND cursor_message_id IS NOT NULL)
    ),
    CHECK (
      (status = 'closed' AND closed_at IS NOT NULL)
      OR (status <> 'closed' AND closed_at IS NULL)
    )
  );

  CREATE TABLE runtime_binding_leases (
    binding_id TEXT PRIMARY KEY REFERENCES runtime_bindings(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE runtime_binding_requests (
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
    request_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    consumed_at TEXT NOT NULL,
    PRIMARY KEY (topic_id, agent_id, request_message_id)
  );

  CREATE INDEX idx_runtime_bindings_topic_status
    ON runtime_bindings(topic_id, status, updated_at DESC);
  CREATE INDEX idx_runtime_bindings_idle
    ON runtime_bindings(status, last_activity_at);
  CREATE UNIQUE INDEX idx_runtime_bindings_one_open_agent
    ON runtime_bindings(topic_id, agent_id)
    WHERE status <> 'closed';
  CREATE UNIQUE INDEX idx_runtime_bindings_active_session
    ON runtime_bindings(provider_id, agent_id, transport_kind, session_id)
    WHERE session_id IS NOT NULL
      AND status <> 'closed'
      AND transport_kind IN ('claude-resume', 'codex-resume');
  CREATE INDEX idx_runtime_binding_leases_expiry
    ON runtime_binding_leases(expires_at_ms);

  CREATE TRIGGER trg_runtime_bindings_revision_insert
    AFTER INSERT ON runtime_bindings BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_runtime_bindings_revision_update
    AFTER UPDATE ON runtime_bindings BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_runtime_bindings_revision_delete
    AFTER DELETE ON runtime_bindings BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;

  CREATE TRIGGER trg_decisions_runtime_close_insert
    AFTER INSERT ON decisions
    WHEN NEW.status = 'accepted'
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
    WHEN OLD.status <> 'accepted' AND NEW.status = 'accepted'
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
`;

/**
 * 圆桌收敛 DDL 的唯一正本；由 Node 迁移器执行，Store/Rust 只验证。
 *
 * 一个 Topic 同时只允许一个 active cycle——议题分裂正是圆桌出不了决策的根因，
 * 所以并发唯一性交给部分唯一索引，而不是应用层判断。
 * participants_json 在开局冻结，首位是提案人；中途改 Agent 名册会让"所有评审都发言了"
 * 这个推进条件在同一个 cycle 里前后不一致，所以名册和运行计划一样必须冻结。
 * turns_json 记录已完成发言的 (agent, stage, round, stance, messageId)——轮次与立场
 * 都不能从 messages 反推，沿用 orchestration_runs 的快照 JSON 惯例存在同一行里。
 * stage 是固定四段协议（proposal→critique→rebuttal→synthesis），不做通用 DAG：
 * 通用编排能表达一切流程，也就无法保证任何一次讨论会收敛。
 * accepted 决策同时终结 cycle 与未答问题——沿用 RuntimeBinding 的同一条 fencing，
 * 否则自动交接会在已决议题上继续召唤 Agent。v6 的触发器文本是冻结的，
 * 因此这里另立触发器而不是改写它们。
 */
export const DISCUSSION_CYCLE_SCHEMA_SQL = `
  CREATE TABLE discussion_cycles (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (
      stage IN (
        'proposal', 'critique', 'rebuttal', 'synthesis',
        'awaiting_user', 'completed'
      )
    ),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
    participants_json TEXT NOT NULL CHECK (
      json_valid(participants_json)
      AND json_type(participants_json) = 'array'
      AND json_array_length(participants_json) > 0
    ),
    turns_json TEXT NOT NULL CHECK (
      json_valid(turns_json) AND json_type(turns_json) = 'array'
    ),
    round_budget INTEGER NOT NULL CHECK (round_budget > 0),
    current_round INTEGER NOT NULL CHECK (current_round >= 0),
    resume_stage TEXT CHECK (
      resume_stage IS NULL
      OR resume_stage IN ('proposal', 'critique', 'rebuttal', 'synthesis')
    ),
    context_cursor_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
    context_cursor_created_at TEXT,
    proposed_decision_id TEXT REFERENCES decisions(id) ON DELETE RESTRICT,
    state_version INTEGER NOT NULL CHECK (state_version > 0),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (current_round <= round_budget),
    CHECK (
      (context_cursor_message_id IS NULL AND context_cursor_created_at IS NULL)
      OR (
        context_cursor_message_id IS NOT NULL
        AND context_cursor_created_at IS NOT NULL
      )
    ),
    CHECK (
      (status = 'active' AND completed_at IS NULL)
      OR (status <> 'active' AND completed_at IS NOT NULL)
    ),
    CHECK (stage <> 'completed' OR status <> 'active'),
    CHECK (status <> 'completed' OR stage = 'completed'),
    CHECK (
      (stage = 'awaiting_user' AND resume_stage IS NOT NULL)
      OR (stage <> 'awaiting_user' AND resume_stage IS NULL)
    ),
    CHECK (
      proposed_decision_id IS NULL
      OR stage IN ('synthesis', 'completed')
    ),
    CHECK (status <> 'completed' OR proposed_decision_id IS NOT NULL)
  );

  CREATE TABLE blocking_questions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL REFERENCES discussion_cycles(id) ON DELETE CASCADE,
    asked_by_actor_id TEXT NOT NULL
      REFERENCES actor_identities(id) ON DELETE RESTRICT,
    asked_at_stage TEXT NOT NULL CHECK (
      asked_at_stage IN ('proposal', 'critique', 'rebuttal', 'synthesis')
    ),
    question TEXT NOT NULL CHECK (length(trim(question)) > 0),
    rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
    options_json TEXT NOT NULL CHECK (
      json_valid(options_json) AND json_type(options_json) = 'array'
    ),
    status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'withdrawn')),
    question_message_id TEXT NOT NULL UNIQUE
      REFERENCES messages(id) ON DELETE RESTRICT,
    answer_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK (
      (status = 'answered' AND answer_message_id IS NOT NULL)
      OR (status <> 'answered' AND answer_message_id IS NULL)
    ),
    CHECK (
      (status = 'open' AND resolved_at IS NULL)
      OR (status <> 'open' AND resolved_at IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX idx_discussion_cycles_one_active_topic
    ON discussion_cycles(topic_id)
    WHERE status = 'active';
  CREATE INDEX idx_discussion_cycles_topic_updated
    ON discussion_cycles(topic_id, updated_at DESC);
  CREATE INDEX idx_discussion_cycles_status_stage
    ON discussion_cycles(status, stage, updated_at DESC);
  CREATE UNIQUE INDEX idx_blocking_questions_one_open_cycle
    ON blocking_questions(cycle_id)
    WHERE status = 'open';
  CREATE INDEX idx_blocking_questions_cycle_created
    ON blocking_questions(cycle_id, created_at);
  CREATE INDEX idx_blocking_questions_status_created
    ON blocking_questions(status, created_at);

  CREATE TRIGGER trg_discussion_cycles_revision_insert
    AFTER INSERT ON discussion_cycles BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_discussion_cycles_revision_update
    AFTER UPDATE ON discussion_cycles BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_discussion_cycles_revision_delete
    AFTER DELETE ON discussion_cycles BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_blocking_questions_revision_insert
    AFTER INSERT ON blocking_questions BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_blocking_questions_revision_update
    AFTER UPDATE ON blocking_questions BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;
  CREATE TRIGGER trg_blocking_questions_revision_delete
    AFTER DELETE ON blocking_questions BEGIN
      UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
      UPDATE council_meta SET value = value + 1 WHERE key = 'orchestration_revision';
    END;

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
          stop_reason = 'decision-accepted',
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
          stop_reason = 'decision-accepted',
          updated_at = NEW.updated_at,
          completed_at = NEW.updated_at
      WHERE topic_id = NEW.topic_id AND status = 'active';
    END;
`;

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  sql: unknown;
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function orchestrationSchemaObjects(database: DatabaseSync): Map<string, string> {
  const requiredByType: Readonly<Record<string, readonly string[]>> = {
    table: REQUIRED_ORCHESTRATION_TABLES,
    index: REQUIRED_ORCHESTRATION_INDEXES,
    trigger: REQUIRED_ORCHESTRATION_TRIGGERS,
  };
  const rows = database
    .prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all() as unknown as SchemaObjectRow[];
  const objects = new Map<string, string>();
  for (const row of rows) {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new Error("Council 编排 schema 元数据无效。");
    }
    if (requiredByType[row.type]?.includes(row.name)) {
      objects.set(`${row.type}:${row.name}`, normalizeSchemaSql(row.sql));
    }
  }
  return objects;
}

let canonicalObjects: ReadonlyMap<string, string> | undefined;

function canonicalOrchestrationSchemaObjects(): ReadonlyMap<string, string> {
  if (canonicalObjects) {
    return canonicalObjects;
  }
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE topics (id TEXT PRIMARY KEY);
      CREATE TABLE council_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE actor_identities (id TEXT PRIMARY KEY);
      CREATE TABLE actor_aliases (
        alias TEXT PRIMARY KEY COLLATE NOCASE,
        actor_id TEXT NOT NULL REFERENCES actor_identities(id)
      );
    `);
    database.exec(ORCHESTRATION_SCHEMA_SQL);
    canonicalObjects = orchestrationSchemaObjects(database);
    return canonicalObjects;
  } finally {
    database.close();
  }
}

export function assertOrchestrationSchema(database: DatabaseSync): void {
  const rows = database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
    `)
    .all() as unknown as RequiredTableRow[];
  const existing = new Set(
    rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
  const missing = REQUIRED_COUNCIL_TABLES.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`Council SQLite 缺少已迁移表：${missing.join(", ")}。`);
  }
  const expected = canonicalOrchestrationSchemaObjects();
  const actual = orchestrationSchemaObjects(database);
  for (const [key, expectedSql] of expected) {
    if (actual.get(key) !== expectedSql) {
      throw new Error(`Council 编排 schema 定义不兼容：${key}。`);
    }
  }
  if (actual.size !== expected.size) {
    throw new Error("Council 编排 schema 必需对象集合不兼容。");
  }
  const versionRow = database
    .prepare("SELECT value FROM council_meta WHERE key = 'orchestration_schema_version'")
    .get() as unknown as SchemaVersionRow | undefined;
  if (!versionRow || versionRow.value !== ORCHESTRATION_SCHEMA_VERSION) {
    throw new Error("不支持的 Council 编排数据库结构版本。");
  }
}
