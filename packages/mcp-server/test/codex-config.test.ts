/**
 * @input  依赖：隔离数据目录、COUNCIL_CODEX_* 环境变量与 loadConfig
 * @output 导出：Codex 沙箱、默认值、参数和定时器安全配置测试
 * @pos    Codex 后台运行时启动前的配置边界单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

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
    COUNCIL_MAX_CONTEXT_CHARS: "20000",
    COUNCIL_MAX_OUTPUT_CHARS: "10000",
    COUNCIL_DEFAULT_MESSAGE_LIMIT: "20",
  };
}

test("Codex 配置未设置时使用安全默认值", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-config-defaults-"));
  try {
    const config = loadConfig(createEnv(directory));
    assert.equal(config.codexCommand, "codex");
    assert.deepEqual(config.codexArgs, []);
    assert.equal(config.codexModel, undefined);
    assert.equal(config.codexSandboxMode, "read-only");
    assert.equal(config.codexTimeoutMs, 180_000);
    assert.equal(config.codexKillGraceMs, 3_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex 配置只允许 read-only 沙箱模式", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-config-sandbox-"));
  try {
    const valid = loadConfig({
      ...createEnv(directory),
      COUNCIL_CODEX_SANDBOX_MODE: "read-only",
    });
    assert.equal(valid.codexSandboxMode, "read-only");
    for (const mode of ["workspace-write", "danger-full-access"]) {
      assert.throws(
        () =>
          loadConfig({
            ...createEnv(directory),
            COUNCIL_CODEX_SANDBOX_MODE: mode,
          }),
        /必须为 read-only/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex 配置拒绝运行时保留参数、危险沙箱参数和子命令注入", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-config-args-"));
  const forbidden = [
    "--sandbox",
    "-s",
    "--sandbox=danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--full-auto",
    "resume",
    "review",
    "exec",
    "--config",
    "-c",
    "-C",
    "--cd",
    "--json",
    "--output-last-message",
    "--output-schema",
    "--model=o3",
    "--profile",
    "--add-dir",
    "--last",
    "--oss",
  ];
  try {
    for (const argument of forbidden) {
      assert.throws(
        () =>
          loadConfig({
            ...createEnv(directory),
            COUNCIL_CODEX_ARGS_JSON: JSON.stringify([argument]),
          }),
        /保留参数或危险权限参数/,
      );
    }
    assert.deepEqual(
      loadConfig({
        ...createEnv(directory),
        COUNCIL_CODEX_ARGS_JSON: JSON.stringify(["--ephemeral"]),
      }).codexArgs,
      ["--ephemeral"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex 配置拒绝无效 JSON 和越界定时器", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-config-timer-"));
  try {
    assert.throws(
      () =>
        loadConfig({
          ...createEnv(directory),
          COUNCIL_CODEX_ARGS_JSON: "[invalid]",
        }),
      /有效的字符串数组 JSON/,
    );
    for (const name of [
      "COUNCIL_CODEX_TIMEOUT_MS",
      "COUNCIL_CODEX_KILL_GRACE_MS",
    ] as const) {
      assert.throws(
        () => loadConfig({ ...createEnv(directory), [name]: "2147483648" }),
        /不能超过 Node.js 定时器上限/,
      );
      assert.throws(
        () => loadConfig({ ...createEnv(directory), [name]: "0" }),
        /必须是正整数/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex 配置读取显式命令、模型与定时器", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-codex-config-explicit-"));
  try {
    const config = loadConfig({
      ...createEnv(directory),
      COUNCIL_CODEX_COMMAND: "/usr/local/bin/custom-codex",
      COUNCIL_CODEX_MODEL: "configured-model",
      COUNCIL_CODEX_TIMEOUT_MS: "60000",
      COUNCIL_CODEX_KILL_GRACE_MS: "500",
    });
    assert.equal(config.codexCommand, "/usr/local/bin/custom-codex");
    assert.equal(config.codexModel, "configured-model");
    assert.equal(config.codexTimeoutMs, 60_000);
    assert.equal(config.codexKillGraceMs, 500);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
