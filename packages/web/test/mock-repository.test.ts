/**
 * @input  依赖：MockCouncilRepository 和 mock 工作区
 * @output 导出：建议题、发帖、订阅与接受决策测试
 * @pos    WebUI 数据状态转换的单元验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it, vi } from "vitest";
import { MockCouncilRepository } from "../src/data/mock-repository";

describe("MockCouncilRepository", () => {
  it("创建议题并通过订阅发布最新快照", async () => {
    const repository = new MockCouncilRepository(0);
    const listener = vi.fn();
    repository.subscribe(listener);

    const snapshot = await repository.createTopic({
      title: "缓存一致性边界",
      question: "如何定义缓存失效和回源的不变量？",
      constraints: ["不得返回过期权限数据"],
    });

    expect(snapshot.topics[0]?.title).toBe("缓存一致性边界");
    expect(snapshot.topics[0]?.constraints).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("发布公开消息并接受拟议决策", async () => {
    const repository = new MockCouncilRepository(0);
    const initial = await repository.loadWorkspace();
    const topicId = initial.topics[0]?.id;
    expect(topicId).toBeTruthy();

    const afterPost = await repository.publishMessage({
      topicId: topicId ?? "",
      author: "user",
      kind: "rebuttal",
      content: "补充失败恢复必须经过状态机校验。",
    });
    const postedTopic = afterPost.topics.find((topic) => topic.id === topicId);
    expect(postedTopic?.messages.at(-1)?.content).toContain("失败恢复");
    expect(postedTopic?.status).toBe("discussing");

    const afterDecision = await repository.acceptDecision(topicId ?? "");
    const decidedTopic = afterDecision.topics.find((topic) => topic.id === topicId);
    expect(decidedTopic?.decision.status).toBe("accepted");
    expect(decidedTopic?.status).toBe("decided");
  });
});
