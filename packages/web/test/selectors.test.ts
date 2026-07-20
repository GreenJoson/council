/**
 * @input  依赖：filterTopics、extractMermaidBlocks、computeAdrNumberAssignments、
 *         buildArchitectureTimeline、aggregateConstraints、collectArchitectureDiagrams
 *         与脱敏议题摘要/详情夹具
 * @output 导出：议题导航搜索与架构档案聚合纯函数的行为验证，覆盖空输入、多围栏、
 *         嵌套围栏、ADR 编号稳定性与被取代关系等边界
 * @pos    议题导航搜索与架构档案视图共用查询/聚合逻辑的纯函数验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import {
  aggregateConstraints,
  buildArchitectureTimeline,
  collectArchitectureDiagrams,
  computeAdrNumberAssignments,
  extractMermaidBlocks,
  filterTopics,
} from "../src/data/selectors";
import type { TopicDetail, TopicSummary } from "../src/types/council";

const topics: (TopicSummary & { question?: string })[] = [
  { id: "one", title: "支付回调幂等方案", status: "proposed", updatedLabel: "刚刚" },
  {
    id: "two",
    title: "Cache Invalidation",
    status: "discussing",
    updatedLabel: "昨天",
    question: "如何设计跨区域缓存失效策略？",
  },
  { id: "three", title: "订单状态机迁移", status: "decided", updatedLabel: "上周" },
];

describe("filterTopics", () => {
  it("空查询保留原顺序", () => {
    expect(filterTopics(topics, "  ")).toEqual(topics);
  });

  it("支持中文标题和大小写无关查询", () => {
    expect(filterTopics(topics, "幂等").map((topic) => topic.id)).toEqual(["one"]);
    expect(filterTopics(topics, "cache").map((topic) => topic.id)).toEqual(["two"]);
  });

  it("按状态筛选：进行中排除已决策，已决策只保留 decided", () => {
    expect(filterTopics(topics, "", "active").map((topic) => topic.id)).toEqual(["one", "two"]);
    expect(filterTopics(topics, "", "decided").map((topic) => topic.id)).toEqual(["three"]);
    expect(filterTopics(topics, "", "all")).toEqual(topics);
  });

  it("状态筛选与文本查询同时生效", () => {
    expect(filterTopics(topics, "订单", "active")).toEqual([]);
    expect(filterTopics(topics, "订单", "decided").map((topic) => topic.id)).toEqual(["three"]);
  });

  it("标题未命中时按问题描述匹配", () => {
    expect(filterTopics(topics, "跨区域缓存").map((topic) => topic.id)).toEqual(["two"]);
  });

  it("问题描述匹配也遵守状态筛选，缺少 question 的轻量议题不会误命中", () => {
    expect(filterTopics(topics, "跨区域缓存", "decided")).toEqual([]);
  });
});

describe("extractMermaidBlocks", () => {
  it("无围栏时返回空数组", () => {
    expect(extractMermaidBlocks("普通文本，没有任何代码块。")).toEqual([]);
  });

  it("提取单个 mermaid 围栏的源码，不含围栏本身", () => {
    const markdown = "说明文字\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n结尾";
    expect(extractMermaidBlocks(markdown)).toEqual(["graph TD\n  A --> B"]);
  });

  it("提取多个 mermaid 围栏，且忽略其它语言的围栏", () => {
    const markdown = [
      "```ts",
      "const a = 1;",
      "```",
      "",
      "```mermaid",
      "graph LR",
      "  A --> B",
      "```",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hi",
      "```",
    ].join("\n");
    expect(extractMermaidBlocks(markdown)).toEqual([
      "graph LR\n  A --> B",
      "sequenceDiagram\n  A->>B: hi",
    ]);
  });

  it("大小写不敏感的 mermaid 信息字符串也能识别", () => {
    expect(extractMermaidBlocks("```Mermaid\ngraph TD\n  A --> B\n```")).toEqual(["graph TD\n  A --> B"]);
  });

  it("嵌套在更长的非 mermaid 围栏内的 ```mermaid 文本不会被误提取", () => {
    const markdown = [
      "````text",
      "示例：写一段 mermaid 代码块",
      "```mermaid",
      "graph TD",
      "  A --> B",
      "```",
      "以上是围栏写法示例",
      "````",
    ].join("\n");
    expect(extractMermaidBlocks(markdown)).toEqual([]);
  });

  it("未闭合的尾部 mermaid 围栏仍视为有效代码块（容忍漏打收尾围栏）", () => {
    const markdown = "```mermaid\ngraph TD\n  A --> B";
    expect(extractMermaidBlocks(markdown)).toEqual(["graph TD\n  A --> B"]);
  });

  it("空 mermaid 围栏返回空字符串源码，不抛出异常", () => {
    expect(extractMermaidBlocks("```mermaid\n```")).toEqual([""]);
  });
});

/** 架构档案聚合函数的最小夹具：只填充测试用到的字段，其余字段用合理默认值补全 */
function buildTopicFixture(overrides: Partial<TopicDetail> & Pick<TopicDetail, "id" | "title">): TopicDetail {
  return {
    status: "decided",
    updatedLabel: "刚刚",
    question: "",
    createdLabel: "刚刚",
    owner: "user",
    participants: ["user"],
    messages: [],
    constraints: [],
    evidence: [],
    alternatives: [],
    ...overrides,
  };
}

describe("computeAdrNumberAssignments / buildArchitectureTimeline", () => {
  it("按 decidedAt 升序分配稳定编号，被取代不影响已分配的编号", () => {
    const legacy = buildTopicFixture({
      id: "legacy",
      title: "旧传输协议",
      decision: {
        title: "REST 回调",
        summary: "s",
        rationale: "r",
        status: "superseded",
        proposedBy: "codex",
        decidedAt: "2026-07-10T00:00:00.000Z",
        supersededByTopicId: "grpc",
      },
    });
    const eventBus = buildTopicFixture({
      id: "event-bus",
      title: "事件总线选型",
      decision: {
        title: "沿用数据库事件表",
        summary: "s",
        rationale: "r",
        status: "accepted",
        proposedBy: "codex",
        decidedAt: "2026-07-14T00:00:00.000Z",
      },
    });
    const grpc = buildTopicFixture({
      id: "grpc",
      title: "新传输协议",
      decision: {
        title: "gRPC 双向流",
        summary: "s",
        rationale: "r",
        status: "accepted",
        proposedBy: "claude",
        decidedAt: "2026-07-19T00:00:00.000Z",
      },
    });
    const pending = buildTopicFixture({
      id: "pending",
      title: "仍在讨论",
      status: "proposed",
      decision: {
        title: "候选方案",
        summary: "s",
        rationale: "r",
        status: "proposed",
        proposedBy: "claude",
      },
    });

    const assignments = computeAdrNumberAssignments([legacy, eventBus, grpc, pending]);
    expect(assignments.get("legacy")).toBe("ADR-001");
    expect(assignments.get("event-bus")).toBe("ADR-002");
    expect(assignments.get("grpc")).toBe("ADR-003");
    expect(assignments.has("pending")).toBe(false);

    const timeline = buildArchitectureTimeline([grpc, legacy, pending, eventBus]);
    expect(timeline.map((entry) => entry.topicId)).toEqual(["legacy", "event-bus", "grpc", "pending"]);
    expect(timeline[0]).toMatchObject({
      adrNumber: "ADR-001",
      status: "superseded",
      supersededByTopicId: "grpc",
      supersededByAdrNumber: "ADR-003",
    });
    expect(timeline.at(-1)).toMatchObject({ status: "proposed" });
    expect(timeline.at(-1)?.adrNumber).toBeUndefined();
  });

  it("没有任何决策的议题不出现在时间线里", () => {
    const noDecision = buildTopicFixture({ id: "no-decision", title: "还没有决策" });
    expect(buildArchitectureTimeline([noDecision])).toEqual([]);
    expect(computeAdrNumberAssignments([noDecision]).size).toBe(0);
  });

  it("空数组不抛出异常", () => {
    expect(buildArchitectureTimeline([])).toEqual([]);
    expect(computeAdrNumberAssignments([]).size).toBe(0);
  });
});

describe("aggregateConstraints", () => {
  it("按文本去重并合并来源，同名约束一次 warning 即整体判定为 warning", () => {
    const topicA = buildTopicFixture({
      id: "a",
      title: "议题 A",
      constraints: [{ id: "a-1", label: "保持接口兼容", tone: "positive" }],
      decision: {
        title: "d",
        summary: "s",
        rationale: "r",
        status: "accepted",
        proposedBy: "claude",
        decidedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    const topicB = buildTopicFixture({
      id: "b",
      title: "议题 B",
      constraints: [
        { id: "b-1", label: "保持接口兼容", tone: "warning" },
        { id: "b-2", label: "仅议题 B 独有的约束", tone: "positive" },
      ],
    });

    const result = aggregateConstraints([topicA, topicB]);
    const shared = result.find((item) => item.label === "保持接口兼容");
    expect(shared?.tone).toBe("warning");
    expect(shared?.sources.map((source) => source.topicId)).toEqual(["a", "b"]);
    expect(shared?.sources[0]).toMatchObject({ adrNumber: "ADR-001" });
    expect(shared?.sources[1]?.adrNumber).toBeUndefined();

    const unique = result.find((item) => item.label === "仅议题 B 独有的约束");
    expect(unique?.sources).toHaveLength(1);
  });

  it("空议题列表返回空数组", () => {
    expect(aggregateConstraints([])).toEqual([]);
  });
});

describe("collectArchitectureDiagrams", () => {
  it("从已接受决策的 summary/rationale 与 synthesis 消息里提取图，来源分别标注 ADR 和作者", () => {
    const decided = buildTopicFixture({
      id: "decided",
      title: "已接受的议题",
      decision: {
        title: "d",
        summary: "```mermaid\ngraph TD\n  A --> B\n```",
        rationale: "没有图的说明文字",
        status: "accepted",
        proposedBy: "claude",
        decidedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    const withSynthesis = buildTopicFixture({
      id: "with-synthesis",
      title: "有综合消息的议题",
      messages: [
        {
          id: "m1",
          author: "chair",
          kind: "synthesis",
          title: "综合结论",
          content: "```mermaid\nflowchart TD\n  X --> Y\n```",
          createdLabel: "18:47",
        },
        {
          id: "m2",
          author: "claude",
          kind: "proposal",
          title: "普通提案",
          content: "```mermaid\ngraph TD\n  不该被提取\n```",
          createdLabel: "10:00",
        },
      ],
    });

    const diagrams = collectArchitectureDiagrams([decided, withSynthesis]);
    expect(diagrams).toHaveLength(2);
    expect(diagrams[0]).toMatchObject({
      code: "graph TD\n  A --> B",
      topicId: "decided",
      origin: { kind: "decision", adrNumber: "ADR-001" },
    });
    expect(diagrams[1]).toMatchObject({
      code: "flowchart TD\n  X --> Y",
      topicId: "with-synthesis",
      origin: { kind: "message", author: "chair", timeLabel: "18:47" },
    });
  });

  it("proposed 决策与非 synthesis 消息里的图不会被提取", () => {
    const proposed = buildTopicFixture({
      id: "proposed",
      title: "仍在提案中",
      status: "proposed",
      decision: {
        title: "d",
        summary: "```mermaid\ngraph TD\n  不该出现\n```",
        rationale: "r",
        status: "proposed",
        proposedBy: "claude",
      },
    });
    expect(collectArchitectureDiagrams([proposed])).toEqual([]);
  });

  it("空议题列表返回空数组", () => {
    expect(collectArchitectureDiagrams([])).toEqual([]);
  });
});
