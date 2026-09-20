/**
 * @input  依赖：临时 SQLite 数据文件与 CouncilDatabase
 * @output 导出：共享存储、议题更正/关闭、分页、决策实施项、乐观并发和会话状态测试
 * @pos    数据一致性与双客户端并发基础的单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SQLiteCouncilStore } from "council-orchestrator";
import { CouncilDatabase } from "../src/database.js";

test("议题只可在 open 状态乐观更正，关闭保留记录并停用会话", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-topic-lifecycle-"));
  const database = await CouncilDatabase.open(
    path.join(directory, "council.sqlite3"),
    5_000,
    { maxAttempts: 3 },
  );
  try {
    const created = database.createTopic({
      title: "待更正议题",
      question: "错误正文",
      constraints: [],
      createdByAlias: "human",
    });
    const corrected = database.updateTopicAsActor({
      topicId: created.id,
      question: "精炼后的问题框架",
      constraints: ["详细分析另发消息"],
      expectedUpdatedAt: created.updatedAt,
      actorId: "codex",
    });
    assert.equal(corrected.question, "精炼后的问题框架");
    assert.deepEqual(corrected.constraints, ["详细分析另发消息"]);
    assert.throws(
      () => database.updateTopicAsActor({
        topicId: created.id,
        title: "过期覆盖",
        expectedUpdatedAt: created.updatedAt,
        actorId: "claude",
      }),
      /其他参与者更新/,
    );
    database.setAgentSession(created.id, "claude", "session-before-close");
    const closed = database.closeTopicAsActor({ topicId: created.id, actorId: "human" });
    assert.equal(closed.status, "closed");
    assert.equal(database.getAgentSession(created.id, "claude"), undefined);
    assert.equal(database.getTopicDetail(created.id, 20).topic.question, "精炼后的问题框架");
    assert.throws(
      () => database.updateTopicAsActor({
        topicId: created.id,
        question: "关闭后不可改写",
        expectedUpdatedAt: closed.updatedAt,
        actorId: "codex",
      }),
      /已结束/,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CouncilDatabase 保存并分页读取共享讨论", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-db-test-"));
  const database = await CouncilDatabase.open(
    path.join(directory, "council.sqlite3"),
    5_000,
    { maxAttempts: 3 },
  );
  try {
    const topic = database.createTopic({
      title: "认证架构",
      question: "选择会话方案",
      constraints: ["必须可回滚"],
      projectPath: directory,
      createdByAlias: "human",
    });
    const first = database.createMessage({
      topicId: topic.id,
      actorAlias: "claude",
      kind: "proposal",
      content: "采用方案 A。",
    });
    const second = database.createMessage({
      topicId: topic.id,
      actorAlias: "codex",
      kind: "critique",
      content: "方案 A 缺少回滚路径。",
      parentMessageId: first.id,
    });

    const latestPage = database.getTopicDetail(topic.id, 1);
    assert.equal(latestPage.messageTotal, 2);
    assert.equal(latestPage.messages[0]?.id, second.id);
    assert.equal(latestPage.hasMoreMessages, true);
    assert.equal(latestPage.nextMessageOffset, 1);

    const olderPage = database.getTopicDetail(topic.id, 1, 1);
    assert.equal(olderPage.messages[0]?.id, first.id);
    assert.equal(olderPage.hasMoreMessages, false);

    const decision = database.createDecision({
      topicId: topic.id,
      title: "先保持单体会话",
      decision: "采用可替换的单体会话服务。",
      rationale: "迁移成本更低。",
      alternatives: ["立即拆分独立认证服务"],
      status: "accepted",
      createdByAlias: "human",
    });
    assert.equal(decision.status, "accepted");
    assert.equal(database.getTopic(topic.id).status, "decided");

    const workItems = database.createWorkItems({
      topicId: topic.id,
      items: [
        { title: "实现会话适配层", details: "覆盖替换路径" },
        { title: "补齐回滚测试" },
      ],
      createdByAlias: "codex",
    });
    assert.equal(workItems.length, 2);
    assert.equal(workItems[0]?.decisionId, decision.id);
    assert.equal(workItems[0]?.status, "pending");
    const completed = database.updateWorkItem({
      topicId: topic.id,
      workItemId: workItems[0]?.id ?? "",
      status: "completed",
      statusNote: "实现与测试已通过。",
      expectedVersion: 1,
      updatedByAlias: "claude",
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.version, 2);
    assert.equal(completed.updatedByActorId, "claude");
    assert.ok(completed.completedAt);
    assert.throws(
      () => database.updateWorkItem({
        topicId: topic.id,
        workItemId: completed.id,
        status: "blocked",
        expectedVersion: 1,
        updatedByAlias: "codex",
      }),
      /其他参与者更新/,
    );
    assert.equal(database.getTopicDetail(topic.id, 20).workItems.length, 2);

    database.setAgentSession(topic.id, "claude", "session-test");
    assert.equal(database.getAgentSession(topic.id, "claude"), "session-test");
    database.setAgentSession(topic.id, "claude-code", "session-replaced");
    assert.equal(database.getAgentSession(topic.id, "claude"), "session-replaced");
    const sessionInspection = new DatabaseSync(path.join(directory, "council.sqlite3"));
    try {
      assert.deepEqual(
        sessionInspection.prepare(`
          SELECT session_id, is_current
          FROM agent_sessions
          WHERE topic_id = ? AND actor_id = 'claude'
          ORDER BY updated_at, rowid
        `).all(topic.id).map((row) => ({ ...row })),
        [
          { session_id: "session-test", is_current: 0 },
          { session_id: "session-replaced", is_current: 1 },
        ],
      );
    } finally {
      sessionInspection.close();
    }
    assert.equal(database.deleteAgentSession(topic.id, "claude"), true);
    assert.equal(database.getAgentSession(topic.id, "claude"), undefined);
    const afterDelete = new DatabaseSync(path.join(directory, "council.sqlite3"));
    try {
      assert.equal(
        (
          afterDelete.prepare(`
            SELECT COUNT(*) AS count
            FROM agent_sessions
            WHERE topic_id = ? AND actor_id = 'claude'
          `).get(topic.id) as { count: number }
        ).count,
        2,
      );
    } finally {
      afterDelete.close();
    }

    const page = database.listTopics({ projectPath: directory, limit: 10, offset: 0 });
    assert.equal(page.total, 1);
    assert.equal(page.topics[0]?.id, topic.id);
    assert.deepEqual(database.getCounts(), { topics: 1, messages: 2, decisions: 1, workItems: 2 });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("两个 MCP 进程可通过同一 SQLite 文件互相读取写入", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-shared-test-"));
  const databasePath = path.join(directory, "council.sqlite3");
  const claudeSide = await CouncilDatabase.open(
    databasePath,
    5_000,
    { maxAttempts: 3 },
  );
  const codexSide = new CouncilDatabase(databasePath, 5_000);
  try {
    const topic = claudeSide.createTopic({
      title: "双桌面共享",
      question: "两个独立 MCP 进程能否看到同一议题？",
      constraints: [],
      projectPath: directory,
      createdByAlias: "claude",
    });
    assert.equal(codexSide.getTopic(topic.id).title, "双桌面共享");

    codexSide.createMessage({
      topicId: topic.id,
      actorAlias: "codex",
      kind: "critique",
      content: "Codex 侧写回消息。",
    });
    const detail = claudeSide.getTopicDetail(topic.id, 20);
    assert.equal(detail.messages[0]?.content, "Codex 侧写回消息。");
  } finally {
    codexSide.close();
    claudeSide.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("读取内容时拒绝索引 Actor 与冻结快照不一致", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-snapshot-mismatch-"));
  const databasePath = path.join(directory, "council.sqlite3");
  const database = await CouncilDatabase.open(databasePath, 5_000, { maxAttempts: 3 });
  try {
    const topic = database.createTopic({
      title: "快照边界",
      question: "历史身份是否可被篡改？",
      constraints: [],
      createdByAlias: "human",
    });
    const message = database.createMessage({
      topicId: topic.id,
      actorAlias: "claude",
      kind: "proposal",
      content: "保持冻结身份。",
    });
    const raw = new DatabaseSync(databasePath);
    try {
      raw.prepare(`
        UPDATE messages
        SET author_snapshot_json = json_set(author_snapshot_json, '$.actorId', 'codex')
        WHERE id = ?
      `).run(message.id);
    } finally {
      raw.close();
    }
    assert.throws(
      () => database.getTopicDetail(topic.id, 20),
      /Message Actor snapshot 与索引身份不一致/,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("content/orchestration revision 隔离且 lease 心跳不推进任何 revision", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-revision-split-"));
  const databasePath = path.join(directory, "council.sqlite3");
  const database = await CouncilDatabase.open(
    databasePath,
    5_000,
    { maxAttempts: 3 },
  );
  const store = new SQLiteCouncilStore(databasePath, 5_000);
  try {
    const topic = database.createTopic({
      title: "Revision 分域",
      question: "运行状态与内容刷新能否分离？",
      constraints: [],
      createdByAlias: "human",
    });
    const beforeContent = database.getRevisions();
    database.createMessage({
      topicId: topic.id,
      actorAlias: "human",
      kind: "note",
      content: "内容变更。",
    });
    const afterContent = database.getRevisions();
    assert.ok(afterContent.total > beforeContent.total);
    assert.ok(afterContent.content > beforeContent.content);
    assert.equal(afterContent.orchestration, beforeContent.orchestration);

    const binding = await store.ensureRuntimeBinding({
      topicId: topic.id,
      agentId: "claude",
      actorId: "claude",
      providerId: "provider-claude",
      bindingRevision: "test-binding:fake:v1",
      agentConfigRevision: 1,
      providerConfigRevision: 1,
      transportKind: "claude-resume",
      processInstanceId: "revision-test",
    });
    const run = await store.createRun({
      topicId: topic.id,
      plan: [{
        adapterId: "fake",
        actorId: "claude",
        bindingRevision: "test-binding:fake:v1",
        runtimeBindingId: binding.id,
        messageKind: "proposal",
        instruction: "测试 revision",
      }],
      policy: {
        maxRounds: 1,
        allowedAgents: ["fake"],
        agentIdleTimeoutMs: 1_000,
        agentTimeoutMs: 1_000,
        agentCleanupTimeoutMs: 100,
        maxAttemptsPerRound: 1,
        maxManualRecoveries: 0,
        confirmation: { beforeRounds: [], beforeCompletion: false },
      },
    });
    const afterRun = database.getRevisions();
    assert.ok(afterRun.total > afterContent.total);
    assert.equal(afterRun.content, afterContent.content);
    assert.ok(afterRun.orchestration > afterContent.orchestration);

    const running = await store.replaceRun({ ...run, status: "running" }, run.version);
    const beforeLease = database.getRevisions();
    const lease = await store.claimRunLease({
      runId: running.id,
      ownerId: "revision-test",
      ttlMs: 1_000,
    });
    const renewed = await store.renewRunLease({ lease, ttlMs: 2_000 });
    assert.equal(await store.releaseRunLease(renewed), true);
    assert.deepEqual(database.getRevisions(), beforeLease);
  } finally {
    store.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
