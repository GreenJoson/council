/**
 * @input  依赖：内存 MCP 传输、临时数据库与 createCouncilServer
 * @output 导出：绑定调用者身份、禁止 MCP 接受决策、共享读写与请求取消的协议测试
 * @pos    Codex App 与 Claude Desktop 客户端兼容性的端到端验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CouncilDatabase } from "../src/database.js";
import { createCouncilServer } from "../src/server.js";
import type { McpCouncilConfig } from "../src/types.js";

const HANGING_CLAUDE_SOURCE = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`;

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

async function waitForPid(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(pidFile)) {
      return Number(readFileSync(pidFile, "utf8"));
    }
    await delay(5);
  }
  throw new Error("假 Claude 进程没有按时写入 PID。");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(10);
  }
  throw new Error("MCP 取消后 Claude 进程没有按时退出。");
}

test("MCP 客户端可发现并组合 Council 工具", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-server-test-"));
  const config: McpCouncilConfig = {
    dataDir: directory,
    databasePath: path.join(directory, "council.sqlite3"),
    claudeCommand: process.execPath,
    claudeArgs: ["--version"],
    claudePermissionMode: "plan",
    claudeTimeoutMs: 5_000,
    claudeKillGraceMs: 100,
    claudeMaxTurns: 3,
    codexCommand: process.execPath,
    codexArgs: [],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    kimiCommand: process.execPath,
    kimiStartupTimeoutMs: 5_000,
    kimiKillGraceMs: 50,
    kimiMaxFileReadChars: 10_000,
    toolLoopMaxSteps: 4,
    toolLoopMaxContextChars: 20_000,
    toolLoopMaxFileBytes: 10_000,
    toolLoopMaxScanFiles: 100,
    gitCommand: "git",
    gitDiffTimeoutMs: 5_000,
    gitDiffKillGraceMs: 50,
    gitDiffMaxFiles: 20,
    gitDiffMaxLines: 200,
    gitDiffMaxHunksPerFile: 20,
    gitDiffMaxOutputChars: 10_000,
    sqliteBusyTimeoutMs: 5_000,
    schemaMigrationMaxAttempts: 3,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
    callerActorAlias: "codex",
  };
  const bundle = await createCouncilServer(config);
  const client = new Client({ name: "council-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      bundle.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("council_create_topic"));
    assert.ok(names.includes("council_ask_claude"));
    assert.ok(names.includes("council_get_topic"));
    for (const toolName of [
      "council_create_topic",
      "council_post_message",
      "council_record_decision",
    ]) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      const serializedSchema = JSON.stringify(tool?.inputSchema ?? {});
      assert.doesNotMatch(serializedSchema, /actor_alias|created_by_alias|status/u);
    }

    const created = await client.callTool({
      name: "council_create_topic",
      arguments: {
        title: "协议测试",
        question: "两个客户端能否共享议题？",
        constraints: ["不能复制粘贴"],
        project_path: directory,
      },
    });
    assert.equal(created.isError, undefined);
    const topic = asRecord(asRecord(created.structuredContent).topic);
    const topicId = topic.id;
    assert.equal(typeof topicId, "string");

    const posted = await client.callTool({
      name: "council_post_message",
      arguments: {
        topic_id: topicId,
        kind: "proposal",
        content: "共享 SQLite 作为公开讨论层。",
      },
    });
    assert.equal(posted.isError, undefined);

    const fetched = await client.callTool({
      name: "council_get_topic",
      arguments: { topic_id: topicId },
    });
    assert.equal(fetched.isError, undefined);
    const structured = asRecord(fetched.structuredContent);
    assert.equal(structured.messageTotal, 1);
    assert.equal(Array.isArray(structured.messages), true);
    assert.equal(topic.createdByActorId, "codex");
    const messages = structured.messages as unknown[];
    assert.equal(asRecord(messages[0]).actorId, "codex");

    const proposed = await client.callTool({
      name: "council_record_decision",
      arguments: {
        topic_id: topicId,
        title: "仅可提案",
        decision: "由用户从 HTTP 或桌面入口确认。",
        rationale: "MCP 调用者不能伪造 human。",
        alternatives: [],
        status: "accepted",
        created_by_alias: "human",
      },
    });
    assert.equal(proposed.isError, undefined);
    const decision = asRecord(asRecord(proposed.structuredContent).decision);
    assert.equal(decision.status, "proposed");
    assert.equal(decision.createdByActorId, "codex");
  } finally {
    await client.close();
    await bundle.server.close();
    bundle.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP 调用者冻结 actorId，运行中 alias 重绑或同名 alias 不能劫持身份", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-caller-identity-test-"));
  const databasePath = path.join(directory, "council.sqlite3");
  const bootstrap = await CouncilDatabase.open(databasePath, 5_000, { maxAttempts: 3 });
  bootstrap.close();
  const now = new Date().toISOString();
  const setup = new DatabaseSync(databasePath);
  try {
    const insertActor = setup.prepare(`
      INSERT INTO actor_identities (
        id, slug, display_name, short_name, role,
        actor_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'agent', 'active', ?, ?)
    `);
    insertActor.run("actor-a", "provider-a", "Provider A", "PA", "调用者 A", now, now);
    insertActor.run("actor-b", "provider-b", "Provider B", "PB", "调用者 B", now, now);
    const insertAlias = setup.prepare(`
      INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
      VALUES (?, ?, 'adapter', ?)
    `);
    insertAlias.run("caller-a", "actor-a", now);
    insertAlias.run("actor-a", "actor-b", now);
  } finally {
    setup.close();
  }

  const config: McpCouncilConfig = {
    dataDir: directory,
    databasePath,
    claudeCommand: process.execPath,
    claudeArgs: ["--version"],
    claudePermissionMode: "plan",
    claudeTimeoutMs: 5_000,
    claudeKillGraceMs: 100,
    claudeMaxTurns: 3,
    codexCommand: process.execPath,
    codexArgs: [],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    kimiCommand: process.execPath,
    kimiStartupTimeoutMs: 5_000,
    kimiKillGraceMs: 50,
    kimiMaxFileReadChars: 10_000,
    toolLoopMaxSteps: 4,
    toolLoopMaxContextChars: 20_000,
    toolLoopMaxFileBytes: 10_000,
    toolLoopMaxScanFiles: 100,
    gitCommand: "git",
    gitDiffTimeoutMs: 5_000,
    gitDiffKillGraceMs: 50,
    gitDiffMaxFiles: 20,
    gitDiffMaxLines: 200,
    gitDiffMaxHunksPerFile: 20,
    gitDiffMaxOutputChars: 10_000,
    sqliteBusyTimeoutMs: 5_000,
    schemaMigrationMaxAttempts: 3,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
    callerActorAlias: "caller-a",
  };
  const bundle = await createCouncilServer(config);
  const client = new Client({ name: "caller-identity-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const rebind = new DatabaseSync(databasePath);
    try {
      rebind.prepare(`
        UPDATE actor_aliases SET actor_id = 'actor-b'
        WHERE alias = 'caller-a'
      `).run();
    } finally {
      rebind.close();
    }
    await Promise.all([
      bundle.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const created = await client.callTool({
      name: "council_create_topic",
      arguments: {
        title: "稳定调用者身份",
        question: "Alias 变化能否劫持已启动 MCP？",
        constraints: [],
        project_path: directory,
      },
    });
    assert.equal(created.isError, undefined);
    const topic = asRecord(asRecord(created.structuredContent).topic);
    const topicId = String(topic.id);
    assert.equal(topic.createdByActorId, "actor-a");

    const posted = await client.callTool({
      name: "council_post_message",
      arguments: {
        topic_id: topicId,
        kind: "proposal",
        content: "调用者继续保持 Actor A。",
      },
    });
    assert.equal(posted.isError, undefined);
    assert.equal(
      asRecord(asRecord(posted.structuredContent).message).actorId,
      "actor-a",
    );

    const proposed = await client.callTool({
      name: "council_record_decision",
      arguments: {
        topic_id: topicId,
        title: "冻结调用者",
        decision: "按启动时解析出的 actorId 写入。",
        rationale: "Alias 是查找入口，不是持久身份。",
        alternatives: [],
      },
    });
    assert.equal(proposed.isError, undefined);
    assert.equal(
      asRecord(asRecord(proposed.structuredContent).decision).createdByActorId,
      "actor-a",
    );

    const deactivate = new DatabaseSync(databasePath);
    try {
      deactivate.prepare(`
        UPDATE actor_identities SET status = 'inactive'
        WHERE id = 'actor-a'
      `).run();
    } finally {
      deactivate.close();
    }
    const rejected = await client.callTool({
      name: "council_post_message",
      arguments: {
        topic_id: topicId,
        kind: "note",
        content: "停用后不得继续写入。",
      },
    });
    assert.equal(rejected.isError, true);
    assert.equal(bundle.database.getTopicDetail(topicId, 20).messages.length, 1);
  } finally {
    await client.close();
    await bundle.server.close();
    bundle.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP 取消 council_ask_claude 会终止进程且不写共享数据库", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-server-abort-test-"));
  const fakeClaudePath = path.join(directory, "hanging-claude.mjs");
  const pidFile = path.join(directory, "claude.pid");
  writeFileSync(fakeClaudePath, HANGING_CLAUDE_SOURCE, { mode: 0o700 });
  const config: McpCouncilConfig = {
    dataDir: directory,
    databasePath: path.join(directory, "council.sqlite3"),
    claudeCommand: process.execPath,
    claudeArgs: [fakeClaudePath, pidFile],
    claudePermissionMode: "plan",
    claudeTimeoutMs: 5_000,
    claudeKillGraceMs: 50,
    claudeMaxTurns: 3,
    codexCommand: process.execPath,
    codexArgs: [],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    kimiCommand: process.execPath,
    kimiStartupTimeoutMs: 5_000,
    kimiKillGraceMs: 50,
    kimiMaxFileReadChars: 10_000,
    toolLoopMaxSteps: 4,
    toolLoopMaxContextChars: 20_000,
    toolLoopMaxFileBytes: 10_000,
    toolLoopMaxScanFiles: 100,
    gitCommand: "git",
    gitDiffTimeoutMs: 5_000,
    gitDiffKillGraceMs: 50,
    gitDiffMaxFiles: 20,
    gitDiffMaxLines: 200,
    gitDiffMaxHunksPerFile: 20,
    gitDiffMaxOutputChars: 10_000,
    sqliteBusyTimeoutMs: 5_000,
    schemaMigrationMaxAttempts: 3,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
    callerActorAlias: "codex",
  };
  const bundle = await createCouncilServer(config);
  const client = new Client({ name: "council-abort-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let pid: number | undefined;
  try {
    await Promise.all([
      bundle.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const topic = bundle.database.createTopic({
      title: "协议取消测试",
      question: "MCP 取消是否传递到后台进程？",
      constraints: [],
      projectPath: directory,
      createdByAlias: "human",
    });
    const controller = new AbortController();
    const request = client.callTool(
      {
        name: "council_ask_claude",
        arguments: {
          topic_id: topic.id,
          instruction: "保持运行直到请求取消",
          message_kind: "proposal",
          force_new_session: false,
        },
      },
      undefined,
      { signal: controller.signal, timeout: 5_000 },
    );
    const cancelled = assert.rejects(request, /AbortError|aborted/i);
    pid = await waitForPid(pidFile);
    controller.abort();
    await cancelled;
    await waitForProcessGone(pid);
    assert.equal(bundle.database.getAgentSession(topic.id, "claude"), undefined);
    assert.equal(bundle.database.getTopicDetail(topic.id, 20).messages.length, 0);
  } finally {
    if (pid !== undefined && isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
      await waitForProcessGone(pid);
    }
    await client.close();
    await bundle.server.close();
    bundle.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
