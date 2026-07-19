/**
 * @input  依赖：议题摘要（可选 question 字段）、用户搜索文本与状态筛选
 * @output 导出：TopicStatusFilter、filterTopics（按标题或问题描述匹配）与
 *         topicStatusOrder、groupTopicsByStatus（按状态分组）纯函数
 * @pos    议题导航搜索与架构视图看板共用的可测试查询逻辑
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { TopicStatus, TopicSummary } from "../types/council";

export type TopicStatusFilter = "all" | "active" | "decided";

/**
 * 文本匹配同时命中标题和问题描述：
 * TopicSummary 本身没有 question 字段，轻量议题（question 缺省）自然只能靠标题匹配；
 * TopicDetail 等携带完整 question 的类型可以额外命中问题描述，签名保持向后兼容。
 */
export function filterTopics<T extends TopicSummary & { question?: string }>(
  topics: T[],
  query: string,
  statusFilter: TopicStatusFilter = "all",
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return topics.filter((topic) => {
    if (statusFilter === "decided" && topic.status !== "decided") {
      return false;
    }
    if (statusFilter === "active" && topic.status === "decided") {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    const titleMatches = topic.title.toLocaleLowerCase().includes(normalizedQuery);
    const questionMatches = (topic.question ?? "").toLocaleLowerCase().includes(normalizedQuery);
    return titleMatches || questionMatches;
  });
}

/** 架构视图看板的固定列顺序：从提出到落地决策 */
export const topicStatusOrder: readonly TopicStatus[] = [
  "open",
  "proposed",
  "discussing",
  "synthesis",
  "decided",
];

/**
 * 按 topicStatusOrder 固定顺序分组，供架构视图看板渲染；
 * 组内保持传入顺序，不做二次排序，也不发起任何请求。
 */
export function groupTopicsByStatus<T extends TopicSummary>(topics: T[]): Record<TopicStatus, T[]> {
  const grouped = Object.fromEntries(
    topicStatusOrder.map((status) => [status, [] as T[]]),
  ) as Record<TopicStatus, T[]>;
  for (const topic of topics) {
    grouped[topic.status].push(topic);
  }
  return grouped;
}
