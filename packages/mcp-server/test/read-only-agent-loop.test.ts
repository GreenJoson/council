/**
 * @input  依赖：假 ModelClient、临时项目、ReadOnlyAgentLoop 与 CouncilConfig
 * @output 验证：模型→工具→结果→最终回复闭环、工具事件和轮次上限
 * @pos    Kun 风格 Council-owned 只读 AgentLoop 的确定性回归
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

function config(directory: string, maxSteps = 4): CouncilConfig {
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
    defaultMessageLimit: 20,
  };
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
