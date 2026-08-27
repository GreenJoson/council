/**
 * @input  依赖：ArchitectureSection 外壳、折叠状态纯解析函数与服务端静态渲染
 * @output 验证：展开时渲染正文并标 aria-expanded，折叠时正文不进 DOM，
 *         存量折叠状态能读回且拒绝未知区块 id 与损坏的值
 * @pos    架构档案长清单可收起的回归证据；折叠只藏不卸载会让长页面照样卡
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchitectureSection } from "../src/components/architecture/ArchitectureSection";
import { I18nProvider } from "../src/i18n/I18nProvider";
import { parseCollapsedSections } from "../src/data/section-collapse";

function section(isCollapsed: boolean, locale: "zh-CN" | "en" = "zh-CN"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ArchitectureSection
        id="constraints"
        className="architecture-constraints"
        icon={<svg />}
        title="架构不变量"
        count={8}
        isCollapsed={isCollapsed}
        onToggle={() => undefined}
      >
        <p>总架构与既有四个子议题 accepted 决策为上位约束</p>
      </ArchitectureSection>
    </I18nProvider>,
  );
}

describe("架构档案区块折叠", () => {
  it("展开时渲染正文，并把标题栏标成已展开的开关", () => {
    const html = section(false);

    expect(html).toContain("总架构与既有四个子议题");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="architecture-section-constraints"');
    expect(html).toContain("架构不变量");
    expect(html).toContain(">8<");
  });

  it("折叠时正文不进 DOM，只留标题栏", () => {
    const html = section(true);

    // 用 CSS 藏起来等于长页面照样要渲染几十条约束；折叠必须真的不挂载。
    expect(html).not.toContain("总架构与既有四个子议题");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("architecture-section-collapsed");
    expect(html).toContain("架构不变量");
  });

  it("英文界面下开关提示也翻译", () => {
    expect(section(false, "en")).toContain('title="Collapse Architecture invariants"');
    expect(section(true, "en")).toContain('title="Expand Architecture invariants"');
  });
});

describe("折叠状态解析", () => {
  it("读回存过的区块", () => {
    expect([...parseCollapsedSections(JSON.stringify(["constraints", "diagrams"]))].sort())
      .toEqual(["constraints", "diagrams"]);
  });

  it("没存过时默认全部展开", () => {
    expect(parseCollapsedSections(null).size).toBe(0);
  });

  it("忽略未知区块 id 和损坏的值，而不是整页停在折叠态", () => {
    expect([...parseCollapsedSections(JSON.stringify(["constraints", "已经改名的区块"]))])
      .toEqual(["constraints"]);
    expect(parseCollapsedSections("{ 不是 JSON").size).toBe(0);
    expect(parseCollapsedSections(JSON.stringify({ constraints: true })).size).toBe(0);
  });
});
