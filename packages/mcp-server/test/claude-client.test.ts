/**
 * @input  依赖：假 Claude 进程、临时数据库与 ClaudeClient
 * @output 导出：版本检查、首次调用和 session 恢复测试
 * @pos    后台顾问适配器的无模型费用集成验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ClaudeClient } from "../src/claude-client.js";
import {
  ClaudeRuntime,
  type ClaudeRuntimeInput,
} from "../src/claude-runtime.js";
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

const HANGING_CLAUDE_SOURCE = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`;

class FakeRuntime {
  readonly calls: ClaudeRuntimeInput[] = [];

  constructor(private readonly response: { content: string; sessionId?: string }) {}

  async generate(input: ClaudeRuntimeInput): Promise<{ content: string; sessionId?: string }> {
    this.calls.push(input);
    return this.response;
  }

  async checkAvailability(): Promise<{ available: boolean; authenticated: boolean }> {
    return { available: true, authenticated: true };
  }
}

async function waitForPid(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(pidFile)) {
      return Number(readFileSync(pidFile, "utf8"));
    }
    await delay(5);
  }
  throw new Error("假 Claude 进程没有按时写入 PID。");
}

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
    claudeKillGraceMs: 100,
    claudeMaxTurns: 3,
    codexCommand: process.execPath,
    codexArgs: [],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    kimiCommand: process.execPath,
    acpStartupTimeoutMs: 5_000,
    acpKillGraceMs: 50,
    acpMaxFileReadChars: 10_000,
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
  };
  const database = await CouncilDatabase.open(
    config.databasePath,
    config.sqliteBusyTimeoutMs,
    { maxAttempts: config.schemaMigrationMaxAttempts },
  );
  try {
    const topic = database.createTopic({
      title: "测试议题",
      question: "如何验证会话恢复？",
      constraints: [],
      projectPath: directory,
      createdByAlias: "human",
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

test("ClaudeClient 取消生成时不写 session 或消息", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-claude-abort-test-"));
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
    kimiCommand: process.execPath,
    acpStartupTimeoutMs: 5_000,
    acpKillGraceMs: 50,
    acpMaxFileReadChars: 10_000,
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
  };
  const database = await CouncilDatabase.open(
    config.databasePath,
    config.sqliteBusyTimeoutMs,
    { maxAttempts: config.schemaMigrationMaxAttempts },
  );
  try {
    const topic = database.createTopic({
      title: "取消测试",
      question: "取消后是否保持数据库不变？",
      constraints: [],
      projectPath: directory,
      createdByAlias: "human",
    });
    const controller = new AbortController();
    const request = new ClaudeClient(config, database).ask({
      topicId: topic.id,
      instruction: "保持运行直到被取消",
      messageKind: "proposal",
      forceNewSession: false,
      signal: controller.signal,
    });
    await waitForPid(pidFile);
    controller.abort(new Error("private cancellation reason"));
    await assert.rejects(request, {
      name: "AbortError",
      message: "Claude Code 调用已取消。",
    });
    assert.equal(database.getAgentSession(topic.id, "claude"), undefined);
    assert.equal(database.getTopicDetail(topic.id, 20).messages.length, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeClient 拒绝数据库中绕过入口校验的相对项目路径", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-claude-path-test-"));
  const config: CouncilConfig = {
    dataDir: directory,
    databasePath: path.join(directory, "council.sqlite3"),
    claudeCommand: process.execPath,
    claudeArgs: ["--version"],
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
    acpStartupTimeoutMs: 5_000,
    acpKillGraceMs: 50,
    acpMaxFileReadChars: 10_000,
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
  };
  const database = await CouncilDatabase.open(
    config.databasePath,
    config.sqliteBusyTimeoutMs,
    { maxAttempts: config.schemaMigrationMaxAttempts },
  );
  try {
    const topic = database.createTopic({
      title: "路径校验测试",
      question: "兼容层是否再次校验数据库中的路径？",
      constraints: [],
      projectPath: "relative-project",
      createdByAlias: "human",
    });
    await assert.rejects(
      new ClaudeClient(config, database).ask({
        topicId: topic.id,
        instruction: "不应启动 CLI",
        messageKind: "proposal",
        forceNewSession: false,
      }),
      /项目路径必须是绝对路径/,
    );
    assert.equal(database.getTopicDetail(topic.id, 20).messages.length, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeClient 可信议题超限时不调用 Runtime 且数据库零写入", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-client-trusted-overflow-"));
  const config: CouncilConfig = {
    dataDir: directory,
    databasePath: path.join(directory, "council.sqlite3"),
    claudeCommand: process.execPath,
    claudeArgs: [],
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
    acpStartupTimeoutMs: 5_000,
    acpKillGraceMs: 50,
    acpMaxFileReadChars: 10_000,
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
    maxContextChars: 120,
    maxOutputChars: 40_000,
    defaultMessageLimit: 20,
  };
  const database = await CouncilDatabase.open(
    config.databasePath,
    config.sqliteBusyTimeoutMs,
    { maxAttempts: config.schemaMigrationMaxAttempts },
  );
  const runtime = new FakeRuntime({ content: "不应返回", sessionId: "session_forbidden" });
  try {
    const topic = database.createTopic({
      title: "t".repeat(500),
      question: "可信头是否会被裁掉？",
      constraints: [],
      projectPath: directory,
      createdByAlias: "human",
    });
    await assert.rejects(
      new ClaudeClient(config, database, runtime as unknown as ClaudeRuntime).ask({
        topicId: topic.id,
        instruction: "保留本轮任务",
        messageKind: "proposal",
        forceNewSession: false,
      }),
      /可信议题与本轮任务超过上下文上限/,
    );
    assert.equal(runtime.calls.length, 0);
    assert.equal(database.getAgentSession(topic.id, "claude"), undefined);
    assert.equal(database.getTopicDetail(topic.id, 20).messageTotal, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeClient 超长公开输出不推进 session 且不写消息", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-client-output-limit-"));
  const config: CouncilConfig = {
    dataDir: directory,
    databasePath: path.join(directory, "council.sqlite3"),
    claudeCommand: process.execPath,
    claudeArgs: [],
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
    acpStartupTimeoutMs: 5_000,
    acpKillGraceMs: 50,
    acpMaxFileReadChars: 10_000,
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
    maxOutputChars: 40_000,
    defaultMessageLimit: 20,
  };
  const database = await CouncilDatabase.open(
    config.databasePath,
    config.sqliteBusyTimeoutMs,
    { maxAttempts: config.schemaMigrationMaxAttempts },
  );
  const runtime = new FakeRuntime({
    content: "x".repeat(30_001),
    sessionId: "session_must_not_advance",
  });
  try {
    const topic = database.createTopic({
      title: "输出上限",
      question: "超长回复能否污染会话？",
      constraints: [],
      projectPath: directory,
      createdByAlias: "human",
    });
    await assert.rejects(
      new ClaudeClient(config, database, runtime as unknown as ClaudeRuntime).ask({
        topicId: topic.id,
        instruction: "生成公开回复",
        messageKind: "proposal",
        forceNewSession: false,
      }),
      /超过消息长度上限/,
    );
    assert.equal(database.getAgentSession(topic.id, "claude"), undefined);
    assert.equal(database.getTopicDetail(topic.id, 20).messageTotal, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
