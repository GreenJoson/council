/**
 * @input  依赖：ImplementationProgress/ImplementationSummary、服务端静态 React 渲染与实施项夹具
 * @output 导出：中英界面下的派生完成度、只数叶子的分母、父任务只读状态、审核发现徽标、
 *         认领态与 AI 拆分入口的 UI 回归测试
 * @pos    决策执行账本不退化为手填百分比的前端验收证据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ImplementationProgress,
  ImplementationSummary,
} from "../src/components/ImplementationProgress";
import { I18nProvider } from "../src/i18n/I18nProvider";
import type {
  ActorSnapshot,
  CouncilWorkItem,
  Participant,
  TopicDetail,
} from "../src/types/council";
import type { OrchestrationAdapter, WorkItemDelegation } from "../src/types/orchestration";

function snapshot(actorId: string, displayName: string): ActorSnapshot {
  return {
    schemaVersion: 1,
    actorId,
    slug: actorId,
    displayName,
    shortName: displayName.slice(0, 2),
    role: "实现者",
  };
}

const human = snapshot("human", "User");
const codex = snapshot("codex", "Codex");

function workItem(overrides: Partial<CouncilWorkItem> & { id: string; title: string }): CouncilWorkItem {
  return {
    decisionId: "decision_progress",
    details: "",
    status: "pending",
    version: 1,
    sortOrder: 0,
    origin: "manual",
    createdBy: "human",
    createdBySnapshot: human,
    updatedBy: "codex",
    updatedBySnapshot: codex,
    createdLabel: "10:00",
    updatedLabel: "10:30",
    ...overrides,
  };
}

function topicWith(workItems: CouncilWorkItem[]): TopicDetail {
  return {
    id: "topic-progress",
    title: "实施进度",
    status: "decided",
    updatedLabel: "现在",
    question: "是否真实完成？",
    createdLabel: "今天",
    owner: "human",
    ownerSnapshot: human,
    participants: ["human", "codex"],
    messages: [],
    constraints: [],
    evidence: [],
    alternatives: [],
    decisions: [{
      id: "decision_progress",
      title: "进入实施",
      summary: "按清单交付。",
      rationale: "可审计。",
      status: "accepted",
      proposedBy: "human",
      proposedBySnapshot: human,
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    workItems,
  };
}

const participants = new Map<string, Participant>([[
  "codex",
  { id: "codex", slug: "codex", name: "Codex Current", shortName: "CX", role: "实现者" },
]]);

const planningAgent: OrchestrationAdapter = {
  id: "codex-agent",
  actorId: "codex",
  label: "Codex",
  available: true,
  runtimeCapabilities: ["text", "repository_read"],
  permissionProfile: "read_only",
  executionRole: "advisor",
};

function tasks(topic: TopicDetail): JSX.Element {
  return (
    <ImplementationProgress
      topic={topic}
      participants={participants}
      busyAction={null}
      onGenerate={async () => undefined}
      onAdd={async () => true}
      onUpdate={async () => undefined}
      onClaim={async () => undefined}
      delegationAgents={[planningAgent]}
    />
  );
}

function render(topic: TopicDetail): string {
  return renderToStaticMarkup(tasks(topic));
}

function renderEnglish(topic: TopicDetail): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{tasks(topic)}</I18nProvider>,
  );
}

describe("ImplementationProgress", () => {
  it("从完成项数量派生百分比并显示阻塞与更新证据", () => {
    const topic = topicWith([
      workItem({
        id: "work_item_done",
        title: "完成接口",
        details: "覆盖写入路径",
        status: "completed",
        statusNote: "测试通过",
        version: 2,
        completedLabel: "10:30",
      }),
      workItem({
        id: "work_item_blocked",
        title: "完成发布",
        status: "blocked",
        statusNote: "等待依赖",
        version: 3,
        sortOrder: 1,
        updatedLabel: "10:40",
      }),
    ]);
    const html = render(topic);
    const summaryHtml = renderToStaticMarkup(<ImplementationSummary topic={topic} />);
    const englishHtml = renderEnglish(topic);

    expect(summaryHtml).toContain("50%");
    expect(summaryHtml).toContain("aria-valuenow=\"50\"");
    expect(summaryHtml).toContain("实施进度");
    expect(html).toContain("1 项受阻");
    expect(html).toContain("测试通过");
    expect(html).toContain("Codex");
    // 进度条只属于右栏摘要；主区任务卡再画一条等于同一个数字维护两处。
    expect(html).not.toContain("role=\"progressbar\"");
    expect(html).toContain("让 Codex 补充遗漏任务");
    expect(html).toContain("任务拆分");
    expect(englishHtml).toContain("Task breakdown");
    expect(englishHtml).toContain("1 blocked; resolve dependencies first");
    expect(englishHtml).toContain("Ask Codex to find missing tasks");
  });

  it("分母只数叶子任务，父任务缩进渲染且状态按钮被禁用", () => {
    const topic = topicWith([
      workItem({ id: "work_item_parent", title: "打通登录链路" }),
      workItem({
        id: "work_item_child_a",
        parentId: "work_item_parent",
        title: "后端签发令牌",
        status: "completed",
        completedLabel: "11:00",
      }),
      workItem({
        id: "work_item_child_b",
        parentId: "work_item_parent",
        title: "前端存储令牌",
        sortOrder: 1,
      }),
    ]);
    const html = render(topic);

    // 三条记录只有两个叶子：父任务再被计一次，进度会凭空变成 1/3。
    expect(html).toContain("2 项可执行任务");
    expect(renderToStaticMarkup(<ImplementationSummary topic={topic} />)).toContain("1 / 2");
    expect(html).toContain("--work-item-depth:1");
    expect(html).toContain("work-item-child");
    expect(html).toContain("父任务状态由子任务派生");
    expect(html).toContain("work-item-tag-derived");
    // 父任务的状态按钮是只读回显；子任务的仍然可点。
    expect(html.match(/work-item-update-toggle" disabled=""/g)).toHaveLength(1);
    expect(renderEnglish(topic)).toContain("Derived");
  });

  it("阻断级审核发现会挡住收敛并标出轮次", () => {
    const topic = topicWith([
      workItem({
        id: "work_item_finding",
        decisionId: undefined,
        title: "认领接口缺少乐观锁",
        origin: "review_finding",
        severity: "blocking",
        reviewRound: 2,
        sourceMessageId: "message_review",
      }),
      workItem({
        id: "work_item_nit",
        title: "补一条注释",
        origin: "review_finding",
        severity: "non_blocking",
        reviewRound: 2,
        sortOrder: 1,
        status: "completed",
        completedLabel: "12:00",
      }),
    ]);
    const html = render(topic);

    expect(html).toContain("1 条阻断级审核发现未关闭");
    expect(html).toContain("阻断 · R2");
    expect(html).toContain("非阻断");
    expect(renderEnglish(topic))
      .toContain("1 blocking review findings are still open");
  });

  it("已认领的叶子显示执行者与修复提交，未认领的才给认领按钮", () => {
    const topic = topicWith([
      workItem({
        id: "work_item_claimed",
        title: "重放迁移脚本",
        status: "in_progress",
        assignee: "codex",
        claimedLabel: "12:05",
        fixCommit: "a1b2c3d",
      }),
      workItem({ id: "work_item_open", title: "补迁移测试", sortOrder: 1 }),
    ]);
    const html = render(topic);

    expect(html).toContain("认领：Codex Current");
    expect(html).toContain("a1b2c3d");
    expect(html.match(/认领<\/button>/g)).toHaveLength(1);
    expect(renderEnglish(topic)).toContain("Claimed by Codex Current");
  });

  it("Accepted 决策没有任务时不自动分拆，并要求显式选择 Agent", () => {
    const html = render(topicWith([]));

    expect(html).toContain("任务不会自动生成");
    expect(html).toContain("选择任务拆分 Agent");
    expect(html).toContain("让 Codex 拆分任务");
    expect(html).toContain("手动添加任务");
    expect(html).toContain("尚无任务");
  });

  it("只有两个不同 Agent 分别具备执行与审核能力时才开放委派", () => {
    const item = workItem({ id: "work_item_delegate", title: "执行委派任务" });
    const executor: OrchestrationAdapter = {
      id: "codex-agent",
      actorId: "codex",
      label: "Codex",
      available: true,
      runtimeCapabilities: ["text", "repository_write", "tests"],
      permissionProfile: "workspace_write",
      executionRole: "hybrid",
    };
    const reviewer: OrchestrationAdapter = {
      id: "claude-agent",
      actorId: "claude",
      label: "Claude",
      available: true,
      runtimeCapabilities: ["text", "repository_read", "git_diff"],
      permissionProfile: "read_only",
      executionRole: "reviewer",
    };
    const renderWithAgents = (delegationAgents: OrchestrationAdapter[]) => renderToStaticMarkup(
      <ImplementationProgress
        topic={topicWith([item])}
        participants={participants}
        busyAction={null}
        onGenerate={async () => undefined}
        onAdd={async () => true}
        onUpdate={async () => undefined}
        onClaim={async () => undefined}
        delegationAgents={delegationAgents}
      />,
    );

    expect(renderWithAgents([executor]))
      .toMatch(/work-item-delegate-button" type="button" disabled=""/u);
    expect(renderWithAgents([executor, reviewer]))
      .toMatch(/work-item-delegate-button" type="button"><svg/u);
  });

  it("顶部一键委派只统计剩余叶子，并回显同一批次的逐项审核进度", () => {
    const parent = workItem({ id: "work_item_batch_parent", title: "批量父任务" });
    const first = workItem({
      id: "work_item_batch_first",
      parentId: parent.id,
      title: "第一项",
    });
    const second = workItem({
      id: "work_item_batch_second",
      parentId: parent.id,
      title: "第二项",
      sortOrder: 1,
    });
    const done = workItem({
      id: "work_item_batch_done",
      title: "已完成项",
      status: "completed",
      completedLabel: "13:00",
      sortOrder: 2,
    });
    const executor: OrchestrationAdapter = {
      id: "codex-agent",
      actorId: "codex",
      label: "Codex",
      available: true,
      runtimeCapabilities: ["text", "repository_write", "tests"],
      permissionProfile: "workspace_write",
      executionRole: "hybrid",
    };
    const reviewer: OrchestrationAdapter = {
      id: "claude-agent",
      actorId: "claude",
      label: "Claude",
      available: true,
      runtimeCapabilities: ["text", "repository_read", "git_diff"],
      permissionProfile: "read_only",
      executionRole: "reviewer",
    };
    const now = "2026-01-01T00:00:00.000Z";
    const delegation = (
      item: CouncilWorkItem,
      status: WorkItemDelegation["status"],
    ): WorkItemDelegation => ({
      id: `delegation-${item.id}`,
      topicId: "topic-progress",
      workItemId: item.id,
      supervisorAgentId: reviewer.id,
      executorAgentId: executor.id,
      permissionProfile: "workspace_write",
      status,
      attempt: status === "approved" ? 1 : 0,
      maxAttempts: 2,
      branchName: "codex/council-batch-fixture",
      createdAt: now,
      updatedAt: now,
    });
    const html = renderToStaticMarkup(
      <ImplementationProgress
        topic={topicWith([parent, first, second, done])}
        participants={participants}
        busyAction={null}
        onGenerate={async () => undefined}
        onAdd={async () => true}
        onUpdate={async () => undefined}
        onClaim={async () => undefined}
        delegationAgents={[executor, reviewer]}
        delegations={[delegation(first, "approved"), delegation(second, "queued")]}
      />,
    );

    expect(html).toContain("一键委派全部剩余任务");
    expect(html).toContain("2 项叶子任务");
    expect(html).toContain("最近队列：1/2 项审核通过");
    expect(html).toMatch(/<button type="button" disabled=""[^>]*><svg[^>]*>.*一键委派/u);
  });
});
