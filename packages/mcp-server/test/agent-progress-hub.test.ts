/**
 * @input  依赖：AgentProgressHub 与公开运行元数据
 * @output 导出：草稿顺序、替换、长度边界、快照和完成清理测试
 * @pos    Agent 临时草稿不写库但仍保持有界、可重连和可预测的回归验证
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
