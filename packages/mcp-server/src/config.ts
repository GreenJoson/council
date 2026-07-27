/**
 * @input  依赖：COUNCIL_* 环境变量与本地文件系统
 * @output 导出：HTTP 通用 CouncilConfig 与绑定调用者身份的 McpCouncilConfig
 * @pos    MCP 服务的集中式配置加载入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { MAX_LIST_LIMIT } from "./constants.js";
import type { CouncilConfig, McpCouncilConfig } from "./types.js";

const MAX_NODE_TIMER_MS = 2_147_483_647;
const REQUIRED_PERMISSION_MODE = "plan";
const REQUIRED_CODEX_SANDBOX_MODE = "read-only";
const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
const DEFAULT_CODEX_KILL_GRACE_MS = 3_000;
const DEFAULT_KIMI_COMMAND = "kimi";
const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_ACP_KILL_GRACE_MS = 3_000;
const DEFAULT_ACP_MAX_FILE_READ_CHARS = 262_144;
const DEFAULT_TOOL_LOOP_MAX_STEPS = 12;
const DEFAULT_TOOL_LOOP_MAX_CONTEXT_CHARS = 120_000;
const DEFAULT_TOOL_LOOP_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_TOOL_LOOP_MAX_SCAN_FILES = 5_000;
const DEFAULT_GIT_COMMAND = "git";
const DEFAULT_GIT_DIFF_TIMEOUT_MS = 15_000;
const DEFAULT_GIT_DIFF_KILL_GRACE_MS = 1_000;
const DEFAULT_GIT_DIFF_MAX_FILES = 200;
const DEFAULT_GIT_DIFF_MAX_LINES = 4_000;
const DEFAULT_GIT_DIFF_MAX_HUNKS_PER_FILE = 200;
const DEFAULT_GIT_DIFF_MAX_OUTPUT_CHARS = 30_000;

const FORBIDDEN_CLAUDE_ARGS = new Set([
  "--",
  "-c",
  "-p",
  "-r",
  "--add-dir",
  "--allow-dangerously-skip-permissions",
  "--allowed-tools",
  "--allowedtools",
  "--continue",
  "--dangerously-skip-permissions",
  "--fork-session",
  "--max-turns",
  "--mcp-config",
  "--model",
  "--output-format",
  "--permission-mode",
  "--permission-prompt-tool",
  "--print",
  "--resume",
  "--session-id",
  "--strict-mcp-config",
]);

// Codex 侧拦截运行时保留参数、危险沙箱/审批参数与子命令注入；
// 校验统一小写，因此 "-c" 同时覆盖 "-C/--cd" 的短写变体。
const FORBIDDEN_CODEX_ARGS = new Set([
  "--",
  "-c",
  "-i",
  "-m",
  "-o",
  "-p",
  "-s",
  "--add-dir",
  "--all",
  "--cd",
  "--config",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--full-auto",
  "--image",
  "--json",
  "--last",
  "--local-provider",
  "--model",
  "--oss",
  "--output-last-message",
  "--output-schema",
  "--profile",
  "--sandbox",
  "--skip-git-repo-check",
  "exec",
  "resume",
  "review",
]);

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请在 MCP 配置中设置。`);
  }
  return value;
}

function parsePositiveIntegerValue(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数。`);
  }
  return value;
}

function parsePositiveInteger(name: string, env: NodeJS.ProcessEnv): number {
  return parsePositiveIntegerValue(name, requireEnv(name, env));
}

function parseTimerValue(name: string, raw: string): number {
  const value = parsePositiveIntegerValue(name, raw);
  if (value > MAX_NODE_TIMER_MS) {
    throw new Error(`环境变量 ${name} 不能超过 Node.js 定时器上限。`);
  }
  return value;
}

function parseTimer(name: string, env: NodeJS.ProcessEnv): number {
  return parseTimerValue(name, requireEnv(name, env));
}

/** Codex 配置允许缺省：未设置时使用安全默认值，设置后按同样规则严格校验。 */
function parseOptionalTimer(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env[name]?.trim();
  return raw ? parseTimerValue(name, raw) : fallback;
}

function parseOptionalPositiveInteger(
  name: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  return raw ? parsePositiveIntegerValue(name, raw) : fallback;
}

function aliasedOptionalRaw(
  primary: string,
  legacy: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const current = env[primary]?.trim();
  const previous = env[legacy]?.trim();
  if (current && previous) {
    throw new Error(`环境变量 ${primary} 与旧键 ${legacy} 不能同时定义。`);
  }
  return current || previous;
}

function parseAliasedOptionalTimer(
  primary: string,
  legacy: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const raw = aliasedOptionalRaw(primary, legacy, env);
  return raw ? parseTimerValue(primary, raw) : fallback;
}

function parseAliasedOptionalPositiveInteger(
  primary: string,
  legacy: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const raw = aliasedOptionalRaw(primary, legacy, env);
  return raw ? parsePositiveIntegerValue(primary, raw) : fallback;
}

function isForbiddenArg(value: string, forbidden: ReadonlySet<string>): boolean {
  const flag = value.split("=", 1)[0]?.toLowerCase() ?? "";
  return forbidden.has(flag);
}

function parseArgsJson(
  name: string,
  env: NodeJS.ProcessEnv,
  forbidden: ReadonlySet<string>,
): string[] {
  const raw = env[name]?.trim();
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} 必须是有效的字符串数组 JSON。`);
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`${name} 必须是字符串数组 JSON。`);
  }
  if (parsed.some((value) => isForbiddenArg(value, forbidden))) {
    throw new Error(`${name} 包含运行时保留参数或危险权限参数。`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
  const dataDir = requireEnv("COUNCIL_DATA_DIR", env);
  if (!path.isAbsolute(dataDir)) {
    throw new Error("COUNCIL_DATA_DIR 必须是绝对路径。");
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const model = env.COUNCIL_CLAUDE_MODEL?.trim();
  const defaultMessageLimit = parsePositiveInteger("COUNCIL_DEFAULT_MESSAGE_LIMIT", env);
  if (defaultMessageLimit > MAX_LIST_LIMIT) {
    throw new Error(`COUNCIL_DEFAULT_MESSAGE_LIMIT 不能超过 ${String(MAX_LIST_LIMIT)}。`);
  }
  const permissionMode = requireEnv("COUNCIL_CLAUDE_PERMISSION_MODE", env);
  if (permissionMode !== REQUIRED_PERMISSION_MODE) {
    throw new Error("COUNCIL_CLAUDE_PERMISSION_MODE 必须为 plan。");
  }
  const codexModel = env.COUNCIL_CODEX_MODEL?.trim();
  const keychainCommand = env.COUNCIL_KEYCHAIN_COMMAND?.trim();
  const codexSandboxMode = env.COUNCIL_CODEX_SANDBOX_MODE?.trim() || REQUIRED_CODEX_SANDBOX_MODE;
  if (codexSandboxMode !== REQUIRED_CODEX_SANDBOX_MODE) {
    throw new Error("COUNCIL_CODEX_SANDBOX_MODE 必须为 read-only。");
  }
  return {
    dataDir,
    databasePath: path.join(dataDir, "council.sqlite3"),
    claudeCommand: requireEnv("COUNCIL_CLAUDE_COMMAND", env),
    claudeArgs: parseArgsJson("COUNCIL_CLAUDE_ARGS_JSON", env, FORBIDDEN_CLAUDE_ARGS),
    ...(model ? { claudeModel: model } : {}),
    claudePermissionMode: permissionMode,
    claudeTimeoutMs: parseTimer("COUNCIL_CLAUDE_TIMEOUT_MS", env),
    claudeKillGraceMs: parseTimer("COUNCIL_CLAUDE_KILL_GRACE_MS", env),
    claudeMaxTurns: parsePositiveInteger("COUNCIL_CLAUDE_MAX_TURNS", env),
    codexCommand: env.COUNCIL_CODEX_COMMAND?.trim() || DEFAULT_CODEX_COMMAND,
    codexArgs: parseArgsJson("COUNCIL_CODEX_ARGS_JSON", env, FORBIDDEN_CODEX_ARGS),
    ...(codexModel ? { codexModel } : {}),
    codexSandboxMode,
    codexTimeoutMs: parseOptionalTimer("COUNCIL_CODEX_TIMEOUT_MS", env, DEFAULT_CODEX_TIMEOUT_MS),
    codexKillGraceMs: parseOptionalTimer(
      "COUNCIL_CODEX_KILL_GRACE_MS",
      env,
      DEFAULT_CODEX_KILL_GRACE_MS,
    ),
    kimiCommand: env.COUNCIL_KIMI_COMMAND?.trim() || DEFAULT_KIMI_COMMAND,
    acpStartupTimeoutMs: parseAliasedOptionalTimer(
      "COUNCIL_ACP_STARTUP_TIMEOUT_MS",
      "COUNCIL_KIMI_STARTUP_TIMEOUT_MS",
      env,
      DEFAULT_ACP_STARTUP_TIMEOUT_MS,
    ),
    acpKillGraceMs: parseAliasedOptionalTimer(
      "COUNCIL_ACP_KILL_GRACE_MS",
      "COUNCIL_KIMI_KILL_GRACE_MS",
      env,
      DEFAULT_ACP_KILL_GRACE_MS,
    ),
    acpMaxFileReadChars: parseAliasedOptionalPositiveInteger(
      "COUNCIL_ACP_MAX_FILE_READ_CHARS",
      "COUNCIL_KIMI_MAX_FILE_READ_CHARS",
      env,
      DEFAULT_ACP_MAX_FILE_READ_CHARS,
    ),
    toolLoopMaxSteps: parseOptionalPositiveInteger(
      "COUNCIL_TOOL_LOOP_MAX_STEPS",
      env,
      DEFAULT_TOOL_LOOP_MAX_STEPS,
    ),
    toolLoopMaxContextChars: parseOptionalPositiveInteger(
      "COUNCIL_TOOL_LOOP_MAX_CONTEXT_CHARS",
      env,
      DEFAULT_TOOL_LOOP_MAX_CONTEXT_CHARS,
    ),
    toolLoopMaxFileBytes: parseOptionalPositiveInteger(
      "COUNCIL_TOOL_LOOP_MAX_FILE_BYTES",
      env,
      DEFAULT_TOOL_LOOP_MAX_FILE_BYTES,
    ),
    toolLoopMaxScanFiles: parseOptionalPositiveInteger(
      "COUNCIL_TOOL_LOOP_MAX_SCAN_FILES",
      env,
      DEFAULT_TOOL_LOOP_MAX_SCAN_FILES,
    ),
    gitCommand: env.COUNCIL_GIT_COMMAND?.trim() || DEFAULT_GIT_COMMAND,
    gitDiffTimeoutMs: parseOptionalTimer(
      "COUNCIL_GIT_DIFF_TIMEOUT_MS",
      env,
      DEFAULT_GIT_DIFF_TIMEOUT_MS,
    ),
    gitDiffKillGraceMs: parseOptionalTimer(
      "COUNCIL_GIT_DIFF_KILL_GRACE_MS",
      env,
      DEFAULT_GIT_DIFF_KILL_GRACE_MS,
    ),
    gitDiffMaxFiles: parseOptionalPositiveInteger(
      "COUNCIL_GIT_DIFF_MAX_FILES",
      env,
      DEFAULT_GIT_DIFF_MAX_FILES,
    ),
    gitDiffMaxLines: parseOptionalPositiveInteger(
      "COUNCIL_GIT_DIFF_MAX_LINES",
      env,
      DEFAULT_GIT_DIFF_MAX_LINES,
    ),
    gitDiffMaxHunksPerFile: parseOptionalPositiveInteger(
      "COUNCIL_GIT_DIFF_MAX_HUNKS_PER_FILE",
      env,
      DEFAULT_GIT_DIFF_MAX_HUNKS_PER_FILE,
    ),
    gitDiffMaxOutputChars: parseOptionalPositiveInteger(
      "COUNCIL_GIT_DIFF_MAX_OUTPUT_CHARS",
      env,
      DEFAULT_GIT_DIFF_MAX_OUTPUT_CHARS,
    ),
    ...(keychainCommand ? { keychainCommand } : {}),
    sqliteBusyTimeoutMs: parsePositiveInteger("COUNCIL_SQLITE_BUSY_TIMEOUT_MS", env),
    schemaMigrationMaxAttempts: parsePositiveInteger(
      "COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS",
      env,
    ),
    maxContextChars: parsePositiveInteger("COUNCIL_MAX_CONTEXT_CHARS", env),
    maxOutputChars: parsePositiveInteger("COUNCIL_MAX_OUTPUT_CHARS", env),
    defaultMessageLimit,
  };
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpCouncilConfig {
  return {
    ...loadConfig(env),
    callerActorAlias: requireEnv("COUNCIL_CALLER_ACTOR_ALIAS", env),
  };
}
