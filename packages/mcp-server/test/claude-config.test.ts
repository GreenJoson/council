/**
 * @input  依赖：隔离数据目录、COUNCIL_CLAUDE_* 环境变量与 loadConfig
 * @output 导出：Claude 权限、MCP 调用者绑定、迁移必填项、参数和定时器安全配置测试
 * @pos    后台运行时启动前的配置边界单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadMcpConfig } from "../src/config.js";

function createEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    COUNCIL_DATA_DIR: dataDir,
    COUNCIL_CLAUDE_COMMAND: "claude",
    COUNCIL_CLAUDE_ARGS_JSON: "[]",
    COUNCIL_CLAUDE_PERMISSION_MODE: "plan",
    COUNCIL_CLAUDE_TIMEOUT_MS: "5000",
    COUNCIL_CLAUDE_KILL_GRACE_MS: "100",
    COUNCIL_CLAUDE_MAX_TURNS: "3",
    COUNCIL_SQLITE_BUSY_TIMEOUT_MS: "5000",
    COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS: "3",
    COUNCIL_MAX_CONTEXT_CHARS: "20000",
    COUNCIL_MAX_OUTPUT_CHARS: "10000",
    COUNCIL_DEFAULT_MESSAGE_LIMIT: "20",
  };
}

test("Claude 配置只允许 plan 权限模式", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-config-permission-"));
  try {
    const valid = loadConfig(createEnv(directory));
    assert.equal(valid.claudePermissionMode, "plan");
    assert.throws(
      () =>
        loadConfig({
          ...createEnv(directory),
          COUNCIL_CLAUDE_PERMISSION_MODE: "acceptEdits",
        }),
      /必须为 plan/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP 配置缺少 schema 迁移重试项时 fail fast", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-config-migration-required-"));
  try {
    const env = createEnv(directory);
    delete env.COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS;
    assert.throws(
      () => loadConfig(env),
      /COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP 配置必须显式绑定调用者，而 HTTP 通用配置不需要", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-config-caller-"));
  try {
    const env = createEnv(directory);
    assert.equal(loadConfig(env).databasePath.endsWith("council.sqlite3"), true);
    assert.throws(() => loadMcpConfig(env), /COUNCIL_CALLER_ACTOR_ALIAS/);
    assert.equal(
      loadMcpConfig({
        ...env,
        COUNCIL_CALLER_ACTOR_ALIAS: "codex",
      }).callerActorAlias,
      "codex",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude 配置拒绝运行时保留参数和危险权限参数", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-config-args-"));
  const forbidden = [
    "--print",
    "--output-format=json",
    "--permission-mode",
    "--max-turns=99",
    "--model",
    "--resume",
    "--dangerously-skip-permissions",
    "--allowedTools=Bash",
    "--add-dir",
    // 重新挂回 MCP 就等于把 Council 写工具还给被召唤 Agent，与只读沙箱无关
    "--mcp-config",
    "--strict-mcp-config",
  ];
  try {
    for (const argument of forbidden) {
      assert.throws(
        () =>
          loadConfig({
            ...createEnv(directory),
            COUNCIL_CLAUDE_ARGS_JSON: JSON.stringify([argument]),
          }),
        /保留参数或危险权限参数/,
      );
    }
    assert.deepEqual(
      loadConfig({
        ...createEnv(directory),
        COUNCIL_CLAUDE_ARGS_JSON: JSON.stringify(["--verbose"]),
      }).claudeArgs,
      ["--verbose"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude 配置拒绝无效 JSON 和超过 Node 定时器上限的时长", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-config-timer-"));
  try {
    assert.throws(
      () =>
        loadConfig({
          ...createEnv(directory),
          COUNCIL_CLAUDE_ARGS_JSON: "[invalid]",
        }),
      /有效的字符串数组 JSON/,
    );
    for (const name of [
      "COUNCIL_CLAUDE_TIMEOUT_MS",
      "COUNCIL_CLAUDE_KILL_GRACE_MS",
    ] as const) {
      assert.throws(
        () => loadConfig({ ...createEnv(directory), [name]: "2147483648" }),
        /不能超过 Node.js 定时器上限/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
