/**
 * @input  依赖：临时 SQLite 数据文件与 CouncilDatabase
 * @output 导出：共享存储、分页、决策和会话状态测试
 * @pos    数据一致性与双客户端并发基础的单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteCouncilStore } from "council-orchestrator";
import { CouncilDatabase } from "../src/database.js";

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
      createdBy: "human",
    });
    const first = database.createMessage({
      topicId: topic.id,
      author: "claude",
      kind: "proposal",
      content: "采用方案 A。",
    });
    const second = database.createMessage({
      topicId: topic.id,
      author: "codex",
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
      createdBy: "human",
    });
    assert.equal(decision.status, "accepted");
    assert.equal(database.getTopic(topic.id).status, "decided");

    database.setAgentSession(topic.id, "claude", "session-test");
    assert.equal(database.getAgentSession(topic.id, "claude"), "session-test");
    assert.equal(database.deleteAgentSession(topic.id, "claude"), true);
    assert.equal(database.getAgentSession(topic.id, "claude"), undefined);

    const page = database.listTopics({ projectPath: directory, limit: 10, offset: 0 });
    assert.equal(page.total, 1);
    assert.equal(page.topics[0]?.id, topic.id);
    assert.deepEqual(database.getCounts(), { topics: 1, messages: 2, decisions: 1 });
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
      createdBy: "claude",
    });
    assert.equal(codexSide.getTopic(topic.id).title, "双桌面共享");

    codexSide.createMessage({
      topicId: topic.id,
      author: "codex",
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
      createdBy: "human",
    });
    const beforeContent = database.getRevisions();
    database.createMessage({
      topicId: topic.id,
      author: "human",
      kind: "note",
      content: "内容变更。",
    });
    const afterContent = database.getRevisions();
    assert.ok(afterContent.total > beforeContent.total);
    assert.ok(afterContent.content > beforeContent.content);
    assert.equal(afterContent.orchestration, beforeContent.orchestration);

    const run = await store.createRun({
      topicId: topic.id,
      plan: [{
        adapterId: "fake",
        publicAuthor: "claude",
        messageKind: "proposal",
        instruction: "测试 revision",
      }],
      policy: {
        maxRounds: 1,
        allowedAgents: ["fake"],
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
