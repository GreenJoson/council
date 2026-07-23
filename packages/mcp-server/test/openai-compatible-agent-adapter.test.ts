/**
 * @input  依赖：假远程运行时、假设置服务、公开编排上下文与 AbortSignal
 * @output 导出：兼容 Provider 安全失败原因与未知异常隔离测试
 * @pos    远程 Agent 适配器公开诊断边界的回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AgentInvocationError, type AgentInvocation } from "council-orchestrator";
import type { AgentSettingsService } from "../src/agent-settings-service.js";
import {
  OpenAICompatibleRuntime,
  OpenAICompatibleRuntimeError,
  type OpenAICompatibleGenerateInput,
} from "../src/openai-compatible-runtime.js";
import { OpenAICompatibleAgentAdapter } from "../src/orchestration/openai-compatible-agent-adapter.js";

class FailingRuntime {
  constructor(private readonly error: Error) {}

  async generate(_input: OpenAICompatibleGenerateInput): Promise<never> {
    throw this.error;
  }
}

const settings = {
  get: () => ({
    id: "remote-test",
    label: "Remote Test",
    kind: "openai-compatible",
    model: "test-model",
    baseUrl: "https://example.com/v1",
    enabled: true,
    requiresApiKey: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  getApiKey: async () => "test-key",
} as unknown as AgentSettingsService;

function invocation(): AgentInvocation {
  return {
    runId: "run_remote_adapter_test",
    topicId: "topic_remote_adapter_test",
    roundNumber: 1,
    attempt: 1,
    adapterId: "remote-test",
    publicAuthor: "other",
    instruction: "给出可验证结论。",
    messageKind: "proposal",
    context: {
      topicId: "topic_remote_adapter_test",
      title: "远程适配器边界",
      question: "哪些失败原因可以公开？",
      constraints: [],
      messages: [],
    },
  };
}

function adapter(error: Error): OpenAICompatibleAgentAdapter {
  return new OpenAICompatibleAgentAdapter(
    "remote-test",
    new FailingRuntime(error) as unknown as OpenAICompatibleRuntime,
    settings,
    10_000,
  );
}

test("远程运行时定义的脱敏原因可以进入公开失败边界", async () => {
  await assert.rejects(
    adapter(new OpenAICompatibleRuntimeError(
      "远程模型返回失败状态。",
      false,
      "authentication",
    )).invoke(invocation(), { signal: new AbortController().signal }),
    (error: unknown) =>
      error instanceof AgentInvocationError
      && !error.retryable
      && error.publicMessage === "远程模型返回失败状态。",
  );
});

test("未知远程异常不会进入公开失败边界", async () => {
  await assert.rejects(
    adapter(new Error("private upstream detail")).invoke(
      invocation(),
      { signal: new AbortController().signal },
    ),
    (error: unknown) =>
      error instanceof AgentInvocationError
      && error.retryable
      && error.publicMessage === undefined
      && !error.message.includes("private upstream detail"),
  );
});
