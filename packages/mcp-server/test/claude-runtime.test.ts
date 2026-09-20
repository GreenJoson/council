/**
 * @input  依赖：假 Claude CLI、AbortController 与纯 ClaudeRuntime
 * @output 导出：stream-json 增量、生成、恢复、取消、抗并发调度超时、回合耗尽和安全错误边界测试
 * @pos    无数据库副作用运行时的进程生命周期单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ClaudeRuntime, ClaudeRuntimeError } from "../src/claude-runtime.js";
import type { CouncilConfig } from "../src/types.js";

const FAKE_RUNTIME_SOURCE = `
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--fake-mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "success";
const pidIndex = args.indexOf("--pid-file");
const pidFile = pidIndex >= 0 ? args[pidIndex + 1] : undefined;
const childPidIndex = args.indexOf("--child-pid-file");
const childPidFile = childPidIndex >= 0 ? args[childPidIndex + 1] : undefined;
const argDumpIndex = args.indexOf("--arg-dump-file");
const argDumpFile = argDumpIndex >= 0 ? args[argDumpIndex + 1] : undefined;

if (argDumpFile) {
  writeFileSync(argDumpFile, JSON.stringify(args));
}
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}
// 复刻真实 CLI 的参数契约：--print 搭配 stream-json 缺 --verbose 时立即退出 1，
// 且只写 stderr、不产出任何 stream-json。生产上正是这个组合把整轮圆桌打挂。
if (args.includes("--print") && args.includes("stream-json") && !args.includes("--verbose")) {
  process.stderr.write("Error: When using --print, --output-format=stream-json requires --verbose");
  process.exit(1);
}
if (mode === "tree-hang") {
  spawn(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    childPidFile
  ], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "escaped-pipe") {
  const escaped = spawn(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    childPidFile
  ], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  escaped.unref();
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "flood") {
  process.on("SIGTERM", () => {});
  const writeForever = () => {
    process.stdout.write("x".repeat(4_096));
    setImmediate(writeForever);
  };
  writeForever();
} else if (mode === "oversize") {
  process.stdout.write("x".repeat(50_000));
  setInterval(() => {}, 1_000);
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    if (mode === "nonzero") {
      process.stderr.write("private diagnostic must not escape");
      process.exitCode = 7;
      return;
    }
    if (mode === "login-error") {
      process.stdout.write(JSON.stringify({ result: "Not logged in: private detail", is_error: true }));
      process.exitCode = 1;
      return;
    }
    if (mode === "quota-error") {
      process.stdout.write(JSON.stringify({ result: "You're out of usage credits. private detail", is_error: true }));
      process.exitCode = 1;
      return;
    }
    if (mode === "max-turns-error") {
      process.stdout.write(JSON.stringify({ result: "Reached max turns (8). private detail", is_error: true }));
      process.exitCode = 1;
      return;
    }
    const resumeIndex = args.indexOf("--resume");
    const modelIndex = args.indexOf("--model");
    const finalResult = [
      input,
      resumeIndex >= 0 ? args[resumeIndex + 1] : "none",
      modelIndex >= 0 ? args[modelIndex + 1] : "none"
    ].join(";");
    if (args.includes("stream-json")) {
      const streamEvents = [
        { type: "stream_event", event: { type: "message_start" } },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "公开" }
          }
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "草稿" }
          }
        }
      ];
      process.stdout.write(streamEvents.map(event => JSON.stringify(event)).join("\\n") + "\\n");
    }
    process.stdout.write(JSON.stringify({
      type: "result",
      result: finalResult,
      session_id: "runtime_session",
      model: "runtime_model",
      is_error: false
    }));
  });
}
`;

function createConfig(
  directory: string,
  fakeClaudePath: string,
  mode: string,
  overrides: Partial<CouncilConfig> = {},
): CouncilConfig {
  return {
    dataDir: directory,
    databasePath: path.join(directory, "unused.sqlite3"),
    delegationWorktreeRoot: path.join(directory, "delegated-worktrees"),
    delegationRetryDelayMs: 1,
    claudeCommand: process.execPath,
    claudeArgs: [fakeClaudePath, "--fake-mode", mode],
    claudePermissionMode: "plan",
    claudeTimeoutMs: 5_000,
    claudeKillGraceMs: 50,
    claudeMaxTurns: 3,
    codexCommand: process.execPath,
    codexArgs: [],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    kimiAcpCommand: process.execPath,
    geminiAcpCommand: process.execPath,
    grokAcpCommand: process.execPath,
    codexAcpCommand: process.execPath,
    claudeAcpCommand: process.execPath,
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
    ...overrides,
  };
}

async function waitForPid(pidFile: string, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      return Number(readFileSync(pidFile, "utf8"));
    }
    await delay(10);
  }
  throw new Error("假 Claude 进程没有按时写入 PID。");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "win32") {
      try {
        const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        // 同组 SIGKILL 后，孤儿进程可能短暂处于僵尸态等待系统回收；它已不能执行。
        return state.length > 0 && !state.startsWith("Z");
      } catch {
        return false;
      }
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGone(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error("假 Claude 进程没有按时退出。");
    }
    await delay(10);
  }
}

async function killProcessIfAlive(pid: number | undefined): Promise<void> {
  if (pid === undefined || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForProcessGone(pid);
}

test("ClaudeRuntime 纯生成并显式恢复 session 与模型", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-success-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "success"));
    const first = await runtime.generate({ prompt: "public prompt", cwd: directory });
    assert.equal(first.content, "public prompt;none;none");
    assert.equal(first.sessionId, "runtime_session");
    assert.equal(first.model, "runtime_model");

    const resumed = await runtime.generate({
      prompt: "public rebuttal",
      cwd: directory,
      sessionId: "session_previous",
      model: "configured-model",
    });
    assert.equal(resumed.content, "public rebuttal;session_previous;configured-model");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 只在显式委派时映射 acceptEdits 或危险权限", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-permission-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  const argDumpFile = path.join(directory, "args.json");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "success", {
      claudeArgs: [
        fakeClaudePath,
        "--fake-mode",
        "success",
        "--arg-dump-file",
        argDumpFile,
      ],
    }));
    await runtime.generate({
      prompt: "execute",
      cwd: directory,
      permissionProfile: "workspace_write",
    });
    let args = JSON.parse(readFileSync(argDumpFile, "utf8")) as string[];
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(args.includes("--dangerously-skip-permissions"), false);

    await runtime.generate({
      prompt: "execute dangerous",
      cwd: directory,
      permissionProfile: "danger_full_access",
    });
    args = JSON.parse(readFileSync(argDumpFile, "utf8")) as string[];
    assert.equal(args.includes("--dangerously-skip-permissions"), true);
    assert.equal(args.includes("--permission-mode"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 清空 MCP 配置，被召唤 Agent 拿不到 Council 写工具或递归召唤能力", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-mcp-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  const argDumpFile = path.join(directory, "args.json");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "success", {
      claudeArgs: [fakeClaudePath, "--fake-mode", "success", "--arg-dump-file", argDumpFile],
    }));
    await runtime.generate({ prompt: "public prompt", cwd: directory });

    const passed = JSON.parse(readFileSync(argDumpFile, "utf8")) as string[];
    assert.ok(passed.includes("--strict-mcp-config"), "必须禁止读取调用者的 MCP 配置文件");
    assert.equal(
      passed[passed.indexOf("--mcp-config") + 1],
      '{"mcpServers":{}}',
      "MCP 服务器表必须为空",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 只转发 stream-json 的公开 text_delta 并以最终结果收口", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-stream-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const events: Array<{ operation: string; content?: string }> = [];
    let activityCount = 0;
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "success"));
    const response = await runtime.generate({
      prompt: "public prompt",
      cwd: directory,
      onActivity: () => {
        activityCount += 1;
      },
      onTextEvent: (event) => events.push(event),
    });
    assert.equal(response.content, "public prompt;none;none");
    assert.deepEqual(events, [
      { operation: "reset" },
      { operation: "append", content: "公开" },
      { operation: "append", content: "草稿" },
      { operation: "replace", content: "public prompt;none;none" },
    ]);
    assert.equal(activityCount, 4, "每个合法 Claude stream-json 事件都应刷新活动时间");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 外部取消后强制结束忽略 SIGTERM 的进程", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-abort-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  const pidFile = path.join(directory, "runtime.pid");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const config = createConfig(directory, fakeClaudePath, "hang");
    config.claudeArgs.push("--pid-file", pidFile);
    const runtime = new ClaudeRuntime(config);
    const controller = new AbortController();
    const generation = runtime.generate({
      prompt: "public prompt",
      cwd: directory,
      signal: controller.signal,
    });
    const pid = await waitForPid(pidFile);
    controller.abort(new Error("private cancellation reason"));
    await assert.rejects(generation, { name: "AbortError", message: "Claude Code 调用已取消。" });
    await waitForProcessGone(pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 已取消的 signal 不启动进程", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-pre-abort-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  const pidFile = path.join(directory, "runtime.pid");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const config = createConfig(directory, fakeClaudePath, "hang");
    config.claudeArgs.push("--pid-file", pidFile);
    const controller = new AbortController();
    controller.abort();
    const runtime = new ClaudeRuntime(config);
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory, signal: controller.signal }),
      { name: "AbortError" },
    );
    await delay(25);
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "ClaudeRuntime 在 POSIX 取消时清理同一进程组的派生进程",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-tree-"));
    const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
    const pidFile = path.join(directory, "runtime.pid");
    const childPidFile = path.join(directory, "runtime-child.pid");
    writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
    try {
      const config = createConfig(directory, fakeClaudePath, "tree-hang");
      config.claudeArgs.push(
        "--pid-file",
        pidFile,
        "--child-pid-file",
        childPidFile,
      );
      const runtime = new ClaudeRuntime(config);
      const controller = new AbortController();
      const generation = runtime.generate({
        prompt: "public prompt",
        cwd: directory,
        signal: controller.signal,
      });
      const parentPid = await waitForPid(pidFile);
      const childPid = await waitForPid(childPidFile);
      controller.abort(new Error("private cancellation reason"));
      await assert.rejects(generation, { name: "AbortError" });
      await Promise.all([waitForProcessGone(parentPid), waitForProcessGone(childPid)]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("ClaudeRuntime 超时后结束子进程", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-timeout-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  const pidFile = path.join(directory, "runtime.pid");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const config = createConfig(directory, fakeClaudePath, "hang", {
      // 全量测试并发启动多个 Node 进程；给启动握手留余量，仍验证同一超时终止路径。
      claudeTimeoutMs: 2_500,
    });
    config.claudeArgs.push("--pid-file", pidFile);
    const runtime = new ClaudeRuntime(config);
    const generation = runtime.generate({ prompt: "public prompt", cwd: directory });
    const rejection = assert.rejects(generation, /Claude Code 调用超时/);
    const pid = await waitForPid(pidFile);
    await rejection;
    await waitForProcessGone(pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 拒绝超过输出上限的响应", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-output-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(
      createConfig(directory, fakeClaudePath, "oversize", { maxOutputChars: 100 }),
    );
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory }),
      /Claude Code 输出超过配置上限/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 持续输出且忽略 SIGTERM 时保持有界并结束进程", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-flood-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  const pidFile = path.join(directory, "runtime.pid");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const config = createConfig(directory, fakeClaudePath, "flood", {
      maxOutputChars: 100,
    });
    config.claudeArgs.push("--pid-file", pidFile);
    const runtime = new ClaudeRuntime(config);
    const generation = runtime.generate({ prompt: "public prompt", cwd: directory });
    const rejection = assert.rejects(generation, /Claude Code 输出超过配置上限/);
    const pid = await waitForPid(pidFile);
    await rejection;
    await waitForProcessGone(pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "ClaudeRuntime 不被脱离进程组且继承管道的后代无限阻塞",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-escaped-"));
    const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
    const pidFile = path.join(directory, "runtime.pid");
    const childPidFile = path.join(directory, "runtime-child.pid");
    let escapedPid: number | undefined;
    writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
    try {
      const config = createConfig(directory, fakeClaudePath, "escaped-pipe", {
        claudeKillGraceMs: 40,
      });
      config.claudeArgs.push(
        "--pid-file",
        pidFile,
        "--child-pid-file",
        childPidFile,
      );
      const runtime = new ClaudeRuntime(config);
      const controller = new AbortController();
      const startedAt = Date.now();
      const generation = runtime.generate({
        prompt: "public prompt",
        cwd: directory,
        signal: controller.signal,
      });
      const parentPid = await waitForPid(pidFile);
      escapedPid = await waitForPid(childPidFile);
      controller.abort();
      await assert.rejects(generation, { name: "AbortError" });
      assert.ok(Date.now() - startedAt < 1_000);
      await waitForProcessGone(parentPid);
      assert.equal(isProcessAlive(escapedPid), true);
    } finally {
      await killProcessIfAlive(escapedPid);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "ClaudeRuntime 降级组信号 EPERM 且保留取消原因",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-eperm-"));
    const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
    const pidFile = path.join(directory, "runtime.pid");
    const originalKill = process.kill;
    writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
    try {
      const config = createConfig(directory, fakeClaudePath, "hang", {
        claudeKillGraceMs: 20,
      });
      config.claudeArgs.push("--pid-file", pidFile);
      const runtime = new ClaudeRuntime(config);
      const controller = new AbortController();
      const generation = runtime.generate({
        prompt: "public prompt",
        cwd: directory,
        signal: controller.signal,
      });
      const pid = await waitForPid(pidFile);
      process.kill = ((targetPid: number, signal?: NodeJS.Signals | number): true => {
        if (targetPid < 0) {
          const error = new Error("simulated group permission failure") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        return Reflect.apply(
          originalKill,
          process,
          signal === undefined ? [targetPid] : [targetPid, signal],
        ) as true;
      }) as typeof process.kill;
      controller.abort();
      await assert.rejects(generation, {
        name: "AbortError",
        message: "Claude Code 调用已取消。",
      });
      process.kill = originalKill;
      await waitForProcessGone(pid);
    } finally {
      process.kill = originalKill;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("ClaudeRuntime 拒绝非法 session/model 且不把 option-like 值传给 CLI", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-options-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "success"));
    for (const sessionId of ["", "--resume", "invalid/session", "x".repeat(201)]) {
      await assert.rejects(
        runtime.generate({ prompt: "public prompt", cwd: directory, sessionId }),
        /session ID 格式无效/,
      );
    }
    for (const model of ["", "--dangerous", "invalid$model", "x".repeat(201)]) {
      await assert.rejects(
        runtime.generate({ prompt: "public prompt", cwd: directory, model }),
        /model 格式无效/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 启动错误不泄露命令或 cwd 路径", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-spawn-"));
  const privateCommandPath = path.join(directory, "private-command");
  const privateCwdPath = path.join(directory, "private-cwd");
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(privateCommandPath, "not executable", { mode: 0o600 });
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const inaccessibleRuntime = new ClaudeRuntime(
      createConfig(directory, privateCommandPath, "success", {
        claudeCommand: privateCommandPath,
        claudeArgs: [],
      }),
    );
    await assert.rejects(
      inaccessibleRuntime.generate({ prompt: "public prompt", cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "无法启动 Claude Code，请检查可执行权限和项目目录配置。");
        assert.doesNotMatch(error.message, new RegExp(directory));
        return true;
      },
    );

    const invalidCwdRuntime = new ClaudeRuntime(
      createConfig(directory, fakeClaudePath, "success"),
    );
    await assert.rejects(
      invalidCwdRuntime.generate({ prompt: "public prompt", cwd: privateCwdPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(privateCwdPath));
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 非零退出不泄露 stderr", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-nonzero-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "nonzero"));
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Claude Code 调用失败/);
        assert.doesNotMatch(error.message, /private diagnostic/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 将登录失败转换为脱敏指引", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-login-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "login-error"));
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Claude Code CLI 未登录/);
        assert.doesNotMatch(error.message, /private detail/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 将模型额度耗尽分类为不可重试且不泄露原文", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-quota-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "quota-error"));
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeRuntimeError);
        assert.equal(error.diagnosticCode, "quota_exhausted");
        assert.equal(error.retryable, false);
        assert.doesNotMatch(error.message, /private detail/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ClaudeRuntime 将工具回合耗尽分类为不可重试且给出安全指引", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-runtime-max-turns-"));
  const fakeClaudePath = path.join(directory, "fake-runtime.mjs");
  writeFileSync(fakeClaudePath, FAKE_RUNTIME_SOURCE, { mode: 0o700 });
  try {
    const runtime = new ClaudeRuntime(createConfig(directory, fakeClaudePath, "max-turns-error"));
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeRuntimeError);
        assert.equal(error.diagnosticCode, "max_turns_exhausted");
        assert.equal(error.retryable, false);
        assert.match(error.message, /工具回合上限/);
        assert.doesNotMatch(error.message, /private detail|Reached max turns/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
