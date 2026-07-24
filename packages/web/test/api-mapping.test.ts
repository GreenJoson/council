/**
 * @input  依赖：Council API 严格解析器、Workspace 映射器与协议夹具
 * @output 导出：动态 Actor 行快照、重命名保真、身份不一致拒绝和无伪造证据测试
 * @pos    REST 数据进入 Operator Console 前的领域边界验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import { parseApiPaginatedTopics, parseApiTopicDetail } from "../src/data/api-types";
import { mapApiTopicDetail, mapWorkspaceSnapshot } from "../src/data/workspace-mapper";

function createDetailFixture() {
  const human = actorSnapshot("human", "User", "U", "决策者");
  const legacyUnknown = actorSnapshot(
    "legacy-unknown",
    "Legacy unknown",
    "?",
    "待人工识别的历史参与者",
  );
  return {
    topic: {
      id: "topic-one",
      title: "缓存一致性",
      question: "如何验证失效边界？",
      constraints: ["不得返回过期权限数据"],
      projectPath: "/example/project",
      status: "open",
      createdByActorId: "human",
      createdBySnapshot: human,
      createdAt: "2026-01-01T08:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
    },
    messages: [
      {
        id: "message-one",
        topicId: "topic-one",
        actorId: "legacy-unknown",
        actorSnapshot: legacyUnknown,
        kind: "brief",
        content: "先定义一致性窗口。",
        createdAt: "2026-01-01T08:30:00.000Z",
      },
    ],
    decisions: [],
    messageTotal: 1,
    messageLimit: 100,
    messageOffset: 0,
    hasMoreMessages: false,
  };
}

function actorSnapshot(actorId: string, displayName: string, shortName: string, role: string) {
  return {
    schemaVersion: 1,
    actorId,
    slug: actorId,
    displayName,
    shortName,
    role,
  };
}

describe("Council API 解析与映射", () => {
  it("严格解析分页与议题详情", () => {
    const detail = parseApiTopicDetail(createDetailFixture());
    const page = parseApiPaginatedTopics({
      total: 1,
      count: 1,
      offset: 0,
      hasMore: false,
      topics: [detail.topic],
    });

    expect(page.topics[0]?.createdByActorId).toBe("human");
    expect(detail.messages[0]?.actorId).toBe("legacy-unknown");
    expect(() => parseApiTopicDetail({ ...createDetailFixture(), messages: "invalid" })).toThrow(
      "messages 必须是数组",
    );
  });

  it("保留待审计历史 Actor，且不伪造 evidence 或 decision", () => {
    const mapped = mapApiTopicDetail(parseApiTopicDetail(createDetailFixture()));

    expect(mapped.owner).toBe("human");
    expect(mapped.messages[0]).toMatchObject({ author: "legacy-unknown", kind: "note" });
    expect(mapped.evidence).toEqual([]);
    expect(mapped.decision).toBeUndefined();
    expect(mapped.status).toBe("discussing");
  });

  it("同一 Actor 重命名前后的消息保留各自行快照", () => {
    const fixture = createDetailFixture();
    fixture.messages = [
      {
        ...fixture.messages[0],
        id: "message-old-name",
        actorId: "claude",
        actorSnapshot: actorSnapshot("claude", "Claude Legacy", "CL", "旧角色"),
      },
      {
        ...fixture.messages[0],
        id: "message-new-name",
        actorId: "claude",
        actorSnapshot: actorSnapshot("claude", "Claude", "CL", "方案顾问"),
      },
    ];
    fixture.messageTotal = 2;

    const mapped = mapApiTopicDetail(parseApiTopicDetail(fixture));
    expect(mapped.messages.map((message) => message.actorSnapshot.displayName)).toEqual([
      "Claude Legacy",
      "Claude",
    ]);
  });

  it("拒绝索引 Actor 与冻结快照不一致的 topic/message/decision", () => {
    const topicMismatch = createDetailFixture();
    topicMismatch.topic.createdBySnapshot = actorSnapshot("claude", "Claude", "CL", "方案顾问");
    expect(() => parseApiTopicDetail(topicMismatch)).toThrow("topic Actor snapshot");

    const messageMismatch = createDetailFixture();
    messageMismatch.messages[0].actorSnapshot =
      actorSnapshot("codex", "Codex", "CX", "代码审查");
    expect(() => parseApiTopicDetail(messageMismatch)).toThrow("message Actor snapshot");

    const decisionMismatch = createDetailFixture();
    decisionMismatch.decisions.push({
      id: "decision-mismatch",
      topicId: "topic-one",
      title: "不一致",
      decision: "拒绝。",
      rationale: "身份不一致。",
      alternatives: [],
      status: "proposed",
      createdByActorId: "claude",
      createdBySnapshot: actorSnapshot("codex", "Codex", "CX", "代码审查"),
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
    });
    expect(() => parseApiTopicDetail(decisionMismatch)).toThrow("decision Actor snapshot");
  });

  it("把结构化决策和备选方案映射到工作区", () => {
    const fixture = createDetailFixture();
    fixture.decisions.push({
      id: "decision-one",
      topicId: "topic-one",
      title: "缩短一致性窗口",
      decision: "采用版本号校验。",
      rationale: "失败边界更清晰。",
      alternatives: ["只依赖固定 TTL"],
      status: "proposed",
      createdByActorId: "claude",
      createdBySnapshot: actorSnapshot("claude", "Claude", "CL", "方案顾问"),
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
    });
    const detail = parseApiTopicDetail(fixture);
    const workspace = mapWorkspaceSnapshot([detail], {
      status: "connected",
      label: "API 已连接",
    });

    expect(workspace.project.name).toBe("project");
    expect(workspace.topics[0]?.decision?.summary).toBe("采用版本号校验。");
    expect(workspace.topics[0]?.alternatives[0]?.title).toBe("只依赖固定 TTL");
  });

  it("最新决策被拒绝后不复活更早的 proposed decision", () => {
    const fixture = createDetailFixture();
    fixture.decisions.push(
      {
        id: "decision-proposed",
        topicId: "topic-one",
        title: "旧提议",
        decision: "曾经的提议。",
        rationale: "旧理由。",
        alternatives: [],
        status: "proposed",
        createdByActorId: "claude",
        createdBySnapshot: actorSnapshot("claude", "Claude", "CL", "方案顾问"),
        createdAt: "2026-01-01T09:00:00.000Z",
        updatedAt: "2026-01-01T09:00:00.000Z",
      },
      {
        id: "decision-rejected",
        topicId: "topic-one",
        title: "拒绝旧提议",
        decision: "不采用。",
        rationale: "证据不足。",
        alternatives: [],
        status: "rejected",
        createdByActorId: "human",
        createdBySnapshot: actorSnapshot("human", "User", "U", "决策者"),
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    );

    const mapped = mapApiTopicDetail(parseApiTopicDetail(fixture));
    expect(mapped.decision).toBeUndefined();
    expect(mapped.alternatives).toEqual([]);
  });
});
