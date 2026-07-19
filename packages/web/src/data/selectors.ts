/**
 * @input  依赖：议题摘要与用户搜索文本
 * @output 导出：filterTopics 纯筛选函数
 * @pos    议题导航的可测试查询逻辑
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { TopicSummary } from "../types/council";

export function filterTopics<T extends TopicSummary>(topics: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return topics;
  }
  return topics.filter((topic) =>
    topic.title.toLocaleLowerCase().includes(normalizedQuery),
  );
}
