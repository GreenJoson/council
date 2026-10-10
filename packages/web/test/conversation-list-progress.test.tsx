/**
 * @input  依赖：ConversationList、服务端静态 React 渲染与议题摘要夹具
 * @output 导出：议题行「时间在左、完成度在右」与未拆分议题不显示徽标的回归测试
 * @pos    会话列表一眼看出哪些决策已经落地的前端验收证据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationList } from "../src/components/ConversationList";
import type { TopicSummary } from "../src/types/council";

function topic(overrides: Partial<TopicSummary> & { id: string; title: string }): TopicSummary {
  return {
    status: "decided",
    updatedLabel: "08/27 01:27",
    ...overrides,
  };
}

function render(topics: TopicSummary[]): string {
  return renderToStaticMarkup(
    <ConversationList
      project={{ id: "example", name: "Example" }}
      topics={topics}
      tasks={[]}
      pipelines={[]}
      route={{ view: "discussion" }}
      selectedTopicId={topics[0]?.id ?? ""}
      isOpen
      searchQuery=""
      onSearchChange={() => undefined}
      onNavigate={() => undefined}
      onSelectTopic={() => undefined}
      onCreateTopic={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe("ConversationList 完成度徽标", () => {
  it("在时间右侧渲染完成度，并按受阻/完成切换色调", () => {
    const html = render([
      topic({
        id: "topic_running",
        title: "认领链路",
        workItemProgress: { total: 15, completed: 12, blocked: 0, openBlockingFindings: 0 },
      }),
      topic({
        id: "topic_done",
        title: "迁移脚本",
        workItemProgress: { total: 4, completed: 4, blocked: 0, openBlockingFindings: 0 },
      }),
      topic({
        id: "topic_stuck",
        title: "评审闭环",
        workItemProgress: { total: 6, completed: 2, blocked: 0, openBlockingFindings: 3 },
      }),
    ]);

    expect(html).toContain("08/27 01:27");
    expect(html).toContain("12 / 15");
    expect(html).toContain("topic-progress-active");
    expect(html).toContain("4 / 4");
    expect(html).toContain("topic-progress-done");
    expect(html).toContain("topic-progress-blocked");
    expect(html).toContain("3 条审核问题未关闭");
  });

  it("尚未拆分实施项的议题不渲染徽标——0/0 和「还没拆」不是一回事", () => {
    const html = render([topic({ id: "topic_fresh", title: "刚开的议题", status: "open" })]);

    expect(html).toContain("刚开的议题");
    expect(html).not.toContain("topic-progress");
  });
});
