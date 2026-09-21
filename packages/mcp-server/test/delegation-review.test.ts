/** @input 大报告、多文件 diff、特殊路径与不完整审核；@output 审核预算、覆盖校验和失败关闭回归；@pos 不调用真实模型。 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewEvidence, parseDelegationReview } from "../src/orchestration/delegation-review.js";

const patch = (file: string, content: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${content}\n`;

test("大 JSON 报告不遮住后面的实现和测试，省略文件必须明确补查", () => {
  const files = ["docs/report.json", "scripts/audit.ts", "scripts/audit.test.ts"];
  const diff = patch(files[0]!, "data".repeat(160_000)) + patch(files[1]!, "IMPLEMENTATION_EVIDENCE")
    + patch(files[2]!, "TEST_EVIDENCE");
  const evidence = buildReviewEvidence(diff, files, 4_000);
  assert(evidence.content.length <= 4_000);
  assert(evidence.content.indexOf("IMPLEMENTATION_EVIDENCE") < evidence.content.indexOf("+datadata"));
  assert(evidence.content.includes("TEST_EVIDENCE"));
  assert.deepEqual(evidence.omittedFiles, ["docs/report.json"]);
  assert.deepEqual(evidence.files, files);
  assert.equal(parseDelegationReview(JSON.stringify({ verdict: "approved", summary: "looks fine", findings: [] }), evidence).verdict, "blocked");
  assert.equal(parseDelegationReview(JSON.stringify({ verdict: "approved", summary: "inspected", findings: [],
    inspectedFiles: ["docs/report.json", "unrelated.txt"] }), evidence).verdict, "approved");
});

test("小 diff 保持完整；无缺失时兼容旧审核返回，但不能带问题直接批准", () => {
  const evidence = buildReviewEvidence(patch("x.ts", "complete"), ["x.ts"], 2_000);
  assert.deepEqual(evidence.omittedFiles, []);
  assert.equal(parseDelegationReview('{"verdict":"approved","summary":"ok","findings":[]}', evidence).verdict, "approved");
  assert.equal(parseDelegationReview('{"verdict":"approved","summary":"ok","findings":["bug"]}', evidence).verdict, "changes_requested");
  assert.throws(() => parseDelegationReview('{"verdict":"approved","summary":"ok","findings":[],"inspectedFiles":[3]}'), /字段无效/);
});

test("完整清单超限或 diff 不匹配时停止，不能静默漏文件", () => {
  const files = ["path with space.ts", "unicode-中文.ts", "line\nbreak.ts"];
  const evidence = buildReviewEvidence(files.map(file => patch(file, "change")).join(""), files, 2_000);
  assert(evidence.content.includes(JSON.stringify(files)));
  assert.throws(() => buildReviewEvidence(patch("x.ts", "x"), ["x.ts"], 1), /文件清单超过/);
  assert.throws(() => buildReviewEvidence(patch("x.ts", "x"), ["x.ts", "y.ts"], 3_000), /不一致/);
});

test("多份大文件均分配节选，不能让首个文件独占剩余预算", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  const evidence = buildReviewEvidence(files.map(file => patch(file, file.repeat(2_000))).join(""), files, 3_000);
  assert(evidence.content.length <= 3_000);
  for (const file of files) assert(evidence.content.includes(`+++ b/${file}`));
  assert.deepEqual(evidence.omittedFiles, files);
});

test("逐文件读取不受聚合 diff 总长限制，单文件超限明确保留为待补查", async () => {
  const { collectReviewEvidence } = await import("../src/orchestration/delegation-review.js");
  const files = ["docs/a.json", "docs/b.json", "oversized.json", "src/fix.ts"];
  const loaded: string[] = [];
  const evidence = await collectReviewEvidence(files, 4_000, async file => {
    loaded.push(file);
    return file === "oversized.json" ? undefined : patch(file, file.endsWith("ts") ? "ACTUAL_CODE" : "x".repeat(700_000));
  });
  assert.deepEqual(loaded, files);
  assert(evidence.content.includes("ACTUAL_CODE"));
  assert(evidence.omittedFiles.includes("oversized.json"));
  assert(evidence.content.length <= 4_000);
  let called = false;
  await assert.rejects(collectReviewEvidence(files, 1, async () => { called = true; return ""; }), /文件清单超过/);
  assert.equal(called, false);
});
