/**
 * @input  依赖：公开 prompt、Claude Code CLI 配置与可选 AbortSignal
 * @output 导出：纯 ClaudeRuntime 生成接口和可用性检查
 * @pos    无数据库副作用的 Claude Code 子进程运行边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ClaudeResponse, CouncilConfig } from "./types.js";

type ClaudeRuntimeConfig = Pick<
  CouncilConfig,
  | "claudeCommand"
  | "claudeArgs"
  | "claudePermissionMode"
  | "claudeTimeoutMs"
  | "claudeKillGraceMs"
  | "claudeMaxTurns"
  | "maxOutputChars"
>;

export interface ClaudeRuntimeInput {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface ClaudeAvailability {
  available: boolean;
  authenticated: boolean;
  version?: string;
  authMethod?: string;
  error?: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ClaudeJsonResult {
  result?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  model?: unknown;
  is_error?: unknown;
  loggedIn?: unknown;
  authMethod?: unknown;
}

type StopReason = "aborted" | "output" | "timeout";

type ProcessOutcome =
  | { kind: "closed"; result: ProcessResult }
  | { kind: "stopped"; reason: StopReason };

const IS_POSIX = process.platform !== "win32";
const PROCESS_POLL_INTERVAL_MS = 10;
const MAX_RUNTIME_OPTION_CHARS = 200;
const MAX_NODE_TIMER_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): ClaudeJsonResult | undefined {
  const candidates = [text.trim(), ...text.trim().split("\n").reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // 继续尝试下一行，兼容运行时附带提示文本的情况。
    }
  }
  return undefined;
}

function loginError(): Error {
  return new Error(
    "Claude Code CLI 未登录。请先完成一次 claude auth login；Claude Desktop 手动接力模式不受影响。",
  );
}

function parseClaudeOutput(stdout: string): ClaudeResponse {
  const parsed = parseJsonObject(stdout);
  if (!parsed) {
    const content = stdout.trim();
    if (!content) {
      throw new Error("Claude Code 没有返回可用内容。");
    }
    return { content };
  }
  const content = typeof parsed.result === "string" ? parsed.result.trim() : "";
  if (parsed.is_error === true) {
    if (/not logged in/i.test(content)) {
      throw loginError();
    }
    throw new Error("Claude Code 返回失败结果，请检查模型权限和本地 MCP 日志。");
  }
  if (!content) {
    throw new Error("Claude Code 返回失败结果，请检查认证、模型和权限配置。");
  }
  const rawSessionId = parsed.session_id ?? parsed.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(rawSessionId)
      ? rawSessionId
      : undefined;
  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  return {
    content,
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
  };
}

function abortError(): Error {
  const error = new Error("Claude Code 调用已取消。");
  error.name = "AbortError";
  return error;
}

function stopError(reason: StopReason): Error {
  if (reason === "aborted") {
    return abortError();
  }
  if (reason === "timeout") {
    return new Error("Claude Code 调用超时，请缩小议题或调整 COUNCIL_CLAUDE_TIMEOUT_MS。");
  }
  return new Error("Claude Code 输出超过配置上限，请缩小问题或提高 COUNCIL_MAX_OUTPUT_CHARS。");
}

function trySignalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (IS_POSIX && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 组可能已退出或当前平台拒绝组信号；继续尝试直接子进程且不覆盖原停止原因。
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch {
      // 终止竞态和权限错误不得把取消、超时或输出超限替换为底层系统错误。
    }
  }
}

function isProcessTreeAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (!IS_POSIX || child.pid === undefined) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function destroyStdio(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(PROCESS_POLL_INTERVAL_MS, remaining));
    });
  }
  return true;
}

async function settleWithin(
  completion: Promise<ProcessResult>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function terminateAndWait(
  child: ChildProcessWithoutNullStreams,
  completion: Promise<ProcessResult>,
  graceMs: number,
): Promise<void> {
  trySignalProcessTree(child, "SIGTERM");
  let [completionSettled, processTreeGone] = await Promise.all([
    settleWithin(completion, graceMs),
    waitUntil(() => !isProcessTreeAlive(child), graceMs),
  ]);

  if (!completionSettled || !processTreeGone) {
    trySignalProcessTree(child, "SIGKILL");
    [completionSettled, processTreeGone] = await Promise.all([
      settleWithin(completion, graceMs),
      waitUntil(() => !isProcessTreeAlive(child), graceMs),
    ]);
  }

  if (!completionSettled) {
    destroyStdio(child);
    completionSettled = await settleWithin(completion, graceMs);
  }

  if (isProcessTreeAlive(child)) {
    trySignalProcessTree(child, "SIGKILL");
    processTreeGone = await waitUntil(() => !isProcessTreeAlive(child), graceMs);
  }

  if (!completionSettled) {
    destroyStdio(child);
  }

  // 无论底层探测最终结果如何，到达这里都必须保留调用方最初的停止原因。
  void processTreeGone;
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) {
    return undefined;
  }
  const normalized = sessionId.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_RUNTIME_OPTION_CHARS ||
    normalized.startsWith("-") ||
    !/^[A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    throw new Error("Claude session ID 格式无效。");
  }
  return normalized;
}

function normalizeModel(model: string | undefined): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  const normalized = model.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_RUNTIME_OPTION_CHARS ||
    normalized.startsWith("-") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)
  ) {
    throw new Error("Claude model 格式无效。");
  }
  return normalized;
}

export class ClaudeRuntime {
  constructor(private readonly config: ClaudeRuntimeConfig) {
    if (config.claudePermissionMode !== "plan") {
      throw new Error("ClaudeRuntime 只允许 plan 权限模式。");
    }
    if (
      !Number.isSafeInteger(config.claudeTimeoutMs) ||
      config.claudeTimeoutMs <= 0 ||
      config.claudeTimeoutMs > MAX_NODE_TIMER_MS ||
      !Number.isSafeInteger(config.claudeKillGraceMs) ||
      config.claudeKillGraceMs <= 0 ||
      config.claudeKillGraceMs > MAX_NODE_TIMER_MS
    ) {
      throw new Error("ClaudeRuntime 定时器配置无效。");
    }
  }

  async #run(
    args: string[],
    input: string,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (signal?.aborted) {
      throw abortError();
    }

    const child = spawn(this.config.claudeCommand, [...this.config.claudeArgs, ...args], {
      ...(cwd ? { cwd } : {}),
      detached: IS_POSIX,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let stop: ((reason: StopReason) => void) | undefined;
    const stopped = new Promise<ProcessOutcome>((resolve) => {
      stop = (reason) => resolve({ kind: "stopped", reason });
    });
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              "找不到 Claude Code 可执行程序，请安装 CLI 或设置 COUNCIL_CLAUDE_COMMAND。",
            ),
          );
          return;
        }
        reject(new Error("无法启动 Claude Code，请检查可执行权限和项目目录配置。"));
      });
      child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    });
    const closed = completion.then<ProcessOutcome>((result) => ({ kind: "closed", result }));
    const timeout = setTimeout(() => stop?.("timeout"), this.config.claudeTimeoutMs);
    const abortListener = (): void => stop?.("aborted");
    signal?.addEventListener("abort", abortListener, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length > this.config.maxOutputChars) {
        return;
      }
      const remaining = this.config.maxOutputChars - stdout.length;
      stdout += chunk.slice(0, remaining + 1);
      if (chunk.length > remaining) {
        stop?.("output");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > this.config.maxOutputChars) {
        stderr = stderr.slice(-this.config.maxOutputChars);
      }
    });
    child.stdin.on("error", () => {
      // 进程提前结束或被取消时，关闭中的 stdin 可能报告 EPIPE；由 close/error 决定结果。
    });
    child.stdin.end(input);

    try {
      const outcome = await Promise.race([closed, stopped]);
      if (outcome.kind === "closed") {
        return outcome.result;
      }
      await terminateAndWait(child, completion, this.config.claudeKillGraceMs);
      throw stopError(outcome.reason);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortListener);
    }
  }

  async checkAvailability(): Promise<ClaudeAvailability> {
    try {
      const versionResult = await this.#run(["--version"], "");
      if (versionResult.exitCode !== 0) {
        throw new Error("Claude Code 版本检查失败。");
      }
      const authResult = await this.#run(["auth", "status"], "");
      const authJson = parseJsonObject(authResult.stdout);
      const authenticated = authJson?.loggedIn === true;
      const authMethod =
        typeof authJson?.authMethod === "string" ? authJson.authMethod : undefined;
      return {
        available: true,
        authenticated,
        version: versionResult.stdout.trim() || "unknown",
        ...(authMethod ? { authMethod } : {}),
        ...(!authenticated
          ? { error: "Claude Code CLI 尚未登录；自动顾问模式需要先完成一次登录。" }
          : {}),
      };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : "Claude Code 可用性检查失败。",
      };
    }
  }

  async generate(input: ClaudeRuntimeInput): Promise<ClaudeResponse> {
    const model = normalizeModel(input.model);
    const sessionId = normalizeSessionId(input.sessionId);
    const args = [
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      this.config.claudePermissionMode,
      "--max-turns",
      String(this.config.claudeMaxTurns),
      ...(model ? ["--model", model] : []),
      ...(sessionId ? ["--resume", sessionId] : []),
    ];
    const result = await this.#run(args, input.prompt, input.cwd, input.signal);
    if (input.signal?.aborted) {
      throw abortError();
    }
    if (result.exitCode !== 0) {
      const parsed = parseJsonObject(result.stdout);
      const content = typeof parsed?.result === "string" ? parsed.result : "";
      if (parsed?.is_error === true && /not logged in/i.test(content)) {
        throw loginError();
      }
      throw new Error("Claude Code 调用失败，请检查登录状态、模型权限和本地 MCP 日志。");
    }
    return parseClaudeOutput(result.stdout);
  }
}
