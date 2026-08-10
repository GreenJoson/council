/**
 * @input  依赖：语言偏好解析、英文词典、I18nProvider 与 HeaderBar 静态渲染
 * @output 验证：系统语言回退、手动偏好优先、插值、未知用户内容原样保留和中英切换入口
 * @pos    Council 中英双语边界的前端回归测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeaderBar } from "../src/components/HeaderBar";
import { I18nProvider, translate } from "../src/i18n/I18nProvider";
import { resolveLocalePreference } from "../src/i18n/locale";

describe("Council 界面语言", () => {
  it("优先使用已保存选择，否则按系统语言选择中英文", () => {
    expect(resolveLocalePreference("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveLocalePreference("en", ["zh-CN"])).toBe("en");
    expect(resolveLocalePreference(null, ["zh-Hans", "en-US"])).toBe("zh-CN");
    expect(resolveLocalePreference(null, ["en-GB"])).toBe("en");
  });

  it("翻译固定界面文案并保留参数与未知用户内容", () => {
    expect(translate("en", "已完成 {completed}，共 {total} 项任务", {
      completed: 3,
      total: 5,
    })).toBe("3 of 5 tasks completed");
    expect(translate("en", "这是用户自己写的议题正文")).toBe("这是用户自己写的议题正文");
    expect(translate("en", "第 2 项 commit 必须是 7–40 位十六进制 SHA"))
      .toBe("Commit 2 must be a 7–40 character hexadecimal SHA");
    expect(translate("zh-CN", "新建议题")).toBe("新建议题");
  });

  it("英文模式渲染核心命令栏和中英切换入口", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HeaderBar
          project={{ id: "example", name: "Example" }}
          sync={{ status: "connected", label: "已连接" }}
          searchQuery=""
          themePreference="system"
          onCycleTheme={() => undefined}
          onSearchChange={() => undefined}
          onCreateTopic={() => undefined}
          onRetrySync={() => undefined}
          onOpenTopics={() => undefined}
          onOpenInspector={() => undefined}
          onOpenSettings={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain("New topic");
    expect(html).toContain("Search topic titles or questions…");
    expect(html).toContain('aria-label="Interface language"');
    expect(html).toContain('aria-label="Chinese"');
    expect(html).toContain('aria-label="English"');
    expect(html).toContain(">EN<");
  });
});
