/**
 * @input  依赖：AgentProgressHub、统一 RuntimeEvent 与公开运行元数据
 * @output 导出：Runtime 事件桥、草稿顺序、替换、长度边界、快照和完成清理测试
 * @pos    Agent 临时草稿不写库但仍保持有界、可重连和可预测的兼容桥回归
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentProgressHub,
  type AgentProgressEvent,
} from "../src/orchestration/agent-progress-hub.js";

const META = {
  runId: "run_test",
  topicId: "topic_test",
  adapterId: "claude",
} as const;

test("AgentProgressHub 按序发布有界草稿并在完成后清理快照", () => {
  const hub = new AgentProgressHub(8);
  const events: AgentProgressEvent[] = [];
  const unsubscribe = hub.subscribe((event) => events.push(event));

  hub.reset(META);
  hub.append(META, "abcd");
  hub.append(META, "efghijk");
  assert.equal(hub.snapshots()[0]?.content, "abcdefgh");
  assert.deepEqual(events.map((event) => event.operation), ["reset", "append", "append"]);
  assert.equal(events[2]?.content, "efgh");

  hub.replace(META, "123456789");
  assert.equal(hub.snapshots()[0]?.content, "12345678");
  hub.complete(META);
  assert.deepEqual(hub.snapshots(), []);
  assert.equal(events.at(-1)?.operation, "complete");

  unsubscribe();
});

test("AgentProgressHub 将统一 RuntimeEvent 投影成现有 SSE 草稿协议", () => {
  const hub = new AgentProgressHub(20);
  const events: AgentProgressEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const base = {
    schemaVersion: 1 as const,
    occurredAt: "2026-07-27T00:00:00.000Z",
    ...META,
    runtimeBindingId: "binding_test",
  };

  hub.emit({ ...base, type: "turn.started" });
  hub.emit({
    ...base,
    type: "text.updated",
    operation: "append",
    content: "统一事件",
  });
  hub.emit({ ...base, type: "usage.updated", inputTokens: 12 });
  assert.equal(hub.snapshots()[0]?.content, "统一事件");
  hub.emit({ ...base, type: "turn.completed" });

  assert.deepEqual(
    events.map((event) => event.operation),
    ["reset", "append", "complete"],
  );
  assert.deepEqual(hub.snapshots(), []);
});
