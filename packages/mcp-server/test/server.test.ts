/**
 * @input  依赖：内存 MCP 传输、临时数据库与 createCouncilServer
 * @output 导出：工具发现、创建、发布和读取的协议测试
 * @pos    Codex App 与 Claude Desktop 客户端兼容性的端到端验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCouncilServer } from "../src/server.js";
import type { CouncilConfig } from "../src/types.js";

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
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
    claudeMaxTurns: 3,
    sqliteBusyTimeoutMs: 5_000,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
  };
  const bundle = createCouncilServer(config);
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
