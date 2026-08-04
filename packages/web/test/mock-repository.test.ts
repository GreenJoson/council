/**
 * @input  依赖：MockCouncilRepository 和 mock 工作区
 * @output 导出：建议题、发帖、人工 Accepted、接受决策与只读详情测试
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
    expect(snapshot.topics[0]?.decision).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("发布公开消息并接受拟议决策", async () => {
    const repository = new MockCouncilRepository(0);
    const initial = await repository.loadWorkspace();
    const topicId = initial.topics[0]?.id;
    expect(topicId).toBeTruthy();

    const afterPost = await repository.publishMessage({
      topicId: topicId ?? "",
      author: "human",
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

  it("没有 Agent 提案时由用户直接记录 Accepted 并结束议题", async () => {
    const repository = new MockCouncilRepository(0);
    const created = await repository.createTopic({
      title: "外部修复确认",
      question: "修复部署后如何结束议题？",
      constraints: [],
    });
    const topicId = created.activeTopicId ?? "";

    const snapshot = await repository.recordManualDecision({
      topicId,
      title: "修复已上线",
      summary: "外部实施完成，线上验证通过。",
      rationale: "用户人工确认。",
    });
    const topic = snapshot.topics.find((candidate) => candidate.id === topicId);

    expect(topic?.status).toBe("decided");
    expect(topic?.decision).toMatchObject({
      title: "修复已上线",
      status: "accepted",
      proposedBy: "human",
    });
  });

  it("只读加载议题详情，不改变当前选中议题也不通知订阅者", async () => {
    const repository = new MockCouncilRepository(0);
    const initial = await repository.loadWorkspace();
    const firstTopicId = initial.topics[0]?.id ?? "";
    const otherTopicId = initial.topics[1]?.id ?? firstTopicId;
    const selected = await repository.selectTopic(firstTopicId);
    expect(selected.activeTopicId).toBe(firstTopicId);

    const listener = vi.fn();
    repository.subscribe(listener);

    const detail = await repository.loadTopicDetail(otherTopicId);
    expect(detail.id).toBe(otherTopicId);
    expect(detail.decision).toBeDefined();
    expect(detail.constraints).toBeDefined();
    expect(detail.evidence).toBeDefined();
    expect(detail.alternatives).toBeDefined();
    expect(detail.messages).toBeDefined();

    const afterRead = await repository.loadWorkspace();
    expect(afterRead.activeTopicId).toBe(firstTopicId);
    expect(listener).not.toHaveBeenCalled();
  });

  it("加载不存在的议题详情时抛出中文错误", async () => {
    const repository = new MockCouncilRepository(0);
    await expect(repository.loadTopicDetail("不存在的议题")).rejects.toThrow(
      "议题不存在或已被移除",
    );
  });
});
