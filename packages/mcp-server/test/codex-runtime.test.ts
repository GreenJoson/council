/**
 * @input  依赖：假 Codex CLI、AbortController 与纯 CodexRuntime
 * @output 导出：只读沙箱、resume、正文回退、取消、超时和安全错误边界测试
 * @pos    Codex 无数据库副作用运行时的进程生命周期单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CodexRuntime } from "../src/codex-runtime.js";
import type { CouncilConfig } from "../src/types.js";

// 假 CLI 复刻实测（codex-cli 0.144.6）行为：--json 输出 thread.started /
// item.completed(agent_message) 事件流，--output-last-message 写最终正文文件。
const FAKE_CODEX_SOURCE = `
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--fake-mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "success";
const pidIndex = args.indexOf("--pid-file");
const pidFile = pidIndex >= 0 ? args[pidIndex + 1] : undefined;

if (args.includes("--version")) {
  process.stdout.write("fake-codex 0.144.6\\n");
  process.exit(0);
}
if (args.includes("login") && args.includes("status")) {
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\\n");
    process.exit(1);
  }
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    if (mode === "nonzero") {
      process.stderr.write("private codex diagnostic must not escape");
      process.exitCode = 7;
      return;
    }
    if (mode === "login-error") {
      process.stderr.write("stream error: 401 Unauthorized; private token detail");
      process.exitCode = 1;
      return;
    }
    const outIndex = args.indexOf("--output-last-message");
    const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;
    const resumeIndex = args.indexOf("resume");
    const resumed = resumeIndex >= 0 ? args[resumeIndex + 1] : "none";
    const modelIndex = args.indexOf("--model");
    const model = modelIndex >= 0 ? args[modelIndex + 1] : "none";
    const sandboxIndex = args.indexOf("--sandbox");
    const sandbox = sandboxIndex >= 0
      ? args[sandboxIndex + 1]
      : (args.includes('sandbox_mode="read-only"') ? "config-read-only" : "none");
    const cdIndex = args.indexOf("--cd");
    const cd = cdIndex >= 0 ? args[cdIndex + 1] : "no-cd";
    const skipGit = args.includes("--skip-git-repo-check") ? "skip-git" : "no-skip-git";
    const text = [input, sandbox, cd, skipGit, resumed, model].join(";");
    const events = [
      { type: "thread.started", thread_id: "codex_runtime_session" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    process.stdout.write(events.map(event => JSON.stringify(event)).join("\\n") + "\\n");
    if (outFile && mode !== "no-last-file") {
      writeFileSync(outFile, mode === "file-differs" ? "FILE_CONTENT" : text);
    }
  });
}
`;

function createConfig(
  directory: string,
  fakeCodexPath: string,
  mode: string,
  overrides: Partial<CouncilConfig> = {},
): CouncilConfig {
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
    codexArgs: [fakeCodexPath, "--fake-mode", mode],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    sqliteBusyTimeoutMs: 5_000,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
    ...overrides,
  };
}

async function waitForPid(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(pidFile)) {
      return Number(readFileSync(pidFile, "utf8"));
    }
    await delay(5);
  }
  throw new Error("假 Codex 进程没有按时写入 PID。");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGone(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error("假 Codex 进程没有按时退出。");
    }
    await delay(10);
  }
}

test("CodexRuntime 纯生成强制只读沙箱并提取 thread session", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-success-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const runtime = new CodexRuntime(createConfig(directory, fakeCodexPath, "success"));
    const first = await runtime.generate({ prompt: "public prompt", cwd: directory });
    assert.equal(
      first.content,
      `public prompt;read-only;${directory};skip-git;none;none`,
    );
    assert.equal(first.sessionId, "codex_runtime_session");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime resume 走 exec resume 且用 --config 强制只读沙箱", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-resume-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const runtime = new CodexRuntime(createConfig(directory, fakeCodexPath, "success"));
    const resumed = await runtime.generate({
      prompt: "public rebuttal",
      cwd: directory,
      sessionId: "session_previous",
      model: "configured-model",
    });
    assert.equal(
      resumed.content,
      "public rebuttal;config-read-only;no-cd;skip-git;session_previous;configured-model",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime 优先读取 --output-last-message 文件内容", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-lastfile-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const runtime = new CodexRuntime(createConfig(directory, fakeCodexPath, "file-differs"));
    const response = await runtime.generate({ prompt: "public prompt", cwd: directory });
    assert.equal(response.content, "FILE_CONTENT");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime 正文文件缺失时回退解析 JSONL agent_message", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-fallback-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const runtime = new CodexRuntime(createConfig(directory, fakeCodexPath, "no-last-file"));
    const response = await runtime.generate({ prompt: "public prompt", cwd: directory });
    assert.equal(
      response.content,
      `public prompt;read-only;${directory};skip-git;none;none`,
    );
    assert.equal(response.sessionId, "codex_runtime_session");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime 非零退出不泄露 stderr", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-nonzero-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const runtime = new CodexRuntime(createConfig(directory, fakeCodexPath, "nonzero"));
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Codex 调用失败/);
        assert.doesNotMatch(error.message, /private codex diagnostic/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime 将未登录失败转换为脱敏登录指引", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-login-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const runtime = new CodexRuntime(createConfig(directory, fakeCodexPath, "login-error"));
    await assert.rejects(
      runtime.generate({ prompt: "public prompt", cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Codex CLI 未登录/);
        assert.doesNotMatch(error.message, /private token detail/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime 拒绝非法 session/model 且不把 option-like 值传给 CLI", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-options-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const runtime = new CodexRuntime(createConfig(directory, fakeCodexPath, "success"));
    for (const sessionId of ["", "--last", "invalid/session", "x".repeat(201)]) {
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

test("CodexRuntime 超时后结束子进程", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-timeout-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  const pidFile = path.join(directory, "codex.pid");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const config = createConfig(directory, fakeCodexPath, "hang", {
      codexTimeoutMs: 500,
    });
    config.codexArgs.push("--pid-file", pidFile);
    const runtime = new CodexRuntime(config);
    const generation = runtime.generate({ prompt: "public prompt", cwd: directory });
    const rejection = assert.rejects(generation, /Codex 调用超时/);
    const pid = await waitForPid(pidFile);
    await rejection;
    await waitForProcessGone(pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime 外部取消后强制结束忽略 SIGTERM 的进程", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-abort-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  const pidFile = path.join(directory, "codex.pid");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const config = createConfig(directory, fakeCodexPath, "hang");
    config.codexArgs.push("--pid-file", pidFile);
    const runtime = new CodexRuntime(config);
    const controller = new AbortController();
    const generation = runtime.generate({
      prompt: "public prompt",
      cwd: directory,
      signal: controller.signal,
    });
    const pid = await waitForPid(pidFile);
    controller.abort(new Error("private cancellation reason"));
    await assert.rejects(generation, { name: "AbortError", message: "Codex 调用已取消。" });
    await waitForProcessGone(pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime checkAvailability 报告版本与登录状态", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-availability-"));
  const fakeCodexPath = path.join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
  try {
    const loggedIn = await new CodexRuntime(
      createConfig(directory, fakeCodexPath, "success"),
    ).checkAvailability();
    assert.equal(loggedIn.available, true);
    assert.equal(loggedIn.authenticated, true);
    assert.match(loggedIn.version ?? "", /fake-codex/);
    assert.equal(loggedIn.authMethod, "ChatGPT");

    const loggedOut = await new CodexRuntime(
      createConfig(directory, fakeCodexPath, "logged-out"),
    ).checkAvailability();
    assert.equal(loggedOut.available, true);
    assert.equal(loggedOut.authenticated, false);
    assert.match(loggedOut.error ?? "", /尚未登录/);

    const missing = await new CodexRuntime(
      createConfig(directory, fakeCodexPath, "success", {
        codexCommand: path.join(directory, "missing-codex"),
        codexArgs: [],
      }),
    ).checkAvailability();
    assert.equal(missing.available, false);
    assert.equal(missing.authenticated, false);
    assert.match(missing.error ?? "", /找不到 Codex 可执行程序/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexRuntime 构造时拒绝非只读沙箱与非法定时器", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-guard-"));
  try {
    assert.throws(
      () =>
        new CodexRuntime({
          ...createConfig(directory, "fake", "success"),
          codexSandboxMode: "danger-full-access" as "read-only",
        }),
      /只允许 read-only 沙箱模式/,
    );
    assert.throws(
      () =>
        new CodexRuntime({
          ...createConfig(directory, "fake", "success"),
          codexTimeoutMs: 0,
        }),
      /定时器配置无效/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
