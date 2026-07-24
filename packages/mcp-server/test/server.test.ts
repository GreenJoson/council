/**
 * @input  依赖：内存 MCP 传输、临时数据库与 createCouncilServer
 * @output 导出：工具发现、共享读写与请求取消的协议测试
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCouncilServer } from "../src/server.js";
import type { CouncilConfig } from "../src/types.js";

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
  const config: CouncilConfig = {
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
    sqliteBusyTimeoutMs: 5_000,
    schemaMigrationMaxAttempts: 3,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
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

    const created = await client.callTool({
      name: "council_create_topic",
      arguments: {
        title: "协议测试",
        question: "两个客户端能否共享议题？",
        constraints: ["不能复制粘贴"],
        project_path: directory,
        created_by: "human",
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
        author: "claude",
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
  const config: CouncilConfig = {
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
    sqliteBusyTimeoutMs: 5_000,
    schemaMigrationMaxAttempts: 3,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
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
      createdBy: "human",
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
