/**
 * @input  依赖：Council API 严格解析器、Workspace 映射器与协议夹具
 * @output 导出：解析、Author 映射和无伪造证据测试
 * @pos    REST 数据进入 Operator Console 前的领域边界验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import { parseApiPaginatedTopics, parseApiTopicDetail } from "../src/data/api-types";
import { mapApiTopicDetail, mapWorkspaceSnapshot } from "../src/data/workspace-mapper";

function createDetailFixture() {
  return {
    topic: {
      id: "topic-one",
      title: "缓存一致性",
      question: "如何验证失效边界？",
      constraints: ["不得返回过期权限数据"],
      projectPath: "/example/project",
      status: "open",
      createdBy: "human",
      createdAt: "2026-01-01T08:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
    },
    messages: [
      {
        id: "message-one",
        topicId: "topic-one",
        author: "other",
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

    expect(page.topics[0]?.createdBy).toBe("human");
    expect(detail.messages[0]?.author).toBe("other");
    expect(() => parseApiTopicDetail({ ...createDetailFixture(), messages: "invalid" })).toThrow(
      "messages 必须是数组",
    );
  });

  it("保留 other 作者，且不伪造 evidence 或 decision", () => {
    const mapped = mapApiTopicDetail(parseApiTopicDetail(createDetailFixture()));

    expect(mapped.owner).toBe("user");
    expect(mapped.messages[0]).toMatchObject({ author: "other", kind: "note" });
    expect(mapped.evidence).toEqual([]);
    expect(mapped.decision).toBeUndefined();
    expect(mapped.status).toBe("discussing");
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
      createdBy: "claude",
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
        createdBy: "claude",
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
        createdBy: "human",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    );

    const mapped = mapApiTopicDetail(parseApiTopicDetail(fixture));
    expect(mapped.decision).toBeUndefined();
    expect(mapped.alternatives).toEqual([]);
  });
});
