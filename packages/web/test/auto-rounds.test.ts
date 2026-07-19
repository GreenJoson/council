/**
 * @input  依赖：AutoRoundsPanel 的纯控制状态函数与 Run 领域类型
 * @output 导出：创建互斥和人工恢复预算 UI 逻辑测试
 * @pos    自动轮次控制卡不暴露无效或冲突动作的回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import {
  getCreateRunBlockedReason,
  isRecoveryBudgetExhausted,
} from "../src/components/AutoRoundsPanel";
import type { OrchestrationRun } from "../src/types/orchestration";

function createRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    id: "run-test",
    topicId: "topic-test",
    status: "completed",
    plan: [],
    policy: {
      maxRounds: 2,
      agentTimeoutMs: 1_000,
      maxAttemptsPerRound: 1,
      maxManualRecoveries: 1,
      confirmation: { beforeRounds: [], beforeCompletion: true },
    },
    nextRoundIndex: 2,
    currentAttempt: 1,
    manualRecoveriesUsed: 0,
    confirmedGates: [],
    version: 2,
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("自动轮次 UI 控制状态", () => {
  it("任一 busy action 或 idle/active Run 都阻止新建", () => {
    expect(getCreateRunBlockedReason([], "approve:run-test")).toContain("正在处理");
    expect(getCreateRunBlockedReason([createRun({ status: "idle" })], null)).toContain(
      "已有待启动或进行中",
    );
    expect(getCreateRunBlockedReason([createRun()], null)).toBeUndefined();
  });

  it("仅在 failed Run 用尽 policy 人工恢复预算时隐藏恢复入口", () => {
    expect(isRecoveryBudgetExhausted(createRun({
      status: "failed",
      manualRecoveriesUsed: 1,
    }))).toBe(true);
    expect(isRecoveryBudgetExhausted(createRun({
      status: "failed",
      manualRecoveriesUsed: 0,
    }))).toBe(false);
    expect(isRecoveryBudgetExhausted(createRun({
      status: "completed",
      manualRecoveriesUsed: 1,
    }))).toBe(false);
  });
});
