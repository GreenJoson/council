/**
 * @input  依赖：COUNCIL_* 环境变量与本地文件系统
 * @output 导出：含独立 CLI 事件流、委派 Git 检查预算、流水线阶段/修订上限与 Codex 生图开关/沙箱/超时/张数上限/产物兜底目录（codexHome）的 CouncilConfig、绑定调用者身份与本机 HTTP 转发地址的 McpCouncilConfig、isLoopbackHost、MCP/HTTP 共用的 v19 资产库配置 loadAssetConfig
 * @pos    MCP 服务的集中式配置加载入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 集中加载并校验 Claude 实施和审核的独立回合预算
 */

import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { ASSET_SNIFFABLE_MIMES, MAX_LIST_LIMIT } from "./constants.js";
import type { AssetConfig, CouncilConfig, McpCouncilConfig } from "./types.js";

const MAX_NODE_TIMER_MS = 2_147_483_647;
const REQUIRED_PERMISSION_MODE = "plan";
const REQUIRED_CODEX_SANDBOX_MODE = "read-only";
const DEFAULT_CODEX_COMMAND = "codex";
/** MCP 转发本机 HTTP 服务的缺省地址与超时；与 .env.example 的 COUNCIL_HTTP_* 缺省一致，可由环境覆盖。 */
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 4317;
const DEFAULT_MCP_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
const DEFAULT_CODEX_KILL_GRACE_MS = 3_000;
/** Codex 生图沙箱独立于讨论沙箱：只允许 workspace-write，避免一个开关放宽所有 Codex 调用。 */
const REQUIRED_CODEX_IMAGE_SANDBOX_MODE = "workspace-write";
export const DEFAULT_CODEX_IMAGE_TIMEOUT_MS = 900_000;
export const DEFAULT_CODEX_IMAGE_MAX_OUTPUTS = 16;
const DEFAULT_KIMI_ACP_COMMAND = "kimi";
const DEFAULT_GEMINI_ACP_COMMAND = "gemini";
const DEFAULT_GROK_ACP_COMMAND = "grok";
const DEFAULT_CODEX_ACP_COMMAND = "codex-acp";
const DEFAULT_CLAUDE_ACP_COMMAND = "claude-agent-acp";
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
const DEFAULT_DELEGATION_GIT_MAX_OUTPUT_CHARS = 1_000_000;
const DEFAULT_CLI_MAX_STREAM_CHARS = 32_000_000;

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

/** 布尔开关只接受 true/false，拼写错误直接拒绝启动而不是静默按默认值处理。 */
function parseOptionalBoolean(name: string, env: NodeJS.ProcessEnv, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw !== "true" && raw !== "false") {
    throw new Error(`环境变量 ${name} 必须为 true 或 false。`);
  }
  return raw === "true";
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

// ---------------------------------------------------------------------------
// v19 资产库：MCP 与 HTTP 两个入口共用同一个加载函数，assets/ 领域只读结果。
// ---------------------------------------------------------------------------
const DEFAULT_ASSET_MAX_BYTES = 26_214_400;
const DEFAULT_ASSET_MAX_TOTAL_BYTES = 5_368_709_120;
const DEFAULT_ASSET_MIME_ALLOWLIST = [
  "image/png", "image/jpeg", "image/webp", "image/svg+xml", "model/gltf-binary", "application/pdf",
] as const;
const DEFAULT_ASSET_THUMBNAIL_MAX_EDGE = 512;
const DEFAULT_ASSET_THUMBNAIL_COMMAND = "sips";
const DEFAULT_ASSET_THUMBNAIL_TIMEOUT_MS = 10_000;
/** 缩略图最长边上限：再大就不是缩略图了，也会让外部命令长时间占用 CPU。 */
const MAX_ASSET_THUMBNAIL_EDGE = 4_096;

export function loadAssetConfig(env: NodeJS.ProcessEnv, dataDir: string): AssetConfig {
  const rootDir = env.COUNCIL_ASSET_DIR?.trim() || path.join(dataDir, "assets");
  if (!path.isAbsolute(rootDir)) {
    throw new Error("COUNCIL_ASSET_DIR 必须是绝对路径。");
  }
  const maxBytes = parseOptionalPositiveInteger("COUNCIL_ASSET_MAX_BYTES", env, DEFAULT_ASSET_MAX_BYTES);
  const maxTotalBytes = parseOptionalPositiveInteger(
    "COUNCIL_ASSET_MAX_TOTAL_BYTES",
    env,
    DEFAULT_ASSET_MAX_TOTAL_BYTES,
  );
  if (maxBytes > maxTotalBytes) {
    throw new Error("COUNCIL_ASSET_MAX_BYTES 不能大于 COUNCIL_ASSET_MAX_TOTAL_BYTES。");
  }
  const rawAllowlist = env.COUNCIL_ASSET_MIME_ALLOWLIST?.trim();
  const mimeAllowlist = rawAllowlist
    ? [...new Set(rawAllowlist.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))]
    : [...DEFAULT_ASSET_MIME_ALLOWLIST];
  const sniffable: readonly string[] = ASSET_SNIFFABLE_MIMES;
  if (mimeAllowlist.length === 0 || mimeAllowlist.some((mime) => !sniffable.includes(mime))) {
    throw new Error(`COUNCIL_ASSET_MIME_ALLOWLIST 只能取 ${sniffable.join(", ")} 的非空子集。`);
  }
  const thumbnailMaxEdge = parseOptionalPositiveInteger(
    "COUNCIL_ASSET_THUMBNAIL_MAX_EDGE",
    env,
    DEFAULT_ASSET_THUMBNAIL_MAX_EDGE,
  );
  if (thumbnailMaxEdge > MAX_ASSET_THUMBNAIL_EDGE) {
    throw new Error(`COUNCIL_ASSET_THUMBNAIL_MAX_EDGE 不能超过 ${String(MAX_ASSET_THUMBNAIL_EDGE)}。`);
  }
  return {
    rootDir,
    maxBytes,
    maxTotalBytes,
    mimeAllowlist,
    thumbnailMaxEdge,
    thumbnailCommand: env.COUNCIL_ASSET_THUMBNAIL_COMMAND?.trim() || DEFAULT_ASSET_THUMBNAIL_COMMAND,
    thumbnailTimeoutMs: parseOptionalTimer(
      "COUNCIL_ASSET_THUMBNAIL_TIMEOUT_MS",
      env,
      DEFAULT_ASSET_THUMBNAIL_TIMEOUT_MS,
    ),
  };
}

export const EXECUTION_DEFAULTS = {
  workerHeartbeatMs: 5_000, workerIdleTimeoutMs: 300_000,
  maxSegments: 4, timeoutMs: 7_200_000,
} as const;

/**
 * Codex 自身的数据目录（<codex-home>）：图像委派兜底扫描 `generated_images/<threadId>/`。
 * 优先 COUNCIL_CODEX_HOME，留空回退进程 CODEX_HOME，再回退 `~/.codex`；只做本地读，不进 DTO/日志。
 */
function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const configured = env.COUNCIL_CODEX_HOME?.trim() || env.CODEX_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("COUNCIL_CODEX_HOME 必须是绝对路径。");
    }
    return path.resolve(configured);
  }
  return path.join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
  const dataDir = requireEnv("COUNCIL_DATA_DIR", env);
  if (!path.isAbsolute(dataDir)) {
    throw new Error("COUNCIL_DATA_DIR 必须是绝对路径。");
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const delegationWorktreeRoot = env.COUNCIL_DELEGATION_WORKTREE_ROOT?.trim()
    || path.join(dataDir, "delegated-worktrees");
  if (!path.isAbsolute(delegationWorktreeRoot)) {
    throw new Error("COUNCIL_DELEGATION_WORKTREE_ROOT 必须是绝对路径。");
  }
  mkdirSync(delegationWorktreeRoot, { recursive: true, mode: 0o700 });

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
  const codexImageSandboxMode = env.COUNCIL_CODEX_IMAGE_SANDBOX_MODE?.trim()
    || REQUIRED_CODEX_IMAGE_SANDBOX_MODE;
  if (codexImageSandboxMode !== REQUIRED_CODEX_IMAGE_SANDBOX_MODE) {
    throw new Error("COUNCIL_CODEX_IMAGE_SANDBOX_MODE 必须为 workspace-write。");
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
    codexImageEnabled: parseOptionalBoolean("COUNCIL_CODEX_IMAGE_ENABLED", env, true),
    codexImageSandboxMode,
    codexImageTimeoutMs: parseOptionalTimer(
      "COUNCIL_CODEX_IMAGE_TIMEOUT_MS",
      env,
      DEFAULT_CODEX_IMAGE_TIMEOUT_MS,
    ),
    codexImageMaxOutputs: parseOptionalPositiveInteger(
      "COUNCIL_CODEX_IMAGE_MAX_OUTPUTS",
      env,
      DEFAULT_CODEX_IMAGE_MAX_OUTPUTS,
    ),
    codexHome: resolveCodexHome(env),
    kimiAcpCommand:
      env.COUNCIL_KIMI_ACP_COMMAND?.trim()
      || env.COUNCIL_KIMI_COMMAND?.trim()
      || DEFAULT_KIMI_ACP_COMMAND,
    geminiAcpCommand:
      env.COUNCIL_GEMINI_ACP_COMMAND?.trim() || DEFAULT_GEMINI_ACP_COMMAND,
    grokAcpCommand:
      env.COUNCIL_GROK_ACP_COMMAND?.trim() || DEFAULT_GROK_ACP_COMMAND,
    codexAcpCommand:
      env.COUNCIL_CODEX_ACP_COMMAND?.trim() || DEFAULT_CODEX_ACP_COMMAND,
    claudeAcpCommand:
      env.COUNCIL_CLAUDE_ACP_COMMAND?.trim() || DEFAULT_CLAUDE_ACP_COMMAND,
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
    claudeExecutionMaxTurns: parseOptionalPositiveInteger("COUNCIL_CLAUDE_EXECUTION_MAX_TURNS", env, 120),
    workerHeartbeatMs: parseOptionalTimer("COUNCIL_WORKER_HEARTBEAT_MS", env, EXECUTION_DEFAULTS.workerHeartbeatMs),
    workerIdleTimeoutMs: parseOptionalTimer("COUNCIL_WORKER_IDLE_TIMEOUT_MS", env, EXECUTION_DEFAULTS.workerIdleTimeoutMs),
    delegationMaxExecutionSegments: parseOptionalPositiveInteger("COUNCIL_DELEGATION_MAX_EXECUTION_SEGMENTS", env, EXECUTION_DEFAULTS.maxSegments),
    delegationExecutionTimeoutMs: parseOptionalTimer("COUNCIL_DELEGATION_EXECUTION_TIMEOUT_MS", env, EXECUTION_DEFAULTS.timeoutMs),
    pipelineMaxStages: parseOptionalPositiveInteger("COUNCIL_PIPELINE_MAX_STAGES", env, 6),
    pipelineMaxRevisions: parseOptionalPositiveInteger("COUNCIL_PIPELINE_MAX_REVISIONS", env, 3),
    claudeReviewMaxTurns: parseOptionalPositiveInteger("COUNCIL_CLAUDE_REVIEW_MAX_TURNS", env, 48),
    delegationWorktreeRoot,
    delegationGitMaxOutputChars: parseOptionalPositiveInteger(
      "COUNCIL_DELEGATION_GIT_MAX_OUTPUT_CHARS", env, DEFAULT_DELEGATION_GIT_MAX_OUTPUT_CHARS,
    ),
    delegationRetryDelayMs: parseOptionalTimer("COUNCIL_DELEGATION_RETRY_DELAY_MS", env, 1500),
    ...(keychainCommand ? { keychainCommand } : {}),
    sqliteBusyTimeoutMs: parsePositiveInteger("COUNCIL_SQLITE_BUSY_TIMEOUT_MS", env),
    schemaMigrationMaxAttempts: parsePositiveInteger(
      "COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS",
      env,
    ),
    maxContextChars: parsePositiveInteger("COUNCIL_MAX_CONTEXT_CHARS", env),
    maxOutputChars: parsePositiveInteger("COUNCIL_MAX_OUTPUT_CHARS", env),
    cliMaxStreamChars: parseOptionalPositiveInteger(
      "COUNCIL_CLI_MAX_STREAM_CHARS",
      env,
      DEFAULT_CLI_MAX_STREAM_CHARS,
    ),
    defaultMessageLimit,
    assets: loadAssetConfig(env, dataDir),
  };
}

/** HTTP 服务与 MCP 转发共用：只允许本机回环地址，防止任务委派被转发到外部主机。 */
export function isLoopbackHost(value: string): boolean {
  const host = value.toLowerCase();
  if (host === "localhost" || host === "::1") {
    return true;
  }
  return isIP(host) === 4 && host.split(".")[0] === "127";
}

/** stdio MCP 进程不持有委派管理器；需要执行的工具转发到同机 HTTP 服务。 */
function loadHttpServiceUrl(env: NodeJS.ProcessEnv): string {
  const host = env.COUNCIL_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error("COUNCIL_HTTP_HOST 只允许 loopback 主机。");
  }
  const port = parseOptionalPositiveInteger("COUNCIL_HTTP_PORT", env, DEFAULT_HTTP_PORT);
  if (port > 65_535) {
    throw new Error("环境变量 COUNCIL_HTTP_PORT 超出端口范围。");
  }
  return `http://${host.includes(":") ? `[${host}]` : host}:${String(port)}`;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpCouncilConfig {
  return {
    ...loadConfig(env),
    callerActorAlias: requireEnv("COUNCIL_CALLER_ACTOR_ALIAS", env),
    httpServiceUrl: loadHttpServiceUrl(env),
    httpForwardTimeoutMs: parseOptionalTimer("COUNCIL_MCP_HTTP_TIMEOUT_MS", env, DEFAULT_MCP_HTTP_TIMEOUT_MS),
  };
}
