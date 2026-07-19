/**
 * @input  依赖：可信 prompt 预算函数与零历史预算边界
 * @output 导出：slice(-0) 回归和可信前缀超限测试
 * @pos    MCP/编排共用 prompt 裁剪算法的最小安全证明
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildTrustedPrompt } from "../src/prompt-budget.js";

test("历史预算为零时不触发 slice(-0) 全量回填", () => {
  const prompt = buildTrustedPrompt({
    trustedPrefix: "TRUSTED",
    transcriptHeader: "\nH",
    transcript: "UNTRUSTED_HISTORY".repeat(100),
    truncationMarker: "CUT",
    maxChars: 9,
    trustedOverflowError: () => new Error("overflow"),
  });

  assert.equal(prompt, "TRUSTED\nH");
  assert.equal(prompt.length, 9);
  assert.doesNotMatch(prompt, /UNTRUSTED/);
});

test("可信前缀超限时显式失败而不是从尾部裁掉安全头", () => {
  assert.throws(() => buildTrustedPrompt({
    trustedPrefix: "TRUSTED_PREFIX",
    transcriptHeader: "\nH",
    transcript: "history",
    truncationMarker: "CUT",
    maxChars: 5,
    trustedOverflowError: () => new Error("trusted overflow"),
  }), /trusted overflow/);
});
