/**
 * @input  依赖：临时 legacy/fresh SQLite、Node online backup 与 schema 迁移故障注入
 * @output 验证：连续账本、canonical schema、实例身份、备份、回滚、并发重试和 revision
 * @pos    Node 唯一生产迁移器的安全主验收
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  COUNCIL_SCHEMA_VERSION,
  assertCouncilSchema,
  migrateCouncilSchema,
} from "../src/schema-migrator.js";

const LEGACY_SCHEMA_SQL = `
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
`;

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "council-schema-migration-"));
  return {
    directory,
    databasePath: path.join(directory, "council.sqlite3"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function createLegacyDatabase(databasePath: string, topicId = "topic_legacy"): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(LEGACY_SCHEMA_SQL);
    database.prepare(`
      INSERT INTO topics (
        id, title, question, constraints_json, project_path,
        status, created_by, created_at, updated_at
      ) VALUES (?, 'legacy', 'legacy', '[]', NULL, 'open', 'human', ?, ?)
    `).run(topicId, new Date().toISOString(), new Date().toISOString());
  } finally {
    database.close();
  }
}

function pragmaInteger(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  assert.ok(row && typeof row === "object");
  const values = Object.values(row);
  assert.equal(values.length, 1);
  assert.equal(typeof values[0], "number");
  return values[0] as number;
}

test("fresh DB 由 Node 创建版本账本且 revision trigger 可工作", async () => {
  const fixture = temporaryDatabase();
  try {
    const result = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.equal(result.migrated, true);
    assert.equal(result.version, COUNCIL_SCHEMA_VERSION);
    assert.equal(result.backupPath, undefined);

    const database = new DatabaseSync(fixture.databasePath);
    try {
      assertCouncilSchema(database);
      assert.equal(pragmaInteger(database, "user_version"), COUNCIL_SCHEMA_VERSION);
      const ledger = database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as unknown as { version: number };
      assert.equal(ledger.version, COUNCIL_SCHEMA_VERSION);
      const identity = database
        .prepare("SELECT instance_id FROM council_identity WHERE singleton = 1")
        .get() as unknown as { instance_id: string };
      assert.match(identity.instance_id, /^[0-9a-f-]{36}$/u);
      const before = database
        .prepare("SELECT value FROM council_meta WHERE key = 'content_revision'")
        .get() as unknown as { value: number };
      database.prepare(`
        INSERT INTO topics (
          id, title, question, constraints_json, project_path,
          status, created_by, created_at, updated_at
        ) VALUES ('topic_trigger_probe', 'probe', 'probe', '[]', NULL, 'open', 'human', ?, ?)
      `).run(new Date().toISOString(), new Date().toISOString());
      const after = database
        .prepare("SELECT value FROM council_meta WHERE key = 'content_revision'")
        .get() as unknown as { value: number };
      assert.equal(after.value, before.value + 1);
    } finally {
      database.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("legacy DB 保留行数并生成已验证同目录 backup，重复打开只验证", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  try {
    const migrated = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.equal(migrated.migrated, true);
    assert.ok(migrated.backupPath);
    assert.equal(path.dirname(migrated.backupPath as string), fixture.directory);
    assert.equal(existsSync(migrated.backupPath as string), true);

    const database = new DatabaseSync(fixture.databasePath);
    const backup = new DatabaseSync(migrated.backupPath as string, { readOnly: true });
    try {
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count,
        1,
      );
      assert.equal(
        (backup.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count,
        1,
      );
      assert.equal(pragmaInteger(backup, "user_version"), 0);
    } finally {
      backup.close();
      database.close();
    }

    const beforeReopen = new DatabaseSync(fixture.databasePath);
    const revisionBefore = beforeReopen
      .prepare("SELECT key, value FROM council_meta ORDER BY key")
      .all();
    beforeReopen.close();
    const reopened = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
    });
    assert.deepEqual(reopened, {
      migrated: false,
      version: COUNCIL_SCHEMA_VERSION,
    });
    const afterReopen = new DatabaseSync(fixture.databasePath);
    try {
      assert.deepEqual(
        afterReopen.prepare("SELECT key, value FROM council_meta ORDER BY key").all(),
        revisionBefore,
      );
    } finally {
      afterReopen.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("事务内故障优先 rollback，不用较旧 backup 覆盖健康活库", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  try {
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, {
        maxAttempts: 3,
        faultPoint: "before-commit",
      }),
      /故障注入/,
    );
    const database = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(pragmaInteger(database, "user_version"), 0);
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count,
        1,
      );
      const migrationTables = database
        .prepare(`
          SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type = 'table' AND name = 'schema_migrations'
        `)
        .get() as unknown as { count: number };
      assert.equal(migrationTables.count, 0);
    } finally {
      database.close();
    }
    assert.ok(readdirSync(fixture.directory).some((name) => name.endsWith(".backup")));
  } finally {
    fixture.cleanup();
  }
});

test("账本/user_version 不一致及未来版本均 fail closed", async () => {
  const mismatch = temporaryDatabase();
  const future = temporaryDatabase();
  const gap = temporaryDatabase();
  try {
    const mismatchDatabase = new DatabaseSync(mismatch.databasePath);
    mismatchDatabase.exec("PRAGMA user_version = 1;");
    mismatchDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(mismatch.databasePath, 5_000, { maxAttempts: 3 }),
      /不一致/,
    );

    const futureDatabase = new DatabaseSync(future.databasePath);
    futureDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES
        (1, 'initial', '2026-01-01T00:00:00.000Z'),
        (2, 'future', '2026-01-02T00:00:00.000Z');
      PRAGMA user_version = 2;
    `);
    futureDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(future.databasePath, 5_000, { maxAttempts: 3 }),
      /更高版本/,
    );

    const gapDatabase = new DatabaseSync(gap.databasePath);
    gapDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES
        (1, 'initial', '2026-01-01T00:00:00.000Z'),
        (3, 'gap', '2026-01-03T00:00:00.000Z');
      PRAGMA user_version = 3;
    `);
    gapDatabase.close();
    await assert.rejects(
      migrateCouncilSchema(gap.databasePath, 5_000, { maxAttempts: 3 }),
      /账本不连续/,
    );
  } finally {
    mismatch.cleanup();
    future.cleanup();
    gap.cleanup();
  }
});

test("backup 后持续外部提交会按配置耗尽尝试且不丢写", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  let writes = 0;
  try {
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, {
        maxAttempts: 2,
        testAfterSnapshotPrepared: () => {
          writes += 1;
          const external = new DatabaseSync(fixture.databasePath);
          try {
            external.prepare(`
              INSERT INTO topics (
                id, title, question, constraints_json, project_path,
                status, created_by, created_at, updated_at
              ) VALUES (?, 'external', 'external', '[]', NULL, 'open', 'human', ?, ?)
            `).run(
              `topic_external_${String(writes)}`,
              new Date().toISOString(),
              new Date().toISOString(),
            );
          } finally {
            external.close();
          }
        },
      }),
      /持续变化/,
    );
    const database = new DatabaseSync(fixture.databasePath);
    try {
      const count = database
        .prepare("SELECT COUNT(*) AS count FROM topics")
        .get() as unknown as { count: number };
      assert.equal(count.count, 3);
      assert.equal(pragmaInteger(database, "user_version"), 0);
    } finally {
      database.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("已标 v1 但 trigger 定义为空时按 canonical schema fail closed", async () => {
  const fixture = temporaryDatabase();
  try {
    await migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 });
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.exec(`
        DROP TRIGGER trg_messages_revision_insert;
        CREATE TRIGGER trg_messages_revision_insert
          AFTER INSERT ON messages BEGIN
            SELECT 1;
          END;
      `);
    } finally {
      database.close();
    }
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 5_000, { maxAttempts: 3 }),
      /schema 定义不兼容/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("首次空库在重试前被外部创建后会备份并保留新数据", async () => {
  const fixture = temporaryDatabase();
  let attempt = 0;
  try {
    const result = await migrateCouncilSchema(fixture.databasePath, 5_000, {
      maxAttempts: 3,
      testAfterSnapshotPrepared: () => {
        attempt += 1;
        if (attempt !== 1) {
          return;
        }
        createLegacyDatabase(fixture.databasePath, "topic_created_between_attempts");
      },
    });
    assert.equal(attempt, 2);
    assert.equal(result.migrated, true);
    assert.ok(result.backupPath);
    const database = new DatabaseSync(fixture.databasePath);
    const backup = new DatabaseSync(result.backupPath as string, { readOnly: true });
    try {
      for (const connection of [database, backup]) {
        const count = connection
          .prepare(`
            SELECT COUNT(*) AS count FROM topics
            WHERE id = 'topic_created_between_attempts'
          `)
          .get() as unknown as { count: number };
        assert.equal(count.count, 1);
      }
    } finally {
      backup.close();
      database.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("WAL checkpoint 被旧读快照阻塞时停止迁移且不生成 backup", async () => {
  const fixture = temporaryDatabase();
  createLegacyDatabase(fixture.databasePath);
  const setup = new DatabaseSync(fixture.databasePath);
  setup.exec("PRAGMA journal_mode = WAL;");
  setup.close();
  const reader = new DatabaseSync(fixture.databasePath);
  reader.exec("BEGIN;");
  reader.prepare("SELECT * FROM topics").all();
  const writer = new DatabaseSync(fixture.databasePath);
  writer.prepare(`
    INSERT INTO topics (
      id, title, question, constraints_json, project_path,
      status, created_by, created_at, updated_at
    ) VALUES ('topic_after_snapshot', 'writer', 'writer', '[]', NULL, 'open', 'human', ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString());
  writer.close();
  try {
    await assert.rejects(
      migrateCouncilSchema(fixture.databasePath, 50, { maxAttempts: 1 }),
      /WAL checkpoint 未完成/,
    );
    assert.equal(
      readdirSync(fixture.directory).some((name) => name.endsWith(".backup")),
      false,
    );
  } finally {
    reader.exec("ROLLBACK;");
    reader.close();
    fixture.cleanup();
  }
});
