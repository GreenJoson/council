/**
 * @input  依赖：RuntimeBinding、RuntimeSessionRef 投影与工具所有权校验
 * @output 验证：session 单一真源、delegated/tool-loop 所有权、能力缺口和只读边界
 * @pos    统一 Runtime 契约的 fail-closed 回归；不得启动真实 Agent 或工具
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  OrchestrationConfigError,
  assertRuntimeToolEventAllowed,
  runtimeSessionRefFromBinding,
  type RuntimeBinding,
  type RuntimeToolEvent,
} from "../src/index.js";

const BINDING: RuntimeBinding = {
  id: "binding_runtime_test",
  topicId: "topic_runtime_test",
  agentId: "claude",
  actorId: "claude",
  providerId: "provider_claude",
  bindingRevision: "binding:claude:1",
  agentConfigRevision: 3,
  providerConfigRevision: 4,
  transportKind: "claude-resume",
  sessionId: "session_test",
  cursor: {
    createdAt: "2026-07-27T00:00:00.000Z",
    messageId: "message_test",
  },
  status: "idle",
  stateVersion: 7,
  epoch: 8,
  lastActivityAt: "2026-07-27T00:00:00.000Z",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

function toolEvent(
  owner: RuntimeToolEvent["owner"],
  requiredCapability: RuntimeToolEvent["requiredCapability"],
): RuntimeToolEvent {
  return {
    schemaVersion: 1,
    type: "tool.requested",
    occurredAt: "2026-07-27T00:00:00.000Z",
    runId: "run_runtime_test",
    topicId: BINDING.topicId,
    adapterId: BINDING.agentId,
    runtimeBindingId: BINDING.id,
    callId: "call_test",
    toolName: "read_file",
    owner,
    requiredCapability,
  };
}

test("RuntimeSessionRef 只投影 RuntimeBinding 的会话定位字段", () => {
  const reference = runtimeSessionRefFromBinding(BINDING);
  assert.deepEqual(reference, {
    schemaVersion: 1,
    bindingId: BINDING.id,
    topicId: BINDING.topicId,
    agentId: BINDING.agentId,
    providerId: BINDING.providerId,
    transportKind: BINDING.transportKind,
    bindingRevision: BINDING.bindingRevision,
    epoch: BINDING.epoch,
    sessionId: BINDING.sessionId,
    cursor: BINDING.cursor,
  });
  assert.notEqual(reference.cursor, BINDING.cursor);
  assert.equal("stateVersion" in reference, false);
  assert.equal("processInstanceId" in reference, false);
});

test("DelegatedRuntime 的工具事件必须由 runtime 拥有且能力已授权", () => {
  assert.doesNotThrow(() => assertRuntimeToolEventAllowed(
    toolEvent("runtime", "repository_read"),
    {
      executionKind: "delegated",
      grantedCapabilities: ["repository_read"],
    },
  ));
  assert.throws(
    () => assertRuntimeToolEventAllowed(
      toolEvent("council", "repository_read"),
      {
        executionKind: "delegated",
        grantedCapabilities: ["repository_read"],
      },
    ),
    OrchestrationConfigError,
  );
});

test("Council ToolLoop 只允许自己执行已授权的只读工具", () => {
  assert.doesNotThrow(() => assertRuntimeToolEventAllowed(
    toolEvent("council", "git_diff"),
    {
      executionKind: "tool-loop",
      grantedCapabilities: ["git_diff"],
    },
  ));
  assert.throws(
    () => assertRuntimeToolEventAllowed(
      toolEvent("runtime", "git_diff"),
      {
        executionKind: "tool-loop",
        grantedCapabilities: ["git_diff"],
      },
    ),
    OrchestrationConfigError,
  );
  assert.throws(
    () => assertRuntimeToolEventAllowed(
      toolEvent("council", "repository_write"),
      {
        executionKind: "tool-loop",
        grantedCapabilities: ["repository_write"],
      },
    ),
    /禁止执行非只读能力/,
  );
});

test("Runtime 工具能力未获 Council policy 授权时默认拒绝", () => {
  assert.throws(
    () => assertRuntimeToolEventAllowed(
      toolEvent("runtime", "repository_read"),
      {
        executionKind: "delegated",
        grantedCapabilities: ["text"],
      },
    ),
    /未获授权能力/,
  );
});
