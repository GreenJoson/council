/**
 * @input  依赖：假远程运行时、假模型路由服务、公开编排上下文与 AbortSignal
 * @output 导出：兼容 Provider 安全失败原因与未知异常隔离测试
 * @pos    远程 Agent 适配器公开诊断边界的回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInvocationError,
  type AgentInvocation,
  type RuntimeEvent,
} from "council-orchestrator";
import type { ModelRouterService } from "../src/model-router-service.js";
import { OpenAICompatibleRuntimeError } from "../src/openai-compatible-runtime.js";
import { OpenAICompatibleAgentAdapter } from "../src/orchestration/openai-compatible-agent-adapter.js";
import {
  ReadOnlyAgentLoop,
  type ReadOnlyAgentLoopInput,
} from "../src/read-only-agent-loop.js";

class FailingRuntime {
  constructor(private readonly error: Error) {}

  async generate(_input: ReadOnlyAgentLoopInput): Promise<never> {
    throw this.error;
  }
}

const settings = {
  getAgent: () => ({
    id: "remote-test",
    actorId: "actor-remote-test",
    providerId: "provider-remote-test",
    slug: "remote-test",
    displayName: "Remote Test",
    model: "test-model",
    mentionAlias: "remote-test",
    enabled: true,
    deletedAt: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  getProvider: () => ({
    id: "provider-remote-test",
    slug: "remote-test",
    displayName: "Remote Test",
    protocol: "openai-compatible",
    baseUrl: "https://example.com/v1",
    requiresApiKey: true,
    credentialRef: "provider-remote-test",
    brandAssetId: "brand-remote-test",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  getApiKeyForAgent: async () => "test-key",
} as unknown as ModelRouterService;

function invocation(): AgentInvocation {
  return {
    runId: "run_remote_adapter_test",
    topicId: "topic_remote_adapter_test",
    roundNumber: 1,
    attempt: 1,
    adapterId: "remote-test",
    actorId: "deepseek",
    runtimeBindingId: "binding_remote_test",
    firstTurn: true,
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
    new FailingRuntime(error) as unknown as ReadOnlyAgentLoop,
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

test("远程只读工具事件明确归 Council ToolLoop 所有", async () => {
  const runtime = {
    generate: async (input: ReadOnlyAgentLoopInput) => {
      input.onToolEvent?.({
        type: "tool.requested",
        callId: "call-read",
        toolName: "council_read_text_file",
      });
      input.onToolEvent?.({
        type: "tool.completed",
        callId: "call-read",
        toolName: "council_read_text_file",
      });
      return "代码证据结论";
    },
  };
  const current = invocation();
  current.context.projectPath = process.cwd();
  const events: RuntimeEvent[] = [];
  const currentAdapter = new OpenAICompatibleAgentAdapter(
    "remote-test",
    runtime as unknown as ReadOnlyAgentLoop,
    settings,
    10_000,
  );

  const result = await currentAdapter.invoke(current, {
    signal: new AbortController().signal,
    runtimeEvents: {
      emit: (event) => events.push(event),
    },
  });

  assert.match(result.content, /代码证据结论/u);
  assert.deepEqual(events.map((event) => event.type), [
    "tool.requested",
    "tool.completed",
  ]);
  const requested = events[0];
  assert.equal(requested?.type, "tool.requested");
  if (requested?.type === "tool.requested") {
    assert.equal(requested.owner, "council");
  }
});
