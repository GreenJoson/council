/**
 * @input  依赖：假通用 ACP Runtime、RuntimeDefinition、假 ModelRouter、公开上下文与 RuntimeEvent
 * @output 验证：供应商无关可信 prompt、session 恢复、授权能力事件所有权与进程关闭桥
 * @pos    AcpDelegatedRuntime 接入统一编排契约的适配器边界回归
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type AgentInvocation,
  type RuntimeEvent,
} from "council-orchestrator";
import type { AcpDelegatedRuntimeInput } from "../src/acp-delegated-runtime.js";
import { AcpDelegatedRuntime } from "../src/acp-delegated-runtime.js";
import type { ModelRouterService } from "../src/model-router-service.js";
import type { AcpRuntimeDefinition } from "../src/acp-runtime-registry.js";
import { AcpDelegatedAgentAdapter } from "../src/orchestration/acp-delegated-agent-adapter.js";

const DEFINITION: AcpRuntimeDefinition = {
  id: "kimi-code",
  displayName: "Kimi Code",
  agentCommand: "kimi",
  versionArgs: ["--version"],
  modelSelection: "launch-args",
  buildLaunchArgs: () => ["--plan", "acp"],
  declaredCapabilities: [
    "text",
    "repository_read",
    "git_diff",
    "session_resume",
  ],
  limitationWhenUnavailable: "Kimi Code 不可用。",
};

class FakeRuntime {
  readonly calls: AcpDelegatedRuntimeInput[] = [];
  readonly closedBindings: string[] = [];

  async generate(
    input: AcpDelegatedRuntimeInput,
  ): Promise<{ content: string; sessionId: string }> {
    this.calls.push(input);
    input.onUpdate?.({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "增量回复" },
    });
    input.onUpdate?.({
      sessionUpdate: "tool_call",
      toolCallId: "read-call",
      title: "读取源码",
      name: "read_file",
      kind: "read",
      status: "pending",
    });
    input.onUpdate?.({
      sessionUpdate: "tool_call_update",
      toolCallId: "read-call",
      title: "读取源码",
      name: "read_file",
      kind: "read",
      status: "completed",
    });
    input.onUpdate?.({
      sessionUpdate: "tool_call",
      toolCallId: "git-call",
      title: "读取 commit diff",
      name: "council_git_diff",
      kind: "other",
      status: "pending",
    });
    input.onUpdate?.({
      sessionUpdate: "tool_call_update",
      toolCallId: "git-call",
      title: "读取 commit diff",
      name: "council_git_diff",
      kind: "other",
      status: "completed",
    });
    input.onUpdate?.({
      sessionUpdate: "usage_update",
      used: 128,
      size: 262_144,
    });
    return { content: "最终公开回复", sessionId: "session_kimi_test" };
  }

  async closeBinding(bindingId: string): Promise<void> {
    this.closedBindings.push(bindingId);
  }
}

function router(): ModelRouterService {
  return {
    getAgent: (agentId: string) => agentId === "kimi-agent"
      ? {
          id: "kimi-agent",
          actorId: "actor-kimi",
          providerId: "provider-kimi-code",
          slug: "kimi-agent",
          displayName: "Kimi Agent",
          model: "k3",
          mentionAlias: "kimi",
          enabled: true,
          configRevision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }
      : undefined,
    getProvider: (providerId: string) => providerId === "provider-kimi-code"
      ? {
          id: "provider-kimi-code",
          slug: "kimi-code",
          displayName: "Kimi Code",
          protocol: "acp",
          requiresApiKey: false,
          brandAssetId: "brand-kimi",
          status: "active",
          configRevision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }
      : undefined,
  } as unknown as ModelRouterService;
}

function invocation(projectPath: string): AgentInvocation {
  return {
    runId: "run_kimi_adapter_test",
    topicId: "topic_kimi_adapter_test",
    roundNumber: 2,
    attempt: 1,
    adapterId: "kimi-agent",
    actorId: "actor-kimi",
    runtimeBindingId: "binding-kimi",
    firstTurn: false,
    sessionId: "session_existing",
    requestMessageId: "message_request",
    instruction: "CURRENT_INSTRUCTION：只读评审当前实现。",
    messageKind: "critique",
    context: {
      topicId: "topic_kimi_adapter_test",
      title: "Kimi ACP 接入",
      question: "如何复用持久会话？",
      constraints: ["禁止写文件"],
      projectPath,
      messages: [
        {
          id: "message_delta",
          topicId: "topic_kimi_adapter_test",
          actorId: "codex",
          kind: "proposal",
          content: "DELTA_PUBLIC_CONTEXT",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
        {
          id: "message_request",
          topicId: "topic_kimi_adapter_test",
          actorId: "human",
          kind: "brief",
          content: "DUPLICATE_CURRENT_REQUEST",
          createdAt: "2026-01-01T00:02:00.000Z",
        },
      ],
    },
  };
}

test("通用 ACP 适配器复用 session 并按注册能力投影 Runtime 事件", async () => {
  const runtime = new FakeRuntime();
  const adapter = new AcpDelegatedAgentAdapter(
    "kimi-agent",
    runtime as unknown as AcpDelegatedRuntime,
    DEFINITION,
    DEFINITION.declaredCapabilities,
    router(),
    4_000,
  );
  const events: RuntimeEvent[] = [];
  let streamingNotifications = 0;

  const result = await adapter.invoke(invocation(path.resolve(".")), {
    signal: new AbortController().signal,
    notifyStreaming: () => {
      streamingNotifications += 1;
    },
    runtimeEvents: {
      emit: (event) => events.push(event),
    },
  });

  assert.match(result.content, /Provider: \*\*Kimi Code\*\*/u);
  assert.match(result.content, /最终公开回复/u);
  assert.equal(result.sessionId, "session_kimi_test");
  assert.equal(runtime.calls.length, 1);
  const call = runtime.calls[0];
  assert.ok(call);
  assert.equal(call.bindingId, "binding-kimi");
  assert.deepEqual(call.grantedCapabilities, DEFINITION.declaredCapabilities);
  assert.equal(call.sessionId, "session_existing");
  assert.equal(call.model, "k3");
  assert.match(call.prompt, /既有上下文沿用当前 ACP session/u);
  assert.match(call.prompt, /DELTA_PUBLIC_CONTEXT/u);
  assert.doesNotMatch(call.prompt, /DUPLICATE_CURRENT_REQUEST/u);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "text.updated",
      "tool.requested",
      "tool.completed",
      "tool.requested",
      "tool.completed",
      "usage.updated",
    ],
  );
  const requested = events[1];
  assert.equal(requested?.type, "tool.requested");
  if (requested?.type === "tool.requested") {
    assert.equal(requested.owner, "runtime");
    assert.equal(requested.runtimeBindingId, "binding-kimi");
  }
  const gitRequested = events[3];
  assert.equal(gitRequested?.type, "tool.requested");
  if (gitRequested?.type === "tool.requested") {
    assert.equal(gitRequested.toolName, "council_git_diff");
    assert.equal(gitRequested.owner, "runtime");
  }
  assert.equal(streamingNotifications, 1);

  await adapter.closeBinding("binding-kimi");
  assert.deepEqual(runtime.closedBindings, ["binding-kimi"]);
});

test("通用 ACP 适配器不把隐藏思考或未授权工具投影为公开事件", async () => {
  const runtime = {
    generate: async (input: AcpDelegatedRuntimeInput) => {
      const updates: SessionUpdate[] = [
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "HIDDEN_THOUGHT" },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "execute-call",
          title: "运行命令",
          name: "shell",
          kind: "execute",
          status: "pending",
        },
      ];
      updates.forEach((update) => input.onUpdate?.(update));
      return { content: "安全结论", sessionId: "session_safe" };
    },
    closeBinding: async () => undefined,
  };
  const adapter = new AcpDelegatedAgentAdapter(
    "kimi-agent",
    runtime as unknown as AcpDelegatedRuntime,
    {
      ...DEFINITION,
      declaredCapabilities: [
        ...DEFINITION.declaredCapabilities,
        "shell_write",
      ],
    },
    ["text"],
    router(),
    4_000,
  );
  const events: RuntimeEvent[] = [];

  const result = await adapter.invoke(invocation(path.resolve(".")), {
    signal: new AbortController().signal,
    runtimeEvents: {
      emit: (event) => events.push(event),
    },
  });

  assert.match(result.content, /安全结论/u);
  assert.deepEqual(events, []);
});
