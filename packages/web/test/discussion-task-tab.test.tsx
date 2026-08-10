/**
 * @input  依赖：DiscussionPanel、含完成/待处理实施项的议题夹具
 * @output 验证：主导航存在任务 tab，并以完成数/总数而非百分比展示紧凑进度
 * @pos    防止长任务清单退回右栏，或任务进度再次拉宽主导航
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiscussionPanel } from "../src/components/DiscussionPanel";
import type { ActorSnapshot, CouncilWorkItem, TopicDetail } from "../src/types/council";

const ACTOR: ActorSnapshot = {
  schemaVersion: 1,
  actorId: "human",
  slug: "human",
  displayName: "User",
  shortName: "U",
  role: "决策者",
};

function workItem(id: string, status: CouncilWorkItem["status"]): CouncilWorkItem {
  return {
    id,
    decisionId: "decision_tasks",
    title: id,
    details: "",
    status,
    version: 1,
    createdBy: "human",
    createdBySnapshot: ACTOR,
    updatedBy: "human",
    updatedBySnapshot: ACTOR,
    createdLabel: "刚刚",
    updatedLabel: "刚刚",
  };
}

describe("议题任务 tab", () => {
  it("显示完成数/总数徽标，右栏之外承接任务清单", () => {
    const topic: TopicDetail = {
      id: "topic_tasks",
      title: "任务拆分",
      question: "如何实施？",
      status: "decided",
      createdLabel: "今天",
      updatedLabel: "刚刚",
      owner: "human",
      ownerSnapshot: ACTOR,
      participants: ["human"],
      messages: [],
      constraints: [],
      evidence: [],
      alternatives: [],
      decision: {
        title: "开始实施",
        summary: "按任务执行。",
        rationale: "已经收敛。",
        status: "accepted",
        proposedBy: "human",
        proposedBySnapshot: ACTOR,
      },
      workItems: [workItem("已完成任务", "completed"), workItem("待处理任务", "pending")],
    };

    const html = renderToStaticMarkup(
      <DiscussionPanel
        projectName="Example"
        topic={topic}
        participants={new Map()}
        sync={{ status: "connected", label: "已连接" }}
        isPublishing={false}
        onPublish={async () => false}
        orchestration={null}
        orchestrationBusyAction={null}
        workItemBusyAction={null}
        planningAgentLabel="Codex"
        onGenerateWorkItems={async () => undefined}
        onAddWorkItem={async () => true}
        onUpdateWorkItem={async () => undefined}
        isAccepting={false}
        onAccept={() => undefined}
        isRecordingManualDecision={false}
        onRecordManualDecision={() => undefined}
      />,
    );

    expect(html).toContain("id=\"tasks-tab\"");
    expect(html).toContain("aria-controls=\"tasks-tabpanel\"");
    expect(html).toContain("已完成 1，共 2 项任务");
    expect(html).toContain(">1/2<");
  });
});
