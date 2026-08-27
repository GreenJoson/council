/**
 * @input  依赖：ImplementationProgress、服务端静态 React 渲染与实施项夹具
 * @output 导出：派生完成度、只数叶子的分母、父任务只读状态、审核发现徽标与认领态的 UI 回归测试
 * @pos    决策执行账本不退化为手填百分比的前端验收证据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImplementationProgress } from "../src/components/ImplementationProgress";
import type {
  ActorSnapshot,
  CouncilWorkItem,
  Participant,
  TopicDetail,
} from "../src/types/council";

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
    decision: {
      title: "进入实施",
      summary: "按清单交付。",
      rationale: "可审计。",
      status: "accepted",
      proposedBy: "human",
      proposedBySnapshot: human,
    },
    workItems,
  };
}

const participants = new Map<string, Participant>([[
  "codex",
  { id: "codex", slug: "codex", name: "Codex Current", shortName: "CX", role: "实现者" },
]]);

function render(topic: TopicDetail): string {
  return renderToStaticMarkup(
    <ImplementationProgress
      topic={topic}
      participants={participants}
      busyAction={null}
      onAdd={async () => true}
      onUpdate={async () => undefined}
      onClaim={async () => undefined}
    />,
  );
}

describe("ImplementationProgress", () => {
  it("从完成项数量派生百分比并显示阻塞与更新证据", () => {
    const html = render(topicWith([
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
    ]));

    expect(html).toContain("50%");
    expect(html).toContain("1 项受阻");
    expect(html).toContain("测试通过");
    expect(html).toContain("Codex");
    expect(html).toContain("aria-valuenow=\"50\"");
  });

  it("分母只数叶子任务，父任务缩进渲染且状态下拉被禁用", () => {
    const html = render(topicWith([
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
    ]));

    // 三条记录只有两个叶子：父任务再被计一次，进度会凭空变成 1/3。
    expect(html).toContain("1 / 2");
    expect(html).toContain("50%");
    expect(html).toContain("--work-item-depth:1");
    expect(html).toContain("work-item-child");
    expect(html).toContain("父任务状态由子任务派生");
    expect(html).toContain("work-item-tag-derived");
    // 父任务的下拉是只读回显；子任务的仍然可改。
    expect(html.match(/work-item-status-select" disabled=""/g)).toHaveLength(1);
  });

  it("阻断级审核发现会挡住收敛并标出轮次", () => {
    const html = render(topicWith([
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
    ]));

    expect(html).toContain("1 条阻断级审核发现未关闭");
    expect(html).toContain("阻断 · R2");
    expect(html).toContain("非阻断");
  });

  it("已认领的叶子显示执行者与修复提交，未认领的才给认领按钮", () => {
    const html = render(topicWith([
      workItem({
        id: "work_item_claimed",
        title: "重放迁移脚本",
        status: "in_progress",
        assignee: "codex",
        claimedLabel: "12:05",
        fixCommit: "a1b2c3d",
      }),
      workItem({ id: "work_item_open", title: "补迁移测试", sortOrder: 1 }),
    ]));

    expect(html).toContain("认领：Codex Current");
    expect(html).toContain("a1b2c3d");
    expect(html.match(/认领<\/button>/g)).toHaveLength(1);
  });
});
