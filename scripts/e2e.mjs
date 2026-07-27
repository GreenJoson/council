/**
 * @input  依赖：已构建的 Council API/Web、显式迁移/RuntimeBinding 配置、Playwright 与 Agent 替身
 * @output 导出：隔离 schema 迁移、真实 HTTP/SSE、本机/远程 Agent 调用及 mock 布局的浏览器验收
 * @pos    根目录跨进程 E2E 启动、隔离数据与子进程收口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_POSIX = process.platform !== "win32";
const PYTHON_COMMAND = process.env.COUNCIL_E2E_PYTHON_COMMAND?.trim()
  || (process.platform === "win32" ? "python" : "python3");
const WEB_ROOT = path.join(ROOT, "packages/web");
const VITE_ENTRY = path.join(ROOT, "packages/web/node_modules/vite/bin/vite.js");
const STARTUP_TIMEOUT_MS = readPositiveInteger("COUNCIL_E2E_STARTUP_TIMEOUT_MS", 30_000);
const CHILD_STOP_TIMEOUT_MS = readPositiveInteger("COUNCIL_E2E_STOP_TIMEOUT_MS", 3_000);
const API_PORT = readPort("COUNCIL_E2E_API_PORT", 4_328);
const HTTP_WEB_PORT = readPort("COUNCIL_E2E_HTTP_WEB_PORT", 4_184);
const MOCK_WEB_PORT = readPort("COUNCIL_E2E_MOCK_WEB_PORT", 4_183);
const REMOTE_PROVIDER_PORT = readPort("COUNCIL_E2E_REMOTE_PROVIDER_PORT", 4_329);
const activeChildren = new Set();
const SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
let interruptedSignal;

function readPositiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return value;
}

function readPort(name, fallback) {
  const value = readPositiveInteger(name, fallback);
  if (value > 65_535) {
    throw new Error(`${name} 必须是有效端口。`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "localhost", port });
    const finish = (available) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function assertPortFree(port) {
  if (await probePort(port)) {
    throw new Error(`E2E 端口 ${String(port)} 已被占用，请通过 COUNCIL_E2E_*_PORT 更换。`);
  }
}

function startChild(label, command, args, env) {
  throwIfInterrupted();
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    detached: IS_POSIX,
    shell: false,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`[e2e:${label}] 启动失败：${error.message}\n`);
  });
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}

async function waitForServer(label, child, port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probePort(port)) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} 在端口就绪前退出。`);
    }
    await delay(100);
  }
  throw new Error(`${label} 未在配置时限内就绪。`);
}

function signalChildTree(child, signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (IS_POSIX) {
      process.kill(-child.pid, signal);
    } else {
      const force = signal === "SIGKILL" ? ["/F"] : [];
      spawnSync(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...force],
        { stdio: "ignore", windowsHide: true },
      );
    }
  } catch {
    // 子进程可能在检查与发送之间自行退出。
  }
}

function throwIfInterrupted() {
  if (interruptedSignal) {
    throw new Error(`E2E 收到 ${interruptedSignal}，已停止继续启动进程。`);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  signalChildTree(child, "SIGTERM");
  const graceful = await Promise.race([
    closed.then(() => true),
    delay(CHILD_STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!graceful) {
    signalChildTree(child, "SIGKILL");
    const forced = await Promise.race([
      closed.then(() => true),
      delay(CHILD_STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!forced) {
      child.unref();
      activeChildren.delete(child);
      throw new Error("E2E 子进程在强制终止后仍未收口。");
    }
  }
}

async function stopChildren(children) {
  await Promise.all([...children].reverse().map((child) => stopChild(child)));
}

async function runCommand(label, command, args, env) {
  const child = startChild(label, command, args, env);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${label} 被信号 ${signal} 终止。`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${label} 验收失败，退出码 ${String(exitCode)}。`);
  }
}

function apiEnvironment(dataDirectory) {
  const webOrigin = `http://localhost:${String(HTTP_WEB_PORT)}`;
  return {
    ...process.env,
    COUNCIL_DATA_DIR: dataDirectory,
    COUNCIL_CLAUDE_COMMAND: process.execPath,
    COUNCIL_CLAUDE_ARGS_JSON: JSON.stringify([
      path.join(ROOT, "packages/mcp-server/test/fake-claude.mjs"),
    ]),
    COUNCIL_CLAUDE_MODEL: "claude-opus-test",
    COUNCIL_CLAUDE_PERMISSION_MODE: "plan",
    COUNCIL_CLAUDE_TIMEOUT_MS: "5000",
    COUNCIL_CLAUDE_KILL_GRACE_MS: "100",
    COUNCIL_CLAUDE_MAX_TURNS: "3",
    COUNCIL_TOOL_LOOP_MAX_STEPS: "4",
    COUNCIL_TOOL_LOOP_MAX_CONTEXT_CHARS: "20000",
    COUNCIL_TOOL_LOOP_MAX_FILE_BYTES: "1048576",
    COUNCIL_TOOL_LOOP_MAX_SCAN_FILES: "5000",
    COUNCIL_GIT_COMMAND: "git",
    COUNCIL_GIT_DIFF_TIMEOUT_MS: "5000",
    COUNCIL_GIT_DIFF_KILL_GRACE_MS: "100",
    COUNCIL_GIT_DIFF_MAX_FILES: "200",
    COUNCIL_GIT_DIFF_MAX_LINES: "4000",
    COUNCIL_GIT_DIFF_MAX_HUNKS_PER_FILE: "200",
    COUNCIL_GIT_DIFF_MAX_OUTPUT_CHARS: "30000",
    COUNCIL_KEYCHAIN_COMMAND: path.join(
      ROOT,
      "packages/mcp-server/test/fake-keychain.mjs",
    ),
    COUNCIL_FAKE_KEYCHAIN_FILE: path.join(dataDirectory, "e2e-keychain.json"),
    COUNCIL_SQLITE_BUSY_TIMEOUT_MS: "5000",
    COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS: "3",
    COUNCIL_MAX_CONTEXT_CHARS: "20000",
    COUNCIL_MAX_OUTPUT_CHARS: "30000",
    COUNCIL_DEFAULT_MESSAGE_LIMIT: "100",
    COUNCIL_HTTP_HOST: "localhost",
    COUNCIL_HTTP_PORT: String(API_PORT),
    COUNCIL_HTTP_CORS_ORIGINS_JSON: JSON.stringify([webOrigin]),
    COUNCIL_HTTP_CORS_MAX_AGE_SECONDS: "600",
    COUNCIL_HTTP_RATE_LIMIT_WINDOW_MS: "60000",
    COUNCIL_HTTP_RATE_LIMIT_MAX: "1000",
    COUNCIL_HTTP_BODY_LIMIT_BYTES: "65536",
    COUNCIL_HTTP_EVENT_POLL_MS: "100",
    COUNCIL_HTTP_EVENT_RETRY_MS: "300",
    COUNCIL_HTTP_EVENT_HEARTBEAT_MS: "1000",
    COUNCIL_HTTP_SHUTDOWN_TIMEOUT_MS: "3000",
    COUNCIL_ORCHESTRATION_LEASE_TTL_MS: "3000",
    COUNCIL_ORCHESTRATION_LEASE_RENEW_MS: "500",
    COUNCIL_ORCHESTRATION_SWEEP_INTERVAL_MS: "200",
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_ROUNDS: "4",
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_ATTEMPTS: "1",
    COUNCIL_ORCHESTRATION_DEFAULT_MAX_RECOVERIES: "1",
    COUNCIL_ORCHESTRATION_DEFAULT_AGENT_TIMEOUT_MS: "5000",
    COUNCIL_ORCHESTRATION_AGENT_CLEANUP_TIMEOUT_MS: "500",
    COUNCIL_ORCHESTRATION_CONFIRM_COMPLETION: "true",
    COUNCIL_ORCHESTRATION_RUN_PAGE_LIMIT: "50",
    COUNCIL_ORCHESTRATION_STARTUP_SCAN_LIMIT: "100",
    COUNCIL_ORCHESTRATION_SHUTDOWN_TIMEOUT_MS: "2000",
    COUNCIL_RUNTIME_BINDING_IDLE_TIMEOUT_MS: "1800000",
  };
}

function httpWebEnvironment() {
  return {
    ...process.env,
    VITE_COUNCIL_DATA_MODE: "http",
    VITE_COUNCIL_API_URL: `http://localhost:${String(API_PORT)}`,
    VITE_COUNCIL_PROJECT_PATH: ROOT,
    VITE_COUNCIL_TOPIC_PAGE_SIZE: "100",
    VITE_COUNCIL_MESSAGE_PAGE_SIZE: "100",
    VITE_COUNCIL_EVENT_REFRESH_MAX_ATTEMPTS: "5",
    VITE_COUNCIL_EVENT_REFRESH_RETRY_DELAY_MS: "100",
    VITE_COUNCIL_EVENT_RECOVERY_DELAY_MS: "500",
    VITE_COUNCIL_ORCHESTRATION_PAGE_SIZE: "50",
    VITE_COUNCIL_ORCHESTRATION_RECOVERY_DELAY_MS: "500",
  };
}

async function runHttpBrowserE2E(dataDirectory) {
  await Promise.all([
    assertPortFree(API_PORT),
    assertPortFree(HTTP_WEB_PORT),
    assertPortFree(REMOTE_PROVIDER_PORT),
  ]);
  const remoteProvider = startChild(
    "remote-provider",
    process.execPath,
    [path.join(ROOT, "packages/mcp-server/test/fake-openai-provider.mjs")],
    {
      ...process.env,
      COUNCIL_FAKE_PROVIDER_PORT: String(REMOTE_PROVIDER_PORT),
    },
  );
  const children = [remoteProvider];
  try {
    await waitForServer("Council 测试远程 Provider", remoteProvider, REMOTE_PROVIDER_PORT);
    const api = startChild(
      "api",
      process.execPath,
      [path.join(ROOT, "packages/mcp-server/dist/src/http-index.js")],
      apiEnvironment(dataDirectory),
    );
    children.push(api);
    await waitForServer("Council API", api, API_PORT);
    const web = startChild(
      "http-web",
      process.execPath,
      [VITE_ENTRY, WEB_ROOT, "--host", "localhost", "--port", String(HTTP_WEB_PORT)],
      httpWebEnvironment(),
    );
    children.push(web);
    await waitForServer("Council HTTP Web", web, HTTP_WEB_PORT);
    await runCommand(
      "http-browser",
      PYTHON_COMMAND,
      [path.join(ROOT, "packages/web/test/webui-http-smoke.py")],
      {
        ...process.env,
        COUNCIL_WEB_URL: `http://localhost:${String(HTTP_WEB_PORT)}`,
        COUNCIL_API_URL: `http://localhost:${String(API_PORT)}`,
        COUNCIL_PROJECT_PATH: ROOT,
        COUNCIL_FAKE_PROVIDER_URL: `http://localhost:${String(REMOTE_PROVIDER_PORT)}/v1`,
      },
    );
  } finally {
    await stopChildren(children);
  }
}

async function runMockBrowserE2E() {
  await assertPortFree(MOCK_WEB_PORT);
  const web = startChild(
    "mock-web",
    process.execPath,
    [VITE_ENTRY, WEB_ROOT, "--host", "localhost", "--port", String(MOCK_WEB_PORT)],
    { ...process.env, VITE_COUNCIL_DATA_MODE: "mock" },
  );
  try {
    await waitForServer("Council Mock Web", web, MOCK_WEB_PORT);
    await runCommand(
      "mock-browser",
      PYTHON_COMMAND,
      [path.join(ROOT, "packages/web/test/webui-smoke.py")],
      {
        ...process.env,
        COUNCIL_WEB_URL: `http://localhost:${String(MOCK_WEB_PORT)}`,
      },
    );
  } finally {
    await stopChild(web);
  }
}

const dataDirectory = mkdtempSync(path.join(tmpdir(), "council-e2e-"));
for (const signal of SIGNAL_EXIT_CODES.keys()) {
  process.once(signal, () => {
    interruptedSignal ??= signal;
    void stopChildren([...activeChildren]).catch((error) => {
      const message = error instanceof Error ? error.message : "未知清理错误";
      process.stderr.write(`Council E2E 信号清理失败：${message}\n`);
    });
  });
}

let failure;
try {
  throwIfInterrupted();
  await runHttpBrowserE2E(dataDirectory);
  throwIfInterrupted();
  await runMockBrowserE2E();
  throwIfInterrupted();
  process.stdout.write("Council 真实与 Mock 浏览器 E2E 全部通过\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await stopChildren([...activeChildren]);
  } catch (error) {
    failure ??= error;
  }
  rmSync(dataDirectory, { recursive: true, force: true });
}

if (interruptedSignal) {
  process.stderr.write(`Council E2E 已因 ${interruptedSignal} 安全停止。\n`);
  process.exitCode = SIGNAL_EXIT_CODES.get(interruptedSignal) ?? 1;
} else if (failure) {
  throw failure;
}
