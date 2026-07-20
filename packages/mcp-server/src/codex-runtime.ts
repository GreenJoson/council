/**
 * @input  依赖：公开 prompt、Codex CLI 配置、JSONL 传输与可选 AbortSignal
 * @output 导出：纯 CodexRuntime、结构化安全错误和可用性检查
 * @pos    分离过程事件与最终正文上限、强制只读沙箱的 Codex 运行边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertRuntimeTimers,
  makeAbortError,
  normalizeCliOption,
  runBoundedProcess,
  type BoundedProcessMessages,
  type ProcessResult,
} from "./process-utils.js";
import type { CodexResponse, CouncilConfig } from "./types.js";

type CodexRuntimeConfig = Pick<
  CouncilConfig,
  | "codexCommand"
  | "codexArgs"
  | "codexSandboxMode"
  | "codexTimeoutMs"
  | "codexKillGraceMs"
  | "maxOutputChars"
>;

export interface CodexRuntimeInput {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface CodexAvailability {
  available: boolean;
  authenticated: boolean;
  version?: string;
  authMethod?: string;
  error?: string;
}

export class CodexRuntimeError extends Error {
  override readonly name = "CodexRuntimeError";

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly diagnosticCode: string,
  ) {
    super(message);
  }
}

const ABORT_MESSAGE = "Codex 调用已取消。";

const PROCESS_MESSAGES: BoundedProcessMessages = {
  aborted: ABORT_MESSAGE,
  timeout: "Codex 调用超时，请缩小议题或调整 COUNCIL_CODEX_TIMEOUT_MS。",
  outputLimit: "Codex 输出超过配置上限，请缩小问题或提高 COUNCIL_MAX_OUTPUT_CHARS。",
  commandNotFound: "找不到 Codex 可执行程序，请安装 CLI 或设置 COUNCIL_CODEX_COMMAND。",
  spawnFailed: "无法启动 Codex，请检查可执行权限和项目目录配置。",
};

// 实测（codex-cli 0.144.6）：--json 事件流首行为
// {"type":"thread.started","thread_id":"<uuid>"}，最终回复出现在
// {"type":"item.completed","item":{"type":"agent_message","text":"..."}}。
interface CodexEventItem {
  type?: unknown;
  text?: unknown;
}

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: CodexEventItem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        events.push(parsed as CodexEvent);
      }
    } catch {
      // 忽略被输出上限截断或混入提示文本的行，其余事件仍然可用。
    }
  }
  return events;
}

function extractSessionId(events: CodexEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      const threadId = event.thread_id;
      if (/^[A-Za-z0-9._:-]{1,200}$/.test(threadId)) {
        return threadId;
      }
    }
  }
  return undefined;
}

function extractLastAgentMessage(events: CodexEvent[]): string {
  let latest = "";
  for (const event of events) {
    if (
      event.type === "item.completed" &&
      isRecord(event.item) &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string" &&
      event.item.text.trim()
    ) {
      latest = event.item.text.trim();
    }
  }
  return latest;
}

function loginError(): CodexRuntimeError {
  return new CodexRuntimeError(
    "Codex CLI 未登录。请先运行一次 codex login，再重试自动顾问调用。",
    false,
    "authentication_failed",
  );
}

function looksLikeLoginFailure(result: ProcessResult): boolean {
  return /not\s+logged\s+in|codex\s+login|unauthorized|401/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function classifyProcessFailure(result: ProcessResult): CodexRuntimeError {
  if (looksLikeLoginFailure(result)) {
    return loginError();
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (
    /(?:429|rate.?limit|temporar(?:y|ily)|overloaded|try again|service unavailable|connection|network|timed?\s*out)/i
      .test(output)
  ) {
    return new CodexRuntimeError(
      "Codex 服务暂时不可用或请求受限，可使用“恢复”稍后重试。",
      true,
      `transient_exit_${String(result.exitCode ?? "signal")}`,
    );
  }
  if (
    /(?:model[^\n]*(?:not found|unsupported|unavailable|permission|access)|does not have access[^\n]*model)/i
      .test(output)
  ) {
    return new CodexRuntimeError(
      "Codex 模型不可用或当前账号无权限，请检查 COUNCIL_CODEX_MODEL。",
      false,
      `model_unavailable_${String(result.exitCode ?? "signal")}`,
    );
  }
  return new CodexRuntimeError(
    "Codex 进程异常退出，可使用“恢复”重试。",
    true,
    `unknown_exit_${String(result.exitCode ?? "signal")}`,
  );
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  return normalizeCliOption(
    sessionId,
    /^[A-Za-z0-9._:-]+$/,
    () => new Error("Codex session ID 格式无效。"),
  );
}

function normalizeModel(model: string | undefined): string | undefined {
  return normalizeCliOption(
    model,
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    () => new Error("Codex model 格式无效。"),
  );
}

export class CodexRuntime {
  constructor(private readonly config: CodexRuntimeConfig) {
    if (config.codexSandboxMode !== "read-only") {
      throw new Error("CodexRuntime 只允许 read-only 沙箱模式。");
    }
    assertRuntimeTimers(
      config.codexTimeoutMs,
      config.codexKillGraceMs,
      "CodexRuntime 定时器配置无效。",
    );
  }

  async #run(
    args: string[],
    input: string,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    return await runBoundedProcess({
      command: this.config.codexCommand,
      args: [...this.config.codexArgs, ...args],
      input,
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: this.config.codexTimeoutMs,
      killGraceMs: this.config.codexKillGraceMs,
      maxOutputChars: this.config.maxOutputChars,
      stdoutOverflow: "truncate",
      messages: PROCESS_MESSAGES,
    });
  }

  async checkAvailability(): Promise<CodexAvailability> {
    try {
      const versionResult = await this.#run(["--version"], "");
      if (versionResult.exitCode !== 0) {
        throw new Error("Codex 版本检查失败。");
      }
      // 实测：已登录时 `codex login status` 以 0 退出，并把 "Logged in using ..."
      // 写到 stderr；未登录时以非零码退出。据此判定认证状态，不解析内部细节。
      const loginResult = await this.#run(["login", "status"], "");
      const authenticated = loginResult.exitCode === 0;
      const authMethod = /logged in using (.+)/i
        .exec(`${loginResult.stdout}\n${loginResult.stderr}`)?.[1]
        ?.trim();
      return {
        available: true,
        authenticated,
        version: versionResult.stdout.trim() || "unknown",
        ...(authenticated && authMethod ? { authMethod } : {}),
        ...(!authenticated
          ? { error: "Codex CLI 尚未登录；自动顾问模式需要先运行一次 codex login。" }
          : {}),
      };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : "Codex 可用性检查失败。",
      };
    }
  }

  async generate(input: CodexRuntimeInput): Promise<CodexResponse> {
    const model = normalizeModel(input.model);
    const sessionId = normalizeSessionId(input.sessionId);
    const scratchDir = await mkdtemp(path.join(tmpdir(), "council-codex-"));
    const lastMessageFile = path.join(scratchDir, "last-message.txt");
    try {
      // resume 子命令没有 --sandbox/--cd 选项，只读沙箱改由 --config 覆盖强制；
      // 新会话则直接用 --sandbox，两条路径均不允许写盘。
      const args = sessionId
        ? [
            "exec",
            "resume",
            sessionId,
            "--config",
            `sandbox_mode="${this.config.codexSandboxMode}"`,
          ]
        : ["exec", "--sandbox", this.config.codexSandboxMode, "--cd", input.cwd];
      args.push(
        "--skip-git-repo-check",
        "--json",
        "--output-last-message",
        lastMessageFile,
        ...(model ? ["--model", model] : []),
        "-",
      );
      const result = await this.#run(args, input.prompt, input.cwd, input.signal);
      if (input.signal?.aborted) {
        throw makeAbortError(ABORT_MESSAGE);
      }
      if (result.exitCode !== 0) {
        throw classifyProcessFailure(result);
      }
      const events = parseEvents(result.stdout);
      const content =
        (await readFile(lastMessageFile, "utf8").catch(() => "")).trim() ||
        extractLastAgentMessage(events);
      if (!content) {
        throw new CodexRuntimeError(
          "Codex 没有返回可用内容，可使用“恢复”重试。",
          true,
          "empty_response",
        );
      }
      if (content.length > this.config.maxOutputChars) {
        throw new CodexRuntimeError(
          PROCESS_MESSAGES.outputLimit,
          false,
          "final_output_limit",
        );
      }
      const threadId = extractSessionId(events);
      return {
        content,
        ...(threadId ? { sessionId: threadId } : {}),
      };
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {
        // 临时目录清理失败不得覆盖生成结果或原始错误。
      });
    }
  }
}
