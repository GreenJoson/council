/**
 * @input  依赖：filterTopics、groupTopicsByStatus 和脱敏议题摘要（含可选 question 字段）
 * @output 导出：空查询、中文查询、大小写查询、状态筛选、问题描述匹配与按状态分组测试
 * @pos    议题导航搜索与架构视图看板分组行为的纯函数验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import { filterTopics, groupTopicsByStatus, topicStatusOrder } from "../src/data/selectors";
import type { TopicSummary } from "../src/types/council";

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

describe("groupTopicsByStatus", () => {
  it("按固定状态顺序分组，五个状态键始终存在", () => {
    const grouped = groupTopicsByStatus(topics);
    expect(Object.keys(grouped)).toEqual([...topicStatusOrder]);
    expect(grouped.proposed.map((topic) => topic.id)).toEqual(["one"]);
    expect(grouped.discussing.map((topic) => topic.id)).toEqual(["two"]);
    expect(grouped.decided.map((topic) => topic.id)).toEqual(["three"]);
    expect(grouped.open).toEqual([]);
    expect(grouped.synthesis).toEqual([]);
  });

  it("同一状态内保持传入顺序，不做二次排序", () => {
    const sameStatusTopics: TopicSummary[] = [
      { id: "a", title: "A", status: "discussing", updatedLabel: "刚刚" },
      { id: "b", title: "B", status: "discussing", updatedLabel: "昨天" },
    ];
    expect(groupTopicsByStatus(sameStatusTopics).discussing.map((topic) => topic.id)).toEqual(["a", "b"]);
  });

  it("空数组返回五个空分组，不抛出异常", () => {
    const grouped = groupTopicsByStatus<TopicSummary>([]);
    for (const status of topicStatusOrder) {
      expect(grouped[status]).toEqual([]);
    }
  });
});
