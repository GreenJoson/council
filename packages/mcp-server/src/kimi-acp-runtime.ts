/**
 * @input  依赖：Kimi Code CLI、ACP v1 SDK、项目目录、持久 RuntimeBinding 与 AbortSignal
 * @output 导出：每 binding 长驻、可恢复、只读权限的 Kimi ACP Runtime
 * @pos    Kimi DelegatedRuntime；Kimi 自己拥有 AgentLoop，Council 只管理 session 与权限
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { CouncilConfig } from "./types.js";
import {
  IS_POSIX,
  makeAbortError,
  normalizeCliOption,
  runBoundedProcess,
  terminateProcessTree,
} from "./process-utils.js";
import { isProtectedProjectRelativePath } from "./read-only-tool-host.js";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/,-]*$/u;
const SESSION_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think"]);

export interface KimiAcpAvailability {
  available: boolean;
  authenticated: boolean;
  version?: string;
  error?: string;
}

export interface KimiAcpRuntimeInput {
  bindingId: string;
  cwd: string;
  prompt: string;
  model: string;
  sessionId?: string;
  signal?: AbortSignal;
  onUpdate?: (update: SessionUpdate) => void;
  onPermission?: (request: RequestPermissionRequest) => void;
}

export interface KimiAcpRuntimeResult {
  content: string;
  sessionId: string;
}

export class KimiAcpRuntimeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly diagnosticCode: string,
  ) {
    super(message);
    this.name = "KimiAcpRuntimeError";
  }
}

interface ActiveTurn {
  onUpdate?: (update: SessionUpdate) => void;
  onPermission?: (request: RequestPermissionRequest) => void;
}

interface ManagedKimiProcess {
  bindingId: string;
  cwd: string;
  rootRealPath: string;
  model: string;
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  completion: Promise<void>;
  activeTurn?: ActiveTurn;
  promptActive: boolean;
}

function normalizeModel(model: string): string {
  return normalizeCliOption(
    model,
    MODEL_PATTERN,
    () => new KimiAcpRuntimeError("Kimi 模型 ID 格式无效。", false, "invalid_model"),
  )!;
}

function normalizeSession(sessionId: string | undefined): string | undefined {
  return normalizeCliOption(
    sessionId,
    SESSION_PATTERN,
    () => new KimiAcpRuntimeError("Kimi session ID 格式无效。", false, "invalid_session"),
  );
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function readProjectText(
  root: string,
  requestedPath: string,
  line: number | null | undefined,
  limit: number | null | undefined,
  maximumChars: number,
): string {
  if (!path.isAbsolute(requestedPath)) {
    throw new Error("ACP 只允许读取绝对文件路径。");
  }
  const realPath = realpathSync(requestedPath);
  const relativePath = path.relative(root, realPath);
  const info = statSync(realPath);
  if (
    !withinRoot(root, realPath)
    || isProtectedProjectRelativePath(relativePath)
    || !info.isFile()
    || info.size > maximumChars * 4
  ) {
    throw new Error("ACP 文件读取超出当前项目或目标不是普通文件。");
  }
  const startLine = line ?? 1;
  const lineLimit = limit ?? Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(startLine)
    || startLine <= 0
    || !Number.isSafeInteger(lineLimit)
    || lineLimit <= 0
  ) {
    throw new Error("ACP 文件读取行范围无效。");
  }
  const content = readFileSync(realPath, "utf8");
  if (content.includes("\0")) {
    throw new Error("ACP 只允许读取普通文本文件。");
  }
  const selected = content
    .split(/\r?\n/u)
    .slice(startLine - 1, startLine - 1 + lineLimit)
    .join("\n");
  if (selected.length <= maximumChars) {
    return selected;
  }
  return `${selected.slice(0, maximumChars)}\n[Council：文件读取已达到安全上限]`;
}

function publicRuntimeError(error: unknown): KimiAcpRuntimeError {
  if (error instanceof KimiAcpRuntimeError) {
    return error;
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new KimiAcpRuntimeError(
      "找不到 Kimi Code CLI，请安装后重试。",
      false,
      "command_not_found",
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (/auth|required|login|unauthorized/iu.test(message)) {
    return new KimiAcpRuntimeError(
      "Kimi Code CLI 尚未登录或登录已失效。",
      false,
      "authentication_required",
    );
  }
  return new KimiAcpRuntimeError(
    "Kimi ACP 调用暂时失败，请检查本机 Kimi Code 状态。",
    true,
    "request_failed",
  );
}

export class KimiAcpRuntime {
  readonly #processes = new Map<string, ManagedKimiProcess>();

  constructor(private readonly config: CouncilConfig) {}

  async checkAvailability(): Promise<KimiAcpAvailability> {
    try {
      const result = await runBoundedProcess({
        command: this.config.kimiCommand,
        args: ["--version"],
        input: "",
        timeoutMs: this.config.kimiStartupTimeoutMs,
        killGraceMs: this.config.kimiKillGraceMs,
        maxOutputChars: this.config.maxOutputChars,
        messages: {
          aborted: "Kimi Code 可用性检查已取消。",
          timeout: "Kimi Code 可用性检查超时。",
          outputLimit: "Kimi Code 可用性检查输出过长。",
          commandNotFound: "找不到 Kimi Code CLI。",
          spawnFailed: "Kimi Code CLI 无法启动。",
        },
      });
      return result.exitCode === 0
        ? {
            available: true,
            authenticated: true,
            version: result.stdout.trim() || "unknown",
          }
        : {
            available: true,
            authenticated: false,
            error: "Kimi Code CLI 状态检查失败。",
          };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: publicRuntimeError(error).message,
      };
    }
  }

  async probe(cwd: string, model: string): Promise<void> {
    const bindingId = `probe-${randomUUID()}`;
    try {
      await this.#open(bindingId, cwd, normalizeModel(model));
    } finally {
      await this.closeBinding(bindingId);
    }
  }

  async generate(input: KimiAcpRuntimeInput): Promise<KimiAcpRuntimeResult> {
    if (input.signal?.aborted) {
      throw makeAbortError("Kimi ACP 调用已取消。");
    }
    const model = normalizeModel(input.model);
    const expectedSessionId = normalizeSession(input.sessionId);
    let managed = this.#processes.get(input.bindingId);
    if (
      managed
      && (
        managed.cwd !== input.cwd
        || managed.model !== model
        || (
          expectedSessionId !== undefined
          && managed.sessionId !== expectedSessionId
        )
      )
    ) {
      await this.closeBinding(input.bindingId);
      managed = undefined;
    }
    managed ??= await this.#open(input.bindingId, input.cwd, model, expectedSessionId);
    if (managed.promptActive) {
      throw new KimiAcpRuntimeError(
        "同一 Kimi RuntimeBinding 已有活动回合。",
        true,
        "turn_already_active",
      );
    }

    let output = "";
    let outputExceeded = false;
    let safetyViolation = false;
    managed.promptActive = true;
    managed.activeTurn = {
      onPermission: input.onPermission,
      onUpdate: (update) => {
        if (
          update.sessionUpdate === "tool_call"
          && !READ_ONLY_TOOL_KINDS.has(update.kind ?? "other")
          && update.status !== "failed"
          && update.status !== "completed"
        ) {
          safetyViolation = true;
          void managed!.connection.agent.notify(methods.agent.session.cancel, {
            sessionId: managed!.sessionId,
          });
          return;
        }
        if (
          update.sessionUpdate === "agent_message_chunk"
          && update.content.type === "text"
        ) {
          output += update.content.text;
          if (output.length > this.config.maxOutputChars) {
            outputExceeded = true;
            void managed!.connection.agent.notify(methods.agent.session.cancel, {
              sessionId: managed!.sessionId,
            });
            return;
          }
        }
        input.onUpdate?.(update);
      },
    };

    const cancel = (): void => {
      void managed!.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: managed!.sessionId,
      }).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await managed.connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: managed.sessionId,
          prompt: [{ type: "text", text: input.prompt }],
        },
        input.signal ? { cancellationSignal: input.signal } : undefined,
      );
      // ACP 消息按线序到达，但 SDK 会分别调度 notification handler 与 request
      // completion；让同一批已到达的 text chunk 先完成投影，避免末分片丢失。
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (input.signal?.aborted || response.stopReason === "cancelled") {
        throw makeAbortError("Kimi ACP 调用已取消。");
      }
      if (outputExceeded) {
        throw new KimiAcpRuntimeError(
          "Kimi Agent 最终回复超过输出上限。",
          false,
          "output_limit",
        );
      }
      if (safetyViolation) {
        throw new KimiAcpRuntimeError(
          "Kimi Agent 请求了 Council headless 策略禁止的工具。",
          false,
          "permission_denied",
        );
      }
      if (response.stopReason !== "end_turn") {
        throw new KimiAcpRuntimeError(
          `Kimi Agent 未完成回复：${response.stopReason}。`,
          response.stopReason === "max_tokens",
          `stop_${response.stopReason}`,
        );
      }
      const content = output.trim();
      if (!content) {
        throw new KimiAcpRuntimeError(
          "Kimi Agent 没有返回公开文本。",
          true,
          "empty_response",
        );
      }
      return { content, sessionId: managed.sessionId };
    } catch (error) {
      if (input.signal?.aborted) {
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : makeAbortError("Kimi ACP 调用已取消。");
      }
      throw publicRuntimeError(error);
    } finally {
      input.signal?.removeEventListener("abort", cancel);
      managed.activeTurn = undefined;
      managed.promptActive = false;
    }
  }

  async closeBinding(bindingId: string): Promise<void> {
    const managed = this.#processes.get(bindingId);
    if (!managed) {
      return;
    }
    this.#processes.delete(bindingId);
    try {
      if (managed.promptActive) {
        await managed.connection.agent.notify(methods.agent.session.cancel, {
          sessionId: managed.sessionId,
        }).catch(() => undefined);
      }
      managed.connection.close();
    } finally {
      await terminateProcessTree(
        managed.child,
        managed.completion,
        this.config.kimiKillGraceMs,
      );
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#processes.keys()].map(async (bindingId) =>
        await this.closeBinding(bindingId)),
    );
  }

  async #open(
    bindingId: string,
    cwd: string,
    model: string,
    sessionId?: string,
  ): Promise<ManagedKimiProcess> {
    const rootRealPath = realpathSync(cwd);
    const child = spawn(
      this.config.kimiCommand,
      ["--work-dir", cwd, "--model", model, "--plan", "acp"],
      {
        cwd,
        detached: IS_POSIX,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    child.stderr.resume();
    const completion = new Promise<void>((resolve) => {
      child.once("error", resolve);
      child.once("close", () => resolve());
    });

    let managed: ManagedKimiProcess | undefined;
    const app = client({ name: "Council" })
      .onRequest(methods.client.session.requestPermission, (context) => {
        const request = context.params;
        managed?.activeTurn?.onPermission?.(request);
        const kind = request.toolCall.kind ?? "other";
        const allowed = READ_ONLY_TOOL_KINDS.has(kind);
        const option = request.options.find((candidate) =>
          candidate.kind === (allowed ? "allow_once" : "reject_once"))
          ?? (!allowed
            ? request.options.find((candidate) => candidate.kind === "reject_always")
            : undefined);
        return option
          ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      })
      .onRequest(methods.client.fs.readTextFile, (context) => ({
        content: readProjectText(
          managed?.rootRealPath ?? rootRealPath,
          context.params.path,
          context.params.line,
          context.params.limit,
          this.config.kimiMaxFileReadChars,
        ),
      }))
      .onRequest(methods.client.fs.writeTextFile, () => {
        throw new Error("Council headless Kimi Runtime 禁止写文件。");
      })
      .onNotification(methods.client.session.update, (context) => {
        if (context.params.sessionId === managed?.sessionId) {
          managed.activeTurn?.onUpdate?.(context.params.update);
        }
      });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );
    const connection = app.connect(stream);
    const startupSignal = AbortSignal.timeout(this.config.kimiStartupTimeoutMs);
    try {
      await connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "Council", version: "1" },
        },
        { cancellationSignal: startupSignal },
      );
      const session = sessionId
        ? await connection.agent.request(
            methods.agent.session.resume,
            { sessionId, cwd, mcpServers: [] },
            { cancellationSignal: startupSignal },
          ).then(() => ({ sessionId }))
        : await connection.agent.request(
            methods.agent.session.new,
            { cwd, mcpServers: [] },
            { cancellationSignal: startupSignal },
          );
      managed = {
        bindingId,
        cwd,
        rootRealPath,
        model,
        sessionId: session.sessionId,
        child,
        connection,
        completion,
        promptActive: false,
      };
      this.#processes.set(bindingId, managed);
      void completion.then(() => {
        if (this.#processes.get(bindingId) === managed) {
          this.#processes.delete(bindingId);
        }
      });
      return managed;
    } catch (error) {
      connection.close(error);
      await terminateProcessTree(child, completion, this.config.kimiKillGraceMs);
      throw publicRuntimeError(error);
    }
  }
}
