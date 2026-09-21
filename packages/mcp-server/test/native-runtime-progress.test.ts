/** @input CLI 结构化失败和活动事件；@output 分类、去重和白名单隐私回归；@pos 不凭错误正文猜测模型权限。 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyClaudeFailure, NativeRuntimeProgressTracker, type NativeRuntimeProgress } from "../src/native-runtime-progress.js";

test("结构化终止原因优先，额度/权限/瞬态失败明确区分且不透出原文", () => {
  const cases: Array<[unknown, string, boolean]> = [
    [{ subtype: "error_max_turns", errors: ["private error"] }, "max_turns_exhausted", false],
    [{ subtype: "error_max_budget_usd" }, "budget_exhausted", false],
    [{ errors: ["You've hit your session limit · resets later; private detail"] }, "quota_exhausted", false],
    [{ result: "Not logged in: private detail" }, "authentication_failed", false],
    [{ result: "invalid model: private detail" }, "model_unavailable", false],
    [{ subtype: "error_max_structured_output_retries" }, "invalid_result", false],
    [{ permission_denials: [{ tool_name: "Bash", tool_input: "private command" }] }, "permission_denied", false],
    [{ errors: ["service unavailable: private detail"] }, "transient_failure", true],
    [{ errors: ["private unexpected diagnostic"] }, "request_failed", false],
  ];
  for (const [raw, code, retryable] of cases) {
    const result = classifyClaudeFailure(raw);
    assert.equal(result.diagnosticCode, code); assert.equal(result.retryable, retryable);
    assert.doesNotMatch(result.message, /private/);
  }
});

test("Claude 进度保存早期 session、按消息及工具 ID 去重且只透出白名单", () => {
  const events: NativeRuntimeProgress[] = [];
  const tracker = new NativeRuntimeProgressTracker("claude", p => events.push(p), 120);
  tracker.observe({ type: "system", session_id: "test-session", cwd: "/private/path" });
  const message = { type: "assistant", message: { id: "msg-1", content: [
    { type: "thinking", thinking: "private reasoning" },
    { type: "tool_use", id: "tool-1", name: "Read", input: { file: "/private/file" } },
  ] } };
  tracker.observe(message); tracker.observe(message);
  tracker.observe({ type: "result", subtype: "error_max_turns", num_turns: 121, errors: ["private diagnostic"] });
  assert.equal(events.length, 3);
  assert.deepEqual(events[1], { sessionId: "test-session", turnLimit: 120, turnsUsed: 1, toolCalls: 1, lastTool: "Read" });
  assert.equal(tracker.snapshot.turnsUsed, 121);
  assert.equal(tracker.snapshot.stopReason, "error_max_turns");
  assert.doesNotMatch(JSON.stringify(events), /private|thinking|input/);
});

test("Codex 工具起止去重，不伪造不可观测的回合预算", () => {
  const tracker = new NativeRuntimeProgressTracker("codex");
  tracker.observe({ type: "thread.started", thread_id: "test-thread" });
  for (const type of ["item.started", "item.completed"]) tracker.observe({ type, item: { id: "item-1", type: "command_execution", command: "private command" } });
  tracker.observe({ type: "turn.completed" });
  assert.deepEqual(tracker.snapshot, { sessionId: "test-thread", toolCalls: 1, lastTool: "command_execution", stopReason: "success" });
});
