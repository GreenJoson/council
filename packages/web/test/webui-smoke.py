"""
@input  依赖：已启动的 Council Web、Playwright Chromium 和可选环境变量
@output 导出：桌面交互、移动端布局和控制台错误的浏览器验收
@pos    Operator Console A 版的端到端冒烟测试

⚠️ 一旦本文件被更新，务必更新以上注释
"""

import os
from pathlib import Path

from playwright.sync_api import ConsoleMessage, sync_playwright


WEB_URL = os.environ.get("COUNCIL_WEB_URL", "http://127.0.0.1:4173")
SCREENSHOT_PATH = os.environ.get("COUNCIL_WEB_SCREENSHOT")


def collect_console_error(message: ConsoleMessage, errors: list[str]) -> None:
    if message.type == "error":
        errors.append(message.text)


def verify_desktop(browser) -> list[str]:
    errors: list[str] = []
    page = browser.new_page(viewport={"width": 1536, "height": 1024})
    page.on("console", lambda message: collect_console_error(message, errors))
    page.goto(WEB_URL)
    page.wait_for_load_state("networkidle")

    page.get_by_role("heading", name="支付回调幂等方案", exact=True).wait_for()

    if SCREENSHOT_PATH:
        screenshot = Path(SCREENSHOT_PATH)
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot), full_page=True)

    page.get_by_placeholder("搜索 topics、参与者或内容…").fill("状态机")
    assert page.locator(".topic-row").count() == 1
    page.get_by_placeholder("搜索 topics、参与者或内容…").fill("")

    page.locator(".topic-row", has_text="订单状态机重构").click()
    page.get_by_role("heading", name="订单状态机重构", exact=True).wait_for()
    page.locator(".topic-row", has_text="支付回调幂等方案").click()

    page.get_by_placeholder("写下公开结论、证据或回应…").fill(
        "补充验证：重复回调和乱序回调必须分别覆盖。"
    )
    page.get_by_role("button", name="Critique", exact=True).click()
    page.get_by_role("button", name="发布 Critique", exact=True).click()
    page.get_by_text("回复已写入当前原型", exact=True).wait_for()
    page.get_by_text("补充验证：重复回调和乱序回调必须分别覆盖。", exact=True).wait_for()

    page.get_by_role("button", name="标记为 Accepted", exact=True).click()
    page.get_by_text("决策已记录为 Accepted", exact=True).wait_for()

    page.get_by_role("button", name="新建议题", exact=True).click()
    page.get_by_label("议题标题").fill("本地事件同步策略")
    page.get_by_label("待解决的问题").fill("如何在多个客户端之间同步新消息？")
    page.locator("dialog label", has_text="约束条件").locator("textarea").fill(
        "不依赖公网服务"
    )
    page.get_by_role("button", name="创建议题", exact=True).click()
    page.get_by_role("heading", name="本地事件同步策略", exact=True).wait_for()

    page.close()
    return errors


def verify_mobile(browser) -> None:
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(WEB_URL)
    page.wait_for_load_state("networkidle")
    page.get_by_role("heading", name="支付回调幂等方案", exact=True).wait_for()
    has_horizontal_overflow = page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth"
    )
    assert not has_horizontal_overflow
    page.get_by_role("button", name="打开议题导航", exact=True).click()
    assert page.locator(".topic-sidebar.panel-open").is_visible()
    page.get_by_role("button", name="关闭议题导航", exact=True).click()
    page.close()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    console_errors = verify_desktop(browser)
    verify_mobile(browser)
    browser.close()

if console_errors:
    raise AssertionError(f"浏览器控制台出现错误：{console_errors}")

print("Council Web 浏览器验收通过")
