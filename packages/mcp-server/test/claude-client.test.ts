/**
 * @input  依赖：假 Claude 进程、临时数据库与 ClaudeClient
 * @output 导出：版本检查、首次调用和 session 恢复测试
 * @pos    后台顾问适配器的无模型费用集成验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeClient } from "../src/claude-client.js";
import { CouncilDatabase } from "../src/database.js";
import type { CouncilConfig } from "../src/types.js";

const FAKE_CLAUDE_SOURCE = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    process.stdout.write("fake-claude 1.0.0\\n");
    return;
  }
  if (args.includes("auth") && args.includes("status")) {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "test" }));
    return;
  }
  const resumeIndex = args.indexOf("--resume");
  const resumed = resumeIndex >= 0 ? args[resumeIndex + 1] : "none";
  const result = input.includes("第二轮") ? "fake-rebuttal" : "fake-proposal";
  process.stdout.write(JSON.stringify({
    result: result + ";resume=" + resumed,
    session_id: "session_fake",
    model: "fake-model",
    is_error: false
  }));
});
`;

test("ClaudeClient 调用并恢复后台顾问会话", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-claude-test-"));
  const fakeClaudePath = path.join(directory, "fake-claude.mjs");
  writeFileSync(fakeClaudePath, FAKE_CLAUDE_SOURCE, { mode: 0o700 });
  const config: CouncilConfig = {
    dataDir: directory,
    databasePath: path.join(directory, "council.sqlite3"),
    claudeCommand: process.execPath,
    claudeArgs: [fakeClaudePath],
    claudePermissionMode: "plan",
    claudeTimeoutMs: 5_000,
    claudeMaxTurns: 3,
    sqliteBusyTimeoutMs: 5_000,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
  };
  const database = new CouncilDatabase(config.databasePath, config.sqliteBusyTimeoutMs);
  try {
    const topic = database.createTopic({
      title: "测试议题",
      question: "如何验证会话恢复？",
      constraints: [],
      projectPath: directory,
      createdBy: "human",
    });
    const client = new ClaudeClient(config, database);
    const availability = await client.checkAvailability();
    assert.equal(availability.available, true);
    assert.equal(availability.authenticated, true);
    assert.match(availability.version ?? "", /fake-claude/);

    const first = await client.ask({
      topicId: topic.id,
      instruction: "提出第一轮方案",
      messageKind: "proposal",
      forceNewSession: false,
    });
    assert.match(first.response.content, /fake-proposal;resume=none/);
    assert.equal(database.getAgentSession(topic.id, "claude"), "session_fake");

    const second = await client.ask({
      topicId: topic.id,
      instruction: "第二轮回应批评",
      messageKind: "rebuttal",
      forceNewSession: false,
    });
    assert.match(second.response.content, /fake-rebuttal;resume=session_fake/);
    assert.equal(database.getTopicDetail(topic.id, 20).messages.length, 2);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
