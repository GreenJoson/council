/**
 * @input  依赖：AgentReplyActivity 活动状态选择器与自动轮次领域类型
 * @output 导出：议题隔离、生命周期过滤、Agent 标签和最新运行选择回归测试
 * @pos    防止讨论时间线显示错误、过期或已结束的 Agent 回复状态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import { selectAgentReplyActivity } from "../src/components/AgentReplyActivity";
import type {
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../src/types/orchestration";

function createRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    id: "run-active",
    topicId: "topic-active",
    status: "waiting_agent",
    plan: [{
      adapterId: "claude",
      publicAuthor: "claude",
      messageKind: "proposal",
      instruction: "审查边界",
    }],
    policy: {
      maxRounds: 2,
      agentTimeoutMs: 1_000,
      maxAttemptsPerRound: 1,
      maxManualRecoveries: 1,
      confirmation: { beforeRounds: [], beforeCompletion: true },
    },
    nextRoundIndex: 0,
    currentAttempt: 1,
    manualRecoveriesUsed: 0,
    confirmedGates: [],
    activeAgentId: "claude",
    version: 2,
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

function createSnapshot(runs: OrchestrationRun[]): OrchestrationSnapshot {
  return {
    activeTopicId: "topic-active",
    capabilities: {
      adapters: [{
        id: "claude",
        publicAuthor: "claude",
        label: "Claude Code",
        available: true,
      }],
      defaultPolicy: createRun().policy,
    },
    runs,
    sync: { status: "connected", label: "本地编排已连接" },
  };
}

describe("讨论时间线 Agent 回复状态", () => {
  it("把 waiting_agent 映射为具体 Agent 的正在回复状态", () => {
    expect(selectAgentReplyActivity(
      createSnapshot([createRun()]),
      "topic-active",
    )).toEqual({
      runId: "run-active",
      adapterId: "claude",
      agent: "claude",
      label: "Claude Code",
      phase: "replying",
      content: "",
    });
  });

  it("把同一运行的临时草稿交给活动卡，其他运行草稿不会串线", () => {
    const snapshot = createSnapshot([createRun()]);
    snapshot.agentOutputs = [
      {
        runId: "run-other",
        topicId: "topic-active",
        adapterId: "claude",
        sequence: 1,
        content: "错误草稿",
      },
      {
        runId: "run-active",
        topicId: "topic-active",
        adapterId: "claude",
        sequence: 2,
        content: "公开增量",
      },
    ];
    expect(selectAgentReplyActivity(snapshot, "topic-active")?.content).toBe("公开增量");
  });

  it("running 使用当前轮次预告正在准备，结束状态和其他议题不显示", () => {
    const running = createRun({
      status: "running",
      activeAgentId: undefined,
    });
    expect(selectAgentReplyActivity(
      createSnapshot([running]),
      "topic-active",
    )?.phase).toBe("preparing");

    expect(selectAgentReplyActivity(
      createSnapshot([createRun({ status: "completed", activeAgentId: undefined })]),
      "topic-active",
    )).toBeNull();
    expect(selectAgentReplyActivity(
      createSnapshot([createRun()]),
      "topic-other",
    )).toBeNull();
  });

  it("异常出现多个活动运行时只展示更新时间最新者", () => {
    const older = createRun({
      id: "run-older",
      updatedAt: "2026-01-01T09:00:00.000Z",
    });
    const newer = createRun({
      id: "run-newer",
      updatedAt: "2026-01-01T10:00:00.000Z",
    });
    expect(selectAgentReplyActivity(
      createSnapshot([older, newer]),
      "topic-active",
    )?.runId).toBe("run-newer");
  });
});
