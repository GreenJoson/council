/**
 * @input  依赖：临时 Council SQLite、两个 Store 连接与编排领域类型
 * @output 导出：重启、CAS、lease、单活动、原子消息和损坏数据测试
 * @pos    SQLiteCouncilStore 双连接 fencing 与安全边界验证
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
  LEGACY_AGENT_CLEANUP_TIMEOUT_MS,
  LeaseConflictError,
  LeaseLostError,
  SQLiteCouncilStore,
  StoreConflictError,
} from "../src/index.js";
import type {
  CreateRunInput,
  OrchestrationRun,
  PublicAuthor,
  RoundCommitInput,
  RunLease,
} from "../src/types.js";

const BUSY_TIMEOUT_MS = 5_000;
const TOPIC_ID = "topic_sqlite_store_test";

function createBaseDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        project_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'closed')),
        created_by TEXT NOT NULL CHECK (created_by IN ('human', 'claude', 'codex', 'chair', 'other')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK (author IN ('human', 'claude', 'codex', 'chair', 'other')),
        kind TEXT NOT NULL CHECK (kind IN ('brief', 'proposal', 'critique', 'rebuttal', 'synthesis', 'note')),
        content TEXT NOT NULL,
        parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE council_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT INTO council_meta (key, value) VALUES ('revision', 0);
      CREATE TRIGGER trg_topics_revision_update
        AFTER UPDATE ON topics BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        END;
      CREATE TRIGGER trg_messages_revision_insert
        AFTER INSERT ON messages BEGIN
          UPDATE council_meta SET value = value + 1 WHERE key = 'revision';
        END;
    `);
    const now = new Date().toISOString();
    database
      .prepare(`
        INSERT INTO topics (
          id, title, question, constraints_json, project_path,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', 'human', ?, ?)
      `)
      .run(
        TOPIC_ID,
        "SQLite 编排一致性",
        "双连接能否只提交一轮？",
        JSON.stringify(["取消后禁止写入"]),
        path.dirname(databasePath),
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function withDatabase(
  operation: (databasePath: string, directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "council-orchestrator-store-"));
  const databasePath = path.join(directory, "council.sqlite3");
  createBaseDatabase(databasePath);
  return operation(databasePath, directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function createInput(options?: {
  rounds?: number;
  beforeRounds?: readonly number[];
}): CreateRunInput {
  const rounds = options?.rounds ?? 1;
  return {
    topicId: TOPIC_ID,
    plan: Array.from({ length: rounds }, (_value, index) => ({
      adapterId: "alpha",
      publicAuthor: index % 2 === 0 ? "claude" : "codex",
      messageKind: index % 2 === 0 ? "proposal" : "critique",
      instruction: `执行第 ${String(index + 1)} 轮`,
    })),
    policy: {
      maxRounds: rounds,
      allowedAgents: ["alpha"],
      agentTimeoutMs: 1_000,
      agentCleanupTimeoutMs: 100,
      maxAttemptsPerRound: 1,
      maxManualRecoveries: 1,
      confirmation: {
        beforeRounds: options?.beforeRounds ?? [],
        beforeCompletion: false,
      },
    },
  };
}

async function moveToWaitingAgent(
  store: SQLiteCouncilStore,
  created: OrchestrationRun,
): Promise<OrchestrationRun> {
  const running = await store.replaceRun({ ...created, status: "running" }, created.version);
  return await store.replaceRun(
    {
      ...running,
      status: "waiting_agent",
      activeAgentId: "alpha",
      currentAttempt: 1,
    },
    running.version,
  );
}

function nextRoundCommit(waiting: OrchestrationRun, lease: RunLease): RoundCommitInput {
  const { activeAgentId: _activeAgentId, ...stable } = waiting;
  return {
    expectedVersion: waiting.version,
    lease,
    run: {
      ...stable,
      status: "running",
      nextRoundIndex: waiting.nextRoundIndex + 1,
      currentAttempt: 0,
    },
    message: {
      topicId: waiting.topicId,
      author: "claude",
      kind: "proposal",
      content: "原子提交的公开回复。",
    },
  };
}

function countRows(databasePath: string, table: "messages" | "orchestration_approvals"): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as unknown as { count: unknown };
    if (typeof row.count !== "number") {
      throw new Error("测试计数结果无效。");
    }
    return row.count;
  } finally {
    database.close();
  }
}

function getRevision(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM council_meta WHERE key = 'revision'")
      .get() as unknown as { value: unknown };
    if (typeof row.value !== "number") {
      throw new Error("测试 revision 结果无效。");
    }
    return row.value;
  } finally {
    database.close();
  }
}

function getRevisions(databasePath: string): {
  total: number;
  content: number;
  orchestration: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(`
        SELECT key, value FROM council_meta
        WHERE key IN ('revision', 'content_revision', 'orchestration_revision')
      `)
      .all() as unknown as Array<{ key: unknown; value: unknown }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const total = values.get("revision");
    const content = values.get("content_revision");
    const orchestration = values.get("orchestration_revision");
    if (
      typeof total !== "number" ||
      typeof content !== "number" ||
      typeof orchestration !== "number"
    ) {
      throw new Error("测试 revisions 结果无效。");
    }
    return { total, content, orchestration };
  } finally {
    database.close();
  }
}

test("运行快照可在 Store 重启后严格读取且状态变化推进 revision", async () => {
  await withDatabase(async (databasePath) => {
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const created = await first.createRun(createInput());
    const running = await first.replaceRun({ ...created, status: "running" }, created.version);
    const revisionAfterTransitions = getRevision(databasePath);
    first.close();

    const reopened = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const persisted = await reopened.getRun(created.id);
      assert.deepEqual(persisted, running);
      assert.equal(persisted.version, 2);
      assert.ok(revisionAfterTransitions >= 2);
    } finally {
      reopened.close();
    }
  });
});

test("旧 V1 快照缺少清理时限时只用协议迁移常量回填", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const raw = new DatabaseSync(databasePath);
      try {
        const row = raw.prepare(
          "SELECT snapshot_json FROM orchestration_runs WHERE id = ?",
        ).get(created.id) as unknown as { snapshot_json: string };
        const snapshot = JSON.parse(row.snapshot_json) as {
          policy: { agentCleanupTimeoutMs?: number };
        };
        delete snapshot.policy.agentCleanupTimeoutMs;
        raw.prepare("UPDATE orchestration_runs SET snapshot_json = ? WHERE id = ?")
          .run(JSON.stringify(snapshot), created.id);
      } finally {
        raw.close();
      }

      const migrated = await store.getRun(created.id);
      assert.equal(
        migrated.policy.agentCleanupTimeoutMs,
        LEGACY_AGENT_CLEANUP_TIMEOUT_MS,
      );
    } finally {
      store.close();
    }
  });
});

test("两个 Store 连接用 version CAS 拒绝重复状态提交", async () => {
  await withDatabase(async (databasePath) => {
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await first.createRun(createInput());
      const stale = await second.getRun(created.id);
      const saved = await first.replaceRun({ ...created, status: "running" }, created.version);
      assert.equal(saved.version, created.version + 1);
      await assert.rejects(
        second.replaceRun({ ...stale, status: "running" }, stale.version),
        StoreConflictError,
      );
      assert.deepEqual(await second.getRun(created.id), saved);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("approvalId 重放幂等且不会跨过后续确认门", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const replayStore = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput({ rounds: 2, beforeRounds: [1, 2] }));
      const waitingFirst = await store.replaceRun(
        { ...created, status: "waiting_user", pendingGateId: "before_round:1" },
        created.version,
      );
      const approval = {
        runId: created.id,
        expectedGateId: "before_round:1",
        expectedVersion: waitingFirst.version,
        approvalId: "approval_first",
        approvedBy: "human" as const,
      };
      const revisionBeforeApproval = getRevision(databasePath);
      const first = await store.approveGate(approval);
      assert.equal(first.applied, true);
      assert.ok(getRevision(databasePath) > revisionBeforeApproval);

      const waitingSecond = await store.replaceRun(
        {
          ...first.run,
          status: "waiting_user",
          nextRoundIndex: 1,
          pendingGateId: "before_round:2",
        },
        first.run.version,
      );
      const replay = await replayStore.approveGate(approval);
      assert.equal(replay.applied, false);
      assert.equal(replay.run.pendingGateId, "before_round:2");
      assert.equal(replay.run.version, waitingSecond.version);
      assert.equal(countRows(databasePath, "orchestration_approvals"), 1);

      await assert.rejects(
        store.approveGate({
          ...approval,
          expectedGateId: "before_round:2",
          expectedVersion: waitingSecond.version,
        }),
        StoreConflictError,
      );
    } finally {
      replayStore.close();
      store.close();
    }
  });
});

test("取消先提交后迟到轮次不能写入公开消息", async () => {
  await withDatabase(async (databasePath) => {
    const cancelling = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const committing = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await cancelling.createRun(createInput());
      const waiting = await moveToWaitingAgent(cancelling, created);
      const lease = await cancelling.claimRunLease({
        runId: waiting.id,
        ownerId: "cancel-test",
        ttlMs: 60_000,
      });
      const staleCommit = nextRoundCommit(waiting, lease);
      const revisionBeforeCancel = getRevision(databasePath);
      const cancelled = await cancelling.cancelRun(created.id);
      assert.equal(cancelled.status, "cancelled");
      assert.ok(getRevision(databasePath) > revisionBeforeCancel);
      await assert.rejects(committing.commitRound(staleCommit), StoreConflictError);
      assert.equal(countRows(databasePath, "messages"), 0);
    } finally {
      committing.close();
      cancelling.close();
    }
  });
});

test("跨连接取消原子失效 lease，续租失败且只推进 orchestration revision", async () => {
  await withDatabase(async (databasePath) => {
    const holder = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const canceller = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await holder.createRun(createInput());
      const waiting = await moveToWaitingAgent(holder, created);
      const lease = await holder.claimRunLease({
        runId: waiting.id,
        ownerId: "remote-holder",
        ttlMs: 60_000,
      });
      const before = getRevisions(databasePath);

      const cancelled = await canceller.cancelRun(waiting.id);

      assert.equal(cancelled.status, "cancelled");
      await assert.rejects(
        holder.renewRunLease({ lease, ttlMs: 60_000 }),
        LeaseLostError,
      );
      const after = getRevisions(databasePath);
      assert.ok(after.total > before.total);
      assert.equal(after.content, before.content);
      assert.ok(after.orchestration > before.orchestration);
    } finally {
      canceller.close();
      holder.close();
    }
  });
});

test("Store 拒绝超长 Agent 消息且运行和消息保持原子不变", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "oversize-message",
        ttlMs: 60_000,
      });
      const commit = nextRoundCommit(waiting, lease);
      commit.message.content = "x".repeat(30_001);

      await assert.rejects(store.commitRound(commit), InvalidRunStateError);

      assert.deepEqual(await store.getRun(waiting.id), waiting);
      assert.equal(countRows(databasePath, "messages"), 0);
    } finally {
      store.close();
    }
  });
});

test("双连接竞争轮次时只有一个原子提交消息和运行", async () => {
  await withDatabase(async (databasePath) => {
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await first.createRun(createInput());
      const waiting = await moveToWaitingAgent(first, created);
      const lease = await first.claimRunLease({
        runId: waiting.id,
        ownerId: "commit-test",
        ttlMs: 60_000,
      });
      const commit = nextRoundCommit(waiting, lease);
      const revisionBeforeCommit = getRevision(databasePath);
      const results = await Promise.allSettled([
        first.commitRound(commit),
        second.commitRound(commit),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      assert.equal(countRows(databasePath, "messages"), 1);
      const saved = await first.getRun(created.id);
      assert.equal(saved.nextRoundIndex, 1);
      assert.equal(saved.version, waiting.version + 1);
      const context = await second.getTopicContext(TOPIC_ID);
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0]?.author, "claude");
      assert.ok(getRevision(databasePath) > revisionBeforeCommit);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("非规范公开作者在进入 SQLite 前被拒绝", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "author-test",
        ttlMs: 60_000,
      });
      const commit = nextRoundCommit(waiting, lease);
      const invalidAuthor: unknown = "custom-runtime";
      commit.message.author = invalidAuthor as PublicAuthor;
      await assert.rejects(store.commitRound(commit), InvalidRunStateError);
      assert.equal(countRows(databasePath, "messages"), 0);
    } finally {
      store.close();
    }
  });
});

test("损坏 JSON 快照明确失败而不是回退默认状态", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const raw = new DatabaseSync(databasePath);
      try {
        raw.prepare("UPDATE orchestration_runs SET snapshot_json = ? WHERE id = ?")
          .run("{broken", created.id);
      } finally {
        raw.close();
      }
      await assert.rejects(
        store.getRun(created.id),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /不是有效 JSON/.test(error.message),
      );

      const invalidProtocolSnapshot = {
        ...created,
        plan: [{ ...created.plan[0], publicAuthor: "custom-runtime" }],
      };
      const rawProtocol = new DatabaseSync(databasePath);
      try {
        rawProtocol.prepare("UPDATE orchestration_runs SET snapshot_json = ? WHERE id = ?")
          .run(JSON.stringify(invalidProtocolSnapshot), created.id);
      } finally {
        rawProtocol.close();
      }
      await assert.rejects(
        store.getRun(created.id),
        (error: unknown) =>
          error instanceof InvalidRunStateError && /规范公开作者/.test(error.message),
      );
    } finally {
      store.close();
    }
  });
});

test("消息插入失败会回滚同一事务内的运行 CAS", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "rollback-test",
        ttlMs: 60_000,
      });
      const raw = new DatabaseSync(databasePath);
      try {
        raw.exec(`
          CREATE TRIGGER reject_test_message
          BEFORE INSERT ON messages BEGIN
            SELECT RAISE(ABORT, 'test message rejection');
          END;
        `);
      } finally {
        raw.close();
      }

      await assert.rejects(store.commitRound(nextRoundCommit(waiting, lease)));
      const persisted = await store.getRun(created.id);
      assert.equal(persisted.status, "waiting_agent");
      assert.equal(persisted.version, waiting.version);
      assert.equal(persisted.nextRoundIndex, 0);
      assert.equal(countRows(databasePath, "messages"), 0);
    } finally {
      store.close();
    }
  });
});

test("双连接 lease 竞争、续租和释放都不推进 Council revision", async () => {
  await withDatabase(async (databasePath) => {
    let nowMs = 1_000_000;
    const now = (): number => nowMs;
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    try {
      const created = await first.createRun(createInput());
      const running = await first.replaceRun({ ...created, status: "running" }, created.version);
      const revisionBeforeLease = getRevision(databasePath);
      const lease = await first.claimRunLease({
        runId: running.id,
        ownerId: "runner-first",
        ttlMs: 1_000,
      });
      await assert.rejects(
        second.claimRunLease({
          runId: running.id,
          ownerId: "runner-second",
          ttlMs: 1_000,
        }),
        LeaseConflictError,
      );
      nowMs += 100;
      const renewed = await first.renewRunLease({ lease, ttlMs: 2_000 });
      assert.ok(renewed.expiresAtMs > lease.expiresAtMs);
      assert.equal(await first.releaseRunLease(renewed), true);
      assert.equal(await second.releaseRunLease(lease), false);
      assert.equal(getRevision(databasePath), revisionBeforeLease);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("过期 lease 接管递增 epoch 并拒绝旧 token 的迟到提交", async () => {
  await withDatabase(async (databasePath) => {
    let nowMs = 2_000_000;
    const now = (): number => nowMs;
    const first = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    const second = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, now);
    try {
      const created = await first.createRun(createInput());
      const waiting = await moveToWaitingAgent(first, created);
      const oldLease = await first.claimRunLease({
        runId: waiting.id,
        ownerId: "runner-old",
        ttlMs: 100,
      });
      nowMs += 101;
      const currentLease = await second.claimRunLease({
        runId: waiting.id,
        ownerId: "runner-new",
        ttlMs: 1_000,
      });
      assert.equal(currentLease.epoch, oldLease.epoch + 1);
      assert.notEqual(currentLease.token, oldLease.token);
      await assert.rejects(
        first.commitRound(nextRoundCommit(waiting, oldLease)),
        LeaseLostError,
      );
      const committed = await second.commitRound(nextRoundCommit(waiting, currentLease));
      assert.equal(committed.run.nextRoundIndex, 1);
      assert.equal(countRows(databasePath, "messages"), 1);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("同一 topic 只允许一个活动 run，failed 可让路但恢复仍受唯一约束", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const first = await store.createRun(createInput());
      await assert.rejects(store.createRun(createInput()), StoreConflictError);
      await store.cancelRun(first.id);

      const failedCandidate = await store.createRun(createInput());
      const running = await store.replaceRun(
        { ...failedCandidate, status: "running" },
        failedCandidate.version,
      );
      const failed = await store.replaceRun(
        {
          ...running,
          status: "failed",
          failure: {
            code: "agent_failed",
            message: "测试失败。",
            retryable: true,
          },
        },
        running.version,
      );
      const active = await store.createRun(createInput());
      const { failure: _failure, ...recovering } = failed;
      await assert.rejects(
        store.replaceRun({ ...recovering, status: "running" }, failed.version),
        StoreConflictError,
      );

      const page = await store.listRunsForTopic({ topicId: TOPIC_ID, limit: 2, offset: 0 });
      assert.equal(page.total, 3);
      assert.equal(page.count, 2);
      assert.equal(page.hasMore, true);
      assert.ok(page.runs.some((run) => run.id === active.id));
      const context = await store.getTopicContext(TOPIC_ID);
      assert.equal(context.projectPath, path.dirname(databasePath));
    } finally {
      store.close();
    }
  });
});

test("Agent 上下文只读取按配置限制的最新公开消息", async () => {
  await withDatabase(async (databasePath) => {
    const database = new DatabaseSync(databasePath);
    try {
      const insert = database.prepare(`
        INSERT INTO messages (
          id, topic_id, author, kind, content, parent_message_id, created_at
        ) VALUES (?, ?, 'human', 'note', ?, NULL, ?)
      `);
      for (let index = 1; index <= 5; index += 1) {
        insert.run(
          `message_context_${String(index)}`,
          TOPIC_ID,
          `公开消息 ${String(index)}`,
          new Date(Date.UTC(2026, 0, index)).toISOString(),
        );
      }
    } finally {
      database.close();
    }

    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS, Date.now, 3);
    try {
      const context = await store.getTopicContext(TOPIC_ID);
      assert.deepEqual(
        context.messages.map((message) => message.content),
        ["公开消息 3", "公开消息 4", "公开消息 5"],
      );
    } finally {
      store.close();
    }
  });
});

test("commitRound 绑定当前计划作者和类型并拒绝偷改运行字段", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    try {
      const created = await store.createRun(createInput());
      const waiting = await moveToWaitingAgent(store, created);
      const lease = await store.claimRunLease({
        runId: waiting.id,
        ownerId: "strict-commit",
        ttlMs: 60_000,
      });
      const base = nextRoundCommit(waiting, lease);
      await assert.rejects(
        store.commitRound({ ...base, message: { ...base.message, author: "codex" } }),
        StoreConflictError,
      );
      await assert.rejects(
        store.commitRound({ ...base, message: { ...base.message, kind: "critique" } }),
        StoreConflictError,
      );
      await assert.rejects(
        store.commitRound({
          ...base,
          run: { ...base.run, currentAttempt: 1 },
        }),
      );
      await assert.rejects(
        store.commitRound({
          ...base,
          run: { ...base.run, manualRecoveriesUsed: 1 },
        }),
      );
      await assert.rejects(
        store.commitRound({
          ...base,
          run: { ...base.run, confirmedGates: ["before_completion"] },
        }),
      );
      assert.equal(countRows(databasePath, "messages"), 0);
      assert.deepEqual(await store.getRun(waiting.id), waiting);
    } finally {
      store.close();
    }
  });
});

test("Store close 幂等且迁移失败会释放数据库连接", async () => {
  await withDatabase(async (databasePath, directory) => {
    const store = new SQLiteCouncilStore(databasePath, BUSY_TIMEOUT_MS);
    store.close();
    store.close();

    const invalidPath = path.join(directory, "invalid.sqlite3");
    const invalid = new DatabaseSync(invalidPath);
    invalid.close();
    assert.throws(() => new SQLiteCouncilStore(invalidPath, BUSY_TIMEOUT_MS));
    const reopened = new DatabaseSync(invalidPath);
    reopened.exec("CREATE TABLE connection_released (id INTEGER PRIMARY KEY);");
    reopened.close();
  });
});
