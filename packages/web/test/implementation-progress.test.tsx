/**
 * @input  依赖：ImplementationProgress、服务端静态 React 渲染与实施项夹具
 * @output 导出：AI 任务拆分入口、派生完成度、阻塞提示、证据和最后更新 Actor 的 UI 回归测试
 * @pos    决策执行账本不退化为手填百分比的前端验收证据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImplementationProgress } from "../src/components/ImplementationProgress";
import type { ActorSnapshot, Participant, TopicDetail } from "../src/types/council";

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

describe("ImplementationProgress", () => {
  it("从完成项数量派生百分比并显示阻塞与更新证据", () => {
    const human = snapshot("human", "User");
    const codex = snapshot("codex", "Codex");
    const topic: TopicDetail = {
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
      workItems: [
        {
          id: "work_item_done",
          decisionId: "decision_progress",
          title: "完成接口",
          details: "覆盖写入路径",
          status: "completed",
          statusNote: "测试通过",
          version: 2,
          createdBy: "human",
          createdBySnapshot: human,
          updatedBy: "codex",
          updatedBySnapshot: codex,
          createdLabel: "10:00",
          updatedLabel: "10:30",
          completedLabel: "10:30",
        },
        {
          id: "work_item_blocked",
          decisionId: "decision_progress",
          title: "完成发布",
          details: "",
          status: "blocked",
          statusNote: "等待依赖",
          version: 3,
          createdBy: "human",
          createdBySnapshot: human,
          updatedBy: "codex",
          updatedBySnapshot: codex,
          createdLabel: "10:00",
          updatedLabel: "10:40",
        },
      ],
    };
    const participants = new Map<string, Participant>([[
      "codex",
      { id: "codex", slug: "codex", name: "Codex Current", shortName: "CX", role: "实现者" },
    ]]);

    const html = renderToStaticMarkup(
      <ImplementationProgress
        topic={topic}
        participants={participants}
        busyAction={null}
        planningAgentLabel="Codex"
        onGenerate={async () => undefined}
        onAdd={async () => true}
        onUpdate={async () => undefined}
      />,
    );

    expect(html).toContain("50%");
    expect(html).toContain("1 项受阻");
    expect(html).toContain("测试通过");
    expect(html).toContain("Codex");
    expect(html).toContain("aria-valuenow=\"50\"");
    expect(html).toContain("AI 补充遗漏任务");
    expect(html).toContain("实施计划");
  });

  it("Accepted 决策没有任务时优先提供 AI 拆分和手动补充入口", () => {
    const human = snapshot("human", "User");
    const topic: TopicDetail = {
      id: "topic-empty-plan",
      title: "待拆分",
      status: "decided",
      updatedLabel: "现在",
      question: "如何实施？",
      createdLabel: "今天",
      owner: "human",
      ownerSnapshot: human,
      participants: ["human"],
      messages: [],
      constraints: [],
      evidence: [],
      alternatives: [],
      workItems: [],
      decision: {
        title: "采用新方案",
        summary: "按决策实施。",
        rationale: "已经收敛。",
        status: "accepted",
        proposedBy: "human",
        proposedBySnapshot: human,
      },
    };
    const html = renderToStaticMarkup(
      <ImplementationProgress
        topic={topic}
        participants={new Map()}
        busyAction={null}
        planningAgentLabel="Claude"
        onGenerate={async () => undefined}
        onAdd={async () => true}
        onUpdate={async () => undefined}
      />,
    );

    expect(html).toContain("AI 拆分任务");
    expect(html).toContain("手动添加任务");
    expect(html).toContain("尚无任务");
  });
});
