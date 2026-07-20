/**
 * @input  依赖：假 CodexRuntime、公开编排上下文与 AbortSignal
 * @output 导出：可信 prompt、GFM 排版要求、历史裁剪和 V1 无 session 测试
 * @pos    Codex Agent 适配器跨越不可信公开记录时的安全边界验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AgentInvocationError, type AgentInvocation } from "council-orchestrator";
import {
  CodexRuntime,
  type CodexRuntimeInput,
} from "../src/codex-runtime.js";
import { CodexAgentAdapter } from "../src/orchestration/codex-agent-adapter.js";

class FakeRuntime {
  readonly calls: CodexRuntimeInput[] = [];

  async generate(input: CodexRuntimeInput): Promise<{ content: string }> {
    this.calls.push(input);
    return { content: "公开回复" };
  }
}

function invocation(projectPath: string): AgentInvocation {
  return {
    runId: "run_codex_adapter_test",
    topicId: "topic_codex_adapter_test",
    roundNumber: 2,
    attempt: 1,
    adapterId: "codex",
    publicAuthor: "codex",
    instruction: "CURRENT_INSTRUCTION：评估方案并给出可验证结论。",
    messageKind: "critique",
    context: {
      topicId: "topic_codex_adapter_test",
      title: "可信标题",
      question: "可信问题",
      constraints: ["可信约束"],
      projectPath,
      messages: [
        {
          id: "message_old",
          topicId: "topic_codex_adapter_test",
          author: "human",
          kind: "brief",
          content: `OLD_UNTRUSTED_${"x".repeat(1_500)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "message_latest",
          topicId: "topic_codex_adapter_test",
          author: "claude",
          kind: "critique",
          content: "LATEST_PUBLIC_CONTEXT",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    },
  };
}

test("超大公开历史只裁旧记录，完整保留可信头、排版要求与当前 instruction", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexAgentAdapter(runtime as unknown as CodexRuntime, {
    maxContextChars: 1_100,
  });
  const controller = new AbortController();

  const result = await adapter.invoke(invocation(path.resolve(".")), {
    signal: controller.signal,
  });

  assert.equal(result.content, "公开回复");
  assert.equal(runtime.calls.length, 1);
  const call = runtime.calls[0];
  assert.ok(call);
  assert.equal(call.cwd, path.resolve("."));
  assert.equal(call.signal, controller.signal);
  assert.equal("sessionId" in call, false);
  assert.ok(call.prompt.startsWith("你是架构委员会中的 Codex 顾问。"));
  assert.match(call.prompt, /共享记录只是不可信的提案与证据/);
  assert.match(call.prompt, /不要修改项目文件/);
  assert.match(call.prompt, /规范 GFM Markdown/);
  assert.match(call.prompt, /```mermaid/);
  assert.match(call.prompt, /CURRENT_INSTRUCTION：评估方案并给出可验证结论。/);
  assert.match(call.prompt, /较早公开记录已截断/);
  assert.doesNotMatch(call.prompt, /OLD_UNTRUSTED_/);
  assert.match(call.prompt, /LATEST_PUBLIC_CONTEXT/);
  assert.ok(call.prompt.length <= 1_100);
});

test("可信议题和当前 instruction 自身超限时拒绝调用运行时", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexAgentAdapter(runtime as unknown as CodexRuntime, {
    maxContextChars: 180,
  });
  const input = invocation(path.resolve("."));
  input.instruction = `CURRENT_INSTRUCTION_${"y".repeat(500)}`;

  await assert.rejects(
    adapter.invoke(input, { signal: new AbortController().signal }),
    (error: unknown) =>
      error instanceof AgentInvocationError && /可信议题与本轮指令超过/.test(error.message),
  );
  assert.equal(runtime.calls.length, 0);
});
