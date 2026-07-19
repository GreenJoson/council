/**
 * @input  依赖：filterTopics 和脱敏议题摘要
 * @output 导出：空查询、中文查询与大小写查询测试
 * @pos    议题导航搜索行为的纯函数验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import { filterTopics } from "../src/data/selectors";
import type { TopicSummary } from "../src/types/council";

const topics: TopicSummary[] = [
  { id: "one", title: "支付回调幂等方案", status: "proposed", updatedLabel: "刚刚" },
  { id: "two", title: "Cache Invalidation", status: "discussing", updatedLabel: "昨天" },
];

describe("filterTopics", () => {
  it("空查询保留原顺序", () => {
    expect(filterTopics(topics, "  ")).toEqual(topics);
  });

  it("支持中文标题和大小写无关查询", () => {
    expect(filterTopics(topics, "幂等").map((topic) => topic.id)).toEqual(["one"]);
    expect(filterTopics(topics, "cache").map((topic) => topic.id)).toEqual(["two"]);
  });
});
