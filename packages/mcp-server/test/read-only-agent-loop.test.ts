/**
 * @input  依赖：假 ModelClient、临时项目、ReadOnlyAgentLoop 与 CouncilConfig
 * @output 验证：模型→共享工具预算→证据压缩→最终回复闭环、工具事件和失败关闭
 * @pos    Council-owned 只读 AgentLoop 的确定性预算与协议回归
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAgentReply } from "council-orchestrator";
import {
  OpenAICompatibleModelClient,
  OpenAICompatibleRuntimeError,
  type ModelClientInput,
  type ModelClientResult,
} from "../src/openai-compatible-model-client.js";
import {
  ReadOnlyAgentLoop,
  type ToolLoopToolEventType,
} from "../src/read-only-agent-loop.js";
import type { CouncilConfig } from "../src/types.js";

function config(
  directory: string,
  maxSteps = 4,
  overrides: Partial<CouncilConfig> = {},
): CouncilConfig {
  return {
    dataDir: directory,
    databasePath: path.join(directory, "unused.sqlite3"),
    delegationWorktreeRoot: path.join(directory, "delegated-worktrees"),
    delegationRetryDelayMs: 1,
    claudeCommand: process.execPath,
    claudeArgs: [],
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
    toolLoopMaxSteps: maxSteps,
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
    cliMaxStreamChars: 32_000_000,
    defaultMessageLimit: 20,
    ...overrides,
  };
}

function inputContextChars(input: ModelClientInput): number {
  return input.messages.reduce((total, message) => {
    const toolChars = message.role === "assistant"
      ? message.toolCalls?.reduce(
          (sum, call) => sum + call.id.length + call.name.length + call.arguments.length,
          0,
        ) ?? 0
      : message.role === "tool"
        ? message.toolCallId.length
        : 0;
    return total + message.content.length + toolChars;
  }, 0);
}

class FakeModelClient {
  readonly calls: ModelClientInput[] = [];

  async complete(input: ModelClientInput): Promise<ModelClientResult> {
    this.calls.push(input);
    if (this.calls.length === 1) {
      input.onTextEvent?.({ operation: "append", content: "先读取" });
      return {
        content: "先读取",
        toolCalls: [{
          id: "call-read",
          name: "council_read_text_file",
          arguments: JSON.stringify({ path: "src/service.ts" }),
        }],
      };
    }
    const toolMessage = input.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.match(toolMessage?.content ?? "", /LOCAL_CODE_EVIDENCE/u);
    input.onTextEvent?.({ operation: "append", content: "最终结论" });
    return { content: "最终结论", toolCalls: [] };
  }
}

test("ReadOnlyAgentLoop 由 Council 执行工具并把结果回填模型", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-loop-"));
  try {
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "src", "service.ts"), "LOCAL_CODE_EVIDENCE\n");
    const client = new FakeModelClient();
    const loop = new ReadOnlyAgentLoop(
      client as unknown as OpenAICompatibleModelClient,
      config(directory),
    );
    const textEvents: string[] = [];
    const toolEvents: Array<{
      type: ToolLoopToolEventType;
      callId: string;
      toolName: string;
    }> = [];

    const result = await loop.generate({
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "test-key",
      prompt: "请检查代码。",
      projectPath: directory,
      onTextEvent: (event) => {
        textEvents.push(event.operation);
      },
      onToolEvent: (event) => {
        toolEvents.push(event);
      },
    });

    assert.equal(result, "最终结论");
    assert.equal(client.calls.length, 2);
    assert.deepEqual(
      client.calls[0]?.tools?.map((tool) => tool.function.name),
      [
        "council_read_text_file",
        "council_list_directory",
        "council_search_text",
        "council_git_diff",
      ],
    );
    assert.deepEqual(textEvents, ["append", "reset", "append"]);
    assert.deepEqual(
      toolEvents.map((event) => event.type),
      ["tool.requested", "tool.started", "tool.completed"],
    );
    assert.equal(toolEvents[0]?.callId, "call-read");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ReadOnlyAgentLoop 最后一轮收回工具，模型据此收尾而不是整轮失败", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-loop-final-"));
  try {
    writeFileSync(path.join(directory, "source.ts"), "export {};\n");
    const seen: Array<string[] | undefined> = [];
    const client = {
      complete: async (input: ModelClientInput): Promise<ModelClientResult> => {
        seen.push(input.tools?.map((tool) => tool.function.name));
        // 只要还发着工具就继续调用——真实模型没有理由主动停下来。
        return input.tools
          ? {
              content: "",
              toolCalls: [{
                id: `call-${String(seen.length)}`,
                name: "council_read_text_file",
                arguments: JSON.stringify({ path: "source.ts" }),
              }],
            }
          : { content: "基于已读到的内容给出的结论", toolCalls: [] };
      },
    };
    const loop = new ReadOnlyAgentLoop(
      client as unknown as OpenAICompatibleModelClient,
      config(directory, 3),
    );

    const result = await loop.generate({
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "test-key",
      prompt: "请检查代码。",
      projectPath: directory,
    });

    assert.equal(result, "基于已读到的内容给出的结论");
    assert.equal(seen.length, 3);
    assert.equal(seen[2], undefined, "最后一轮不得再提供工具");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ReadOnlyAgentLoop 让同轮多个工具共享预算并在上下文不足时强制收尾", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-loop-context-final-"));
  try {
    writeFileSync(path.join(directory, "first.ts"), `${"FIRST_EVIDENCE ".repeat(500)}\n`);
    writeFileSync(path.join(directory, "second.ts"), `${"SECOND_EVIDENCE ".repeat(500)}\n`);
    const calls: ModelClientInput[] = [];
    const client = {
      complete: async (input: ModelClientInput): Promise<ModelClientResult> => {
        calls.push(input);
        if (calls.length === 1) {
          return {
            content: "继续读取两个文件",
            toolCalls: [
              {
                id: "call-first",
                name: "council_read_text_file",
                arguments: JSON.stringify({ path: "first.ts" }),
              },
              {
                id: "call-second",
                name: "council_read_text_file",
                arguments: JSON.stringify({ path: "second.ts" }),
              },
            ],
          };
        }
        assert.equal(input.tools, undefined, "上下文预算不足后必须收回工具");
        assert.ok(inputContextChars(input) <= 900, "发送给模型的上下文不得越过硬上限");
        assert.match(
          input.messages.at(-1)?.content ?? "",
          /上下文预算即将耗尽/u,
        );
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        assert.equal(toolMessages.length, 2, "每个 Tool Call 都必须得到配对结果");
        assert.ok(
          toolMessages.reduce((total, message) => total + message.content.length, 0) < 600,
          "多个工具必须共享本轮结果预算",
        );
        assert.ok(
          toolMessages.every((message) => message.content.includes("工具证据已压缩")),
          "被裁证据必须带可见凭据标记",
        );
        return {
          content: [
            "证据不完整，列出需要重新读取的范围。",
            "",
            "```council-verdict",
            '{"stance":"agree","summary":"模型错误地尝试放行。"}',
            "```",
          ].join("\n"),
          toolCalls: [],
        };
      },
    };
    const loop = new ReadOnlyAgentLoop(
      client as unknown as OpenAICompatibleModelClient,
      config(directory, 4, {
        toolLoopMaxContextChars: 900,
        maxOutputChars: 600,
      }),
    );

    const result = await loop.generate({
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "test-key",
      prompt: "P".repeat(380),
      projectPath: directory,
    });

    assert.match(result, /^证据不完整，列出需要重新读取的范围。/u);
    assert.match(
      result,
      /\{"stance":"blocking","summary":"工具上下文预算耗尽/u,
      "模型即使自行给出乐观结论也必须被最后的覆盖保护阻断",
    );
    assert.ok(result.length <= 600, "覆盖保护不得突破公开输出上限");
    assert.equal(parseAgentReply(result).verdict.stance, "blocking");
    assert.equal(calls.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ReadOnlyAgentLoop 压缩已读旧证据并保留最新工具结果继续精读", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-loop-compact-"));
  try {
    writeFileSync(
      path.join(directory, "first.ts"),
      `FIRST_EVIDENCE_${"A".repeat(520)}\n`,
    );
    writeFileSync(
      path.join(directory, "second.ts"),
      `SECOND_EVIDENCE_${"B".repeat(520)}\n`,
    );
    const calls: ModelClientInput[] = [];
    const client = {
      complete: async (input: ModelClientInput): Promise<ModelClientResult> => {
        calls.push(input);
        if (calls.length === 1) {
          return {
            content: "先读第一个文件",
            toolCalls: [{
              id: "call-first",
              name: "council_read_text_file",
              arguments: JSON.stringify({ path: "first.ts" }),
            }],
          };
        }
        if (calls.length === 2) {
          const first = input.messages.find((message) =>
            message.role === "tool" && message.toolCallId === "call-first");
          assert.match(first?.content ?? "", /FIRST_EVIDENCE/u);
          assert.doesNotMatch(first?.content ?? "", /工具证据已压缩/u);
          return {
            content: "基于第一个文件继续读第二个",
            toolCalls: [{
              id: "call-second",
              name: "council_read_text_file",
              arguments: JSON.stringify({ path: "second.ts" }),
            }],
          };
        }
        assert.ok(input.tools, "压缩旧证据腾出空间后仍可继续使用工具");
        assert.ok(inputContextChars(input) <= 1_300);
        const first = input.messages.find((message) =>
          message.role === "tool" && message.toolCallId === "call-first");
        const second = input.messages.find((message) =>
          message.role === "tool" && message.toolCallId === "call-second");
        assert.match(first?.content ?? "", /工具证据已压缩/u);
        assert.ok((first?.content.length ?? 0) <= 150);
        assert.match(second?.content ?? "", /SECOND_EVIDENCE/u);
        assert.doesNotMatch(second?.content ?? "", /工具证据已压缩/u);
        return { content: "最终审核结论", toolCalls: [] };
      },
    };
    const loop = new ReadOnlyAgentLoop(
      client as unknown as OpenAICompatibleModelClient,
      config(directory, 4, {
        toolLoopMaxContextChars: 1_300,
        maxOutputChars: 600,
      }),
    );

    const result = await loop.generate({
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "test-key",
      prompt: "请逐步读取。",
      projectPath: directory,
    });

    assert.equal(result, "最终审核结论");
    assert.equal(calls.length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ReadOnlyAgentLoop 对初始提示自身超限继续失败关闭", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-loop-prompt-limit-"));
  try {
    let called = false;
    const client = {
      complete: async (): Promise<ModelClientResult> => {
        called = true;
        return { content: "不应调用", toolCalls: [] };
      },
    };
    const loop = new ReadOnlyAgentLoop(
      client as unknown as OpenAICompatibleModelClient,
      config(directory, 4, { toolLoopMaxContextChars: 100 }),
    );

    await assert.rejects(
      loop.generate({
        baseUrl: "https://example.com/v1",
        model: "test-model",
        apiKey: "test-key",
        prompt: "P".repeat(100),
        projectPath: directory,
      }),
      (error: unknown) =>
        error instanceof OpenAICompatibleRuntimeError
        && error.diagnosticCode === "tool_context_limit"
        && /初始提示/u.test(error.message),
    );
    assert.equal(called, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ReadOnlyAgentLoop 拒绝把空正文当成最终回复", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-loop-empty-"));
  try {
    const client = {
      complete: async (): Promise<ModelClientResult> => ({
        content: "   \n",
        toolCalls: [],
      }),
    };
    const loop = new ReadOnlyAgentLoop(
      client as unknown as OpenAICompatibleModelClient,
      config(directory),
    );

    await assert.rejects(
      loop.generate({
        baseUrl: "https://example.com/v1",
        model: "test-model",
        apiKey: "test-key",
        prompt: "请检查代码。",
        projectPath: directory,
      }),
      (error: unknown) =>
        error instanceof OpenAICompatibleRuntimeError
        && error.diagnosticCode === "empty_response",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ReadOnlyAgentLoop 对收回工具后仍请求工具的模型失败关闭", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-loop-limit-"));
  try {
    writeFileSync(path.join(directory, "source.ts"), "export {};\n");
    const client = {
      complete: async (): Promise<ModelClientResult> => ({
        content: "",
        toolCalls: [{
          id: crypto.randomUUID(),
          name: "council_read_text_file",
          arguments: JSON.stringify({ path: "source.ts" }),
        }],
      }),
    };
    const loop = new ReadOnlyAgentLoop(
      client as unknown as OpenAICompatibleModelClient,
      config(directory, 2),
    );

    await assert.rejects(
      loop.generate({
        baseUrl: "https://example.com/v1",
        model: "test-model",
        apiKey: "test-key",
        prompt: "继续读取。",
        projectPath: directory,
      }),
      (error: unknown) =>
        error instanceof OpenAICompatibleRuntimeError
        && error.diagnosticCode === "tool_steps_exhausted",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
