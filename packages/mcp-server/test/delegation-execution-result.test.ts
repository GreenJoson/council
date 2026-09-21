/** @input 正常完成摘要与阶段交接协议；@output 未完成/格式错误不进入交付的验证；@pos 验证边界而非模型效果。 */
import assert from "node:assert/strict";
import test from "node:test";
import { executionHandoff } from "../src/orchestration/delegation-execution-result.js";

test("正常完成保持原摘要，未完成交接明确保留剩余步骤", () => {
  assert.equal(executionHandoff("Implemented and verified"), undefined);
  const handoff = executionHandoff('COUNCIL_CHECKPOINT\n{"completed":["implemented"],"validation":["tests not run"],"remaining":["run tests"]}');
  assert.match(handoff ?? "", /尚未独立验收/);
  assert.match(handoff ?? "", /run tests/);
});

test("损坏、缺剩余工作、无验证说明或超预算的交接不能当作完成", () => {
  for (const value of ["broken", "[]", '{"completed":[],"validation":[],"remaining":["next"]}',
    '{"completed":[],"validation":["none"],"remaining":[]}',
    JSON.stringify({ completed: [], validation: ["none"], remaining: ["x".repeat(1_001)] })]) {
    assert.throws(() => executionHandoff("COUNCIL_CHECKPOINT\n" + value), /交接格式无效/);
  }
});
