/**
 * @input  依赖：InspectorPanel、DecisionRecordArticle、同一 Actor 的旧冻结快照与新全局资料
 * @output 导出：议题、决策和备选方案始终优先渲染写入时 Actor 快照的回归测试
 * @pos    防止 Actor 改名后历史记录被全局最新地址簿静默改写
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionRecordArticle } from "../src/components/DecisionRecordsView";
import { InspectorPanel } from "../src/components/InspectorPanel";
import type {
  ActorSnapshot,
  Participant,
  TopicDetail,
} from "../src/types/council";

const ACTOR_ID = "actor-shared";

function actorSnapshot(displayName: string, shortName: string): ActorSnapshot {
  return {
    schemaVersion: 1,
    actorId: ACTOR_ID,
    slug: "shared-actor",
    displayName,
    shortName,
    role: "架构顾问",
  };
}

function createDetail(): TopicDetail {
  return {
    id: "topic-frozen-actor",
    title: "冻结身份回归",
    question: "历史记录是否保留当时身份？",
    status: "decided",
    createdLabel: "更名前",
    updatedLabel: "更名后",
    owner: ACTOR_ID,
    ownerSnapshot: actorSnapshot("Owner Old", "OO"),
    participants: [ACTOR_ID],
    messages: [],
    constraints: [],
    evidence: [],
    alternatives: [{
      id: "alternative-old",
      title: "保留旧身份快照",
      author: ACTOR_ID,
      authorSnapshot: actorSnapshot("Alternative Old", "AO"),
      createdLabel: "更名前",
    }],
    decision: {
      title: "采用冻结身份",
      summary: "历史内容不随 Actor 改名漂移。",
      rationale: "地址簿描述当前身份，行快照描述历史事实。",
      status: "accepted",
      proposedBy: ACTOR_ID,
      proposedBySnapshot: actorSnapshot("Decision Old", "DO"),
      decidedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function currentParticipants(): Map<string, Participant> {
  return new Map([[
    ACTOR_ID,
    {
      id: ACTOR_ID,
      slug: "shared-actor",
      name: "Actor New",
      shortName: "AN",
      role: "新角色",
    },
  ]]);
}

describe("冻结 Actor 快照渲染", () => {
  it("Inspector 的所有者与备选作者优先使用历史快照", () => {
    const html = renderToStaticMarkup(
      <InspectorPanel
        topic={createDetail()}
        participants={currentParticipants()}
        isAccepting={false}
        isOpen
        onAccept={async () => undefined}
        onClose={() => undefined}
        orchestration={null}
        orchestrationBusyAction={null}
        onCreateAndStartRun={async () => false}
        onStartRun={async () => undefined}
        onApproveRun={async () => undefined}
        onCancelRun={async () => undefined}
        onRecoverRun={async () => undefined}
      />,
    );

    expect(html).toContain("Owner Old");
    expect(html).toContain("Alternative Old");
  });

  it("决策档案不会被同一 Actor 的最新地址簿名称改写", () => {
    const html = renderToStaticMarkup(
      <DecisionRecordArticle
        detail={createDetail()}
        participants={currentParticipants()}
        onOpenTopic={() => undefined}
      />,
    );

    expect(html).toContain("Owner Old");
    expect(html).toContain("Decision Old");
    expect(html).toContain("Alternative Old");
    expect(html).not.toContain("Actor New");
  });
});
