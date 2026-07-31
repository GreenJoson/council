/**
 * @input  依赖：DecisionCard 共用决策正文卡、CouncilDecision 三种状态
 * @output 导出：决策正文只由 DecisionCard 渲染、三态文案与徽章正确的回归测试
 * @pos    防止决策长文再被塞回 340–440px 的右栏，也防止三态共用卡片时漏掉某一态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "../src/components/DecisionCard";
import type { CouncilDecision, DecisionStatus } from "../src/types/council";

function decision(status: DecisionStatus): CouncilDecision {
  return {
    title: "采用业务幂等键",
    summary: "## 一、最终方案\n\n用稳定业务标识构建唯一键。",
    rationale: "回调顺序不可依赖，状态机约束比时间戳更可靠。",
    status,
    proposedBy: "codex",
    proposedBySnapshot: {
      schemaVersion: 1,
      actorId: "actor-codex",
      slug: "codex",
      displayName: "Codex",
      shortName: "CX",
      role: "评审",
    },
  };
}

describe("决策正文渲染", () => {
  it("summary 与 rationale 都按 Markdown 渲染在同一张卡里", () => {
    const markup = renderToStaticMarkup(<DecisionCard decision={decision("proposed")} />);

    expect(markup).toContain("decision-summary-block");
    expect(markup).toContain("decision-rationale-block");
    // Markdown 标题要变成真的标题，而不是原样的 "## "
    expect(markup).toContain("一、最终方案");
    expect(markup).not.toContain("## 一、最终方案");
    expect(markup).toContain("采用业务幂等键");
  });

  /*
   * 三态各有各的图标、文案和外框类名。共用一张卡最容易漏掉的就是非 proposed
   * 的那两态——mock 数据里未必都出现，所以在这里逐个钉住。
   */
  it.each([
    ["proposed", "拟议决策", ""],
    ["accepted", "已接受决策", "decision-accepted"],
    ["superseded", "已被取代", "decision-superseded"],
  ] as const)("%s 状态渲染对应文案与外框", (status, label, className) => {
    const markup = renderToStaticMarkup(<DecisionCard decision={decision(status)} />);

    expect(markup).toContain(label);
    if (className) {
      expect(markup).toContain(className);
    }
  });

  it("尾部插槽由调用方决定：决策记录放提出人，议题里放接受操作", () => {
    const markup = renderToStaticMarkup(
      <DecisionCard decision={decision("proposed")}>
        <button className="accept-button" type="button">标记为 Accepted</button>
      </DecisionCard>,
    );

    expect(markup).toContain("accept-button");
    expect(markup).toContain("标记为 Accepted");
  });
});
