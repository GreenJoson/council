/**
 * @input  依赖：两个声明式假 ACP Agent、临时项目、AcpDelegatedRuntime 与 CouncilConfig
 * @output 验证：跨定义进程/session 复用、重启恢复、只读文件/Git MCP 桥与权限拒绝
 * @pos    供应商无关 DelegatedRuntime 的真实 stdio ACP 进程边界回归
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AcpDelegatedRuntime,
  type AcpDelegatedRuntimeInput,
} from "../src/acp-delegated-runtime.js";
import {
  AcpRuntimeRegistry,
  type AcpRuntimeDefinition,
} from "../src/acp-runtime-registry.js";
import type { CouncilConfig } from "../src/types.js";

const FAKE_KIMI = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const logPath = process.env.FAKE_KIMI_LOG;
const readPath = process.env.FAKE_KIMI_READ_PATH;
const log = (value) => appendFileSync(logPath, JSON.stringify(value) + "\n");
const lineReader = readline.createInterface({ input: process.stdin });
let promptRequest;
let step = "idle";
let requestId = 700;

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const request = (method, params) => {
  const id = requestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return id;
};
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const selectedOption = (message) =>
  message.result?.outcome?.outcome === "selected"
    ? message.result.outcome.optionId
    : undefined;
const requestGitPermission = () => {
  step = "git-permission";
  request("session/request_permission", {
    sessionId: "fake-kimi-session",
    toolCall: {
      toolCallId: "git-call",
      title: "Read committed diff",
      name: "council_git_diff",
      kind: "other",
      status: "pending"
    },
    options: [
      { optionId: "allow-git", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-git", name: "Reject once", kind: "reject_once" }
    ]
  });
};
const requestExecutePermission = () => {
  step = "execute-permission";
  request("session/request_permission", {
    sessionId: "fake-kimi-session",
    toolCall: {
      toolCallId: "execute-call",
      title: "Run shell",
      name: "shell",
      kind: "execute",
      status: "pending"
    },
    options: [
      { optionId: "allow-exec", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-exec", name: "Reject once", kind: "reject_once" }
    ]
  });
};

lineReader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    log({ type: "initialize", argv: process.argv.slice(2) });
    result(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: true }
      },
      authMethods: [],
      agentInfo: { name: "fake-kimi", version: "1" }
    });
    return;
  }
  if (message.method === "session/new") {
    log({ type: "new", cwd: message.params.cwd, mcpServers: message.params.mcpServers });
    result(message.id, { sessionId: "fake-kimi-session" });
    return;
  }
  if (message.method === "session/resume") {
    log({
      type: "resume",
      sessionId: message.params.sessionId,
      mcpServers: message.params.mcpServers
    });
    result(message.id, {});
    return;
  }
  if (message.method === "session/prompt") {
    promptRequest = message;
    log({ type: "prompt", sessionId: message.params.sessionId });
    step = "read-permission";
    request("session/request_permission", {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: "read-call",
        title: "Read source",
        name: "read_file",
        kind: "read",
        status: "pending"
      },
      options: [
        { optionId: "allow-read", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-read", name: "Reject once", kind: "reject_once" }
      ]
    });
    return;
  }
  if (message.method === "session/cancel") {
    if (promptRequest) {
      result(promptRequest.id, { stopReason: "cancelled" });
      promptRequest = undefined;
    }
    return;
  }
  if (
    message.id === undefined
    || (message.result === undefined && message.error === undefined)
  ) {
    return;
  }
  if (step === "read-permission") {
    log({ type: "read-permission", outcome: message.result.outcome });
    if (selectedOption(message) === "allow-read") {
      step = "read-file";
      request("fs/read_text_file", {
        sessionId: "fake-kimi-session",
        path: readPath,
        line: 1,
        limit: 20
      });
    } else {
      requestGitPermission();
    }
    return;
  }
  if (step === "read-file") {
    log(message.error
      ? { type: "read-error", code: message.error.code }
      : { type: "read-result", content: message.result.content });
    requestGitPermission();
    return;
  }
  if (step === "git-permission") {
    log({ type: "git-permission", outcome: message.result.outcome });
    if (selectedOption(message) === "allow-git") {
      notify("session/update", {
        sessionId: "fake-kimi-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "git-call",
          title: "Read committed diff",
          name: "council_git_diff",
          kind: "other",
          status: "pending"
        }
      });
      notify("session/update", {
        sessionId: "fake-kimi-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "git-call",
          title: "Read committed diff",
          name: "council_git_diff",
          kind: "other",
          status: "completed"
        }
      });
    }
    requestExecutePermission();
    return;
  }
  if (step === "execute-permission") {
    log({ type: "execute-permission", outcome: message.result.outcome });
    notify("session/update", {
      sessionId: "fake-kimi-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "公开" }
      }
    });
    notify("session/update", {
      sessionId: "fake-kimi-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "回复" }
      }
    });
    result(promptRequest.id, { stopReason: "end_turn" });
    promptRequest = undefined;
    step = "idle";
  }
});
`;

function config(directory: string, command: string): CouncilConfig {
  return {
    dataDir: directory,
    databasePath: path.join(directory, "unused.sqlite3"),
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
    kimiCommand: command,
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
}

function input(
  definition: AcpRuntimeDefinition,
  bindingId: string,
  cwd: string,
  sessionId?: string,
  grantedCapabilities: AcpDelegatedRuntimeInput["grantedCapabilities"] =
    definition.declaredCapabilities,
): AcpDelegatedRuntimeInput {
  return {
    definition,
    grantedCapabilities,
    bindingId,
    cwd,
    prompt: "只读评审当前项目。",
    model: "k3",
    ...(sessionId ? { sessionId } : {}),
  };
}

function readLog(logPath: string): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runtimeDefinition(
  id: string,
  command: string,
  declaredCapabilities: AcpRuntimeDefinition["declaredCapabilities"] = [
    "text",
    "repository_read",
    "git_diff",
    "session_resume",
  ],
): AcpRuntimeDefinition {
  return new AcpRuntimeRegistry([
    {
      id,
      displayName: id === "kimi-code" ? "Kimi Code" : "Second ACP Agent",
      command,
      versionArgs: ["--version"],
      buildLaunchArgs: ({ cwd, model }) => [
        "--work-dir",
        cwd,
        "--model",
        model,
        "--plan",
        "acp",
      ],
      declaredCapabilities,
      limitationWhenUnavailable: "测试 Agent 当前不可用。",
    },
  ]).require(id);
}

test("通用 ACP Runtime 按定义启动，同 binding 复用 session 且重启后 resume", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-acp-runtime-"));
  const command = path.join(directory, "fake-kimi");
  const logPath = path.join(directory, "fake-kimi.log");
  const sourcePath = path.join(directory, "source.txt");
  writeFileSync(command, FAKE_KIMI);
  chmodSync(command, 0o700);
  writeFileSync(sourcePath, "LOCAL_SOURCE_EVIDENCE");
  process.env.FAKE_KIMI_LOG = logPath;
  process.env.FAKE_KIMI_READ_PATH = sourcePath;
  const definition = runtimeDefinition("kimi-code", command);

  const firstRuntime = new AcpDelegatedRuntime(config(directory, command));
  try {
    const first = await firstRuntime.generate(
      input(definition, "binding-one", directory),
    );
    assert.deepEqual(first, {
      content: "公开回复",
      sessionId: "fake-kimi-session",
    });
    const second = await firstRuntime.generate(
      input(definition, "binding-one", directory, first.sessionId),
    );
    assert.equal(second.content, "公开回复");
    const beforeRestart = readLog(logPath);
    assert.equal(beforeRestart.filter((entry) => entry.type === "initialize").length, 1);
    assert.equal(beforeRestart.filter((entry) => entry.type === "new").length, 1);
    assert.equal(beforeRestart.filter((entry) => entry.type === "prompt").length, 2);
    assert.deepEqual(
      beforeRestart.find((entry) => entry.type === "read-permission")?.outcome,
      { outcome: "selected", optionId: "allow-read" },
    );
    assert.deepEqual(
      beforeRestart.find((entry) => entry.type === "execute-permission")?.outcome,
      { outcome: "selected", optionId: "reject-exec" },
    );
    assert.deepEqual(
      beforeRestart.find((entry) => entry.type === "git-permission")?.outcome,
      { outcome: "selected", optionId: "allow-git" },
    );
    const newSession = beforeRestart.find((entry) => entry.type === "new");
    const mcpServers = newSession?.mcpServers as Array<Record<string, unknown>>;
    assert.equal(mcpServers.length, 1);
    assert.equal(mcpServers[0]?.name, "Council Read-only Git");
    assert.equal(typeof mcpServers[0]?.command, "string");
    assert.ok(Array.isArray(mcpServers[0]?.args));
    assert.ok(Array.isArray(mcpServers[0]?.env));
    assert.equal(
      beforeRestart.find((entry) => entry.type === "read-result")?.content,
      "LOCAL_SOURCE_EVIDENCE",
    );
    const protectedPath = path.join(directory, ".env");
    writeFileSync(protectedPath, "SECRET_SHOULD_NOT_LEAVE_TOOL_HOST");
    process.env.FAKE_KIMI_READ_PATH = protectedPath;
    const protectedResult = await firstRuntime.generate(
      input(definition, "binding-protected", directory),
    );
    assert.equal(protectedResult.content, "公开回复");
    assert.equal(
      readLog(logPath).filter((entry) => entry.type === "read-error").length,
      1,
    );
    await firstRuntime.closeBinding("binding-one");

    const resumedRuntime = new AcpDelegatedRuntime(config(directory, command));
    try {
      const resumed = await resumedRuntime.generate(
        input(definition, "binding-one", directory, first.sessionId),
      );
      assert.equal(resumed.content, "公开回复");
      const afterRestart = readLog(logPath);
      assert.equal(afterRestart.filter((entry) => entry.type === "initialize").length, 3);
      assert.equal(afterRestart.filter((entry) => entry.type === "new").length, 2);
      assert.equal(afterRestart.filter((entry) => entry.type === "resume").length, 1);
    } finally {
      await resumedRuntime.shutdown();
    }
  } finally {
    await firstRuntime.shutdown();
    delete process.env.FAKE_KIMI_LOG;
    delete process.env.FAKE_KIMI_READ_PATH;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("第二个 ACP 定义无需供应商分支，Council policy 可收窄握手与工具", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-generic-acp-"));
  const command = path.join(directory, "fake-second-agent");
  const logPath = path.join(directory, "fake-second-agent.log");
  const sourcePath = path.join(directory, "source.txt");
  writeFileSync(command, FAKE_KIMI);
  chmodSync(command, 0o700);
  writeFileSync(sourcePath, "SECOND_RUNTIME_EVIDENCE");
  process.env.FAKE_KIMI_LOG = logPath;
  process.env.FAKE_KIMI_READ_PATH = sourcePath;
  const definition = runtimeDefinition("second-agent", command, [
    "text",
    "repository_read",
    "git_diff",
    "shell_write",
  ]);
  const runtime = new AcpDelegatedRuntime(config(directory, command));
  try {
    const result = await runtime.generate(
      input(definition, "binding-second", directory, undefined, ["text"]),
    );
    assert.equal(result.content, "公开回复");
    const entries = readLog(logPath);
    assert.equal(entries.filter((entry) => entry.type === "initialize").length, 1);
    assert.deepEqual(
      entries.find((entry) => entry.type === "new")?.mcpServers,
      [],
    );
    assert.deepEqual(
      entries.find((entry) => entry.type === "read-permission")?.outcome,
      { outcome: "selected", optionId: "reject-read" },
    );
    assert.deepEqual(
      entries.find((entry) => entry.type === "git-permission")?.outcome,
      { outcome: "selected", optionId: "reject-git" },
    );
    assert.equal(entries.filter((entry) => entry.type === "read-result").length, 0);
    assert.equal(entries.filter((entry) => entry.type === "read-error").length, 0);
  } finally {
    await runtime.shutdown();
    delete process.env.FAKE_KIMI_LOG;
    delete process.env.FAKE_KIMI_READ_PATH;
    rmSync(directory, { recursive: true, force: true });
  }
});
