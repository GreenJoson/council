/**
 * @input  依赖：AutoRoundsPanel 的纯控制状态函数与 Run 领域类型
 * @output 导出：创建互斥、已决统一阻断、人工恢复预算、当前/历史调用及最新持久会话分区测试
 * @pos    Agent 调用控制卡不暴露无效动作或堆叠完整历史卡的回归验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import {
  getCreateRunBlockedReason,
  getTopicAgentCallBlockedReason,
  isRecoveryBudgetExhausted,
  latestRuntimeBindings,
  partitionRunsForDisplay,
} from "../src/components/AutoRoundsPanel";
import type {
  OrchestrationRun,
  RuntimeBinding,
} from "../src/types/orchestration";

function createRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    id: "run-test",
    topicId: "topic-test",
    status: "completed",
    plan: [],
    policy: {
      maxRounds: 2,
      agentIdleTimeoutMs: 500,
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

function createBinding(overrides: Partial<RuntimeBinding> = {}): RuntimeBinding {
  return {
    id: "binding-test",
    topicId: "topic-test",
    agentId: "claude",
    actorId: "claude",
    providerId: "provider-claude",
    transportKind: "claude-resume",
    status: "idle",
    hasSession: true,
    stateVersion: 2,
    lastActivityAt: "2026-01-01T09:00:00.000Z",
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("自动轮次 UI 控制状态", () => {
  it("任一 busy action 或 idle/active Run 都阻止新建", () => {
    expect(getCreateRunBlockedReason([], "approve:run-test")).toContain("正在处理");
    expect(getCreateRunBlockedReason([createRun({ status: "idle" })], null)).toContain(
      "Agent 调用正在处理",
    );
    expect(getCreateRunBlockedReason([createRun()], null)).toBeUndefined();
  });

  it("已决议题统一禁止启动、重开和 @Agent", () => {
    expect(getTopicAgentCallBlockedReason(true)).toBeUndefined();
    expect(getTopicAgentCallBlockedReason(false)).toContain(
      "不能再启动、重开或通过 @ 召唤 Agent",
    );
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

  it("只展示一张当前调用卡，其余调用归入历史", () => {
    const newestCompleted = createRun({ id: "run-newest", status: "completed" });
    const active = createRun({ id: "run-active", status: "waiting_agent" });
    const olderFailed = createRun({ id: "run-older", status: "failed" });

    const partition = partitionRunsForDisplay([newestCompleted, active, olderFailed]);

    expect(partition.primaryRun?.id).toBe("run-active");
    expect(partition.historyRuns.map((run) => run.id)).toEqual([
      "run-newest",
      "run-older",
    ]);
  });

  it("没有进行中调用时仅把最新调用作为主卡", () => {
    const newest = createRun({ id: "run-newest" });
    const older = createRun({ id: "run-older", status: "cancelled" });

    expect(partitionRunsForDisplay([newest, older])).toEqual({
      primaryRun: newest,
      historyRuns: [older],
    });
    expect(partitionRunsForDisplay([])).toEqual({
      primaryRun: undefined,
      historyRuns: [],
    });
  });

  it("每个 Agent 只展示最新创建的持久会话", () => {
    const olderClaude = createBinding({ id: "binding-claude-old" });
    const codex = createBinding({
      id: "binding-codex",
      agentId: "codex",
      actorId: "codex",
      providerId: "provider-codex",
      transportKind: "codex-resume",
      createdAt: "2026-01-01T08:30:00.000Z",
    });
    const latestClaude = createBinding({
      id: "binding-claude-new",
      status: "starting",
      hasSession: false,
      createdAt: "2026-01-01T10:00:00.000Z",
    });

    expect(latestRuntimeBindings([latestClaude, olderClaude, codex]).map(
      (binding) => binding.id,
    )).toEqual(["binding-codex", "binding-claude-new"]);
  });
});
