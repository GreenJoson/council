"""
@input  依赖：已启动的 Council Web、Playwright Chromium 和可选环境变量
@output 导出：桌面交互、大屏流体讨论列、媒体缩略/大图浏览、卡片双入口折叠、
         移动端布局和控制台错误的浏览器验收
@pos    Operator Console A 版的端到端冒烟测试

⚠️ 一旦本文件被更新，务必更新以上注释
"""

import os
from pathlib import Path

from playwright.sync_api import ConsoleMessage, sync_playwright


WEB_URL = os.environ.get("COUNCIL_WEB_URL", "http://localhost:4173")
SCREENSHOT_PATH = os.environ.get("COUNCIL_WEB_SCREENSHOT")
MEDIA_SCREENSHOT_PATH = os.environ.get("COUNCIL_MEDIA_SCREENSHOT")


def collect_console_error(message: ConsoleMessage, errors: list[str]) -> None:
    if message.type == "error":
        errors.append(message.text)


def measure_discussion_layout(page) -> dict[str, float | bool]:
    return page.evaluate(
        """
        () => {
          const card = document.querySelector('.message-card');
          const surface = document.querySelector('.message-surface');
          const paragraph = document.querySelector('.message-surface p');
          const composer = document.querySelector('.composer');
          if (!card || !surface || !paragraph || !composer) {
            throw new Error('讨论列测量目标缺失');
          }
          return {
            cardWidth: card.getBoundingClientRect().width,
            surfaceWidth: surface.getBoundingClientRect().width,
            paragraphWidth: paragraph.getBoundingClientRect().width,
            composerWidth: composer.getBoundingClientRect().width,
            hasHorizontalOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        }
        """
    )


def measure_element(locator) -> dict[str, float]:
    return locator.evaluate(
        """
        (element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }
        """
    )


def verify_fluid_discussion_width(page) -> None:
    regular = measure_discussion_layout(page)
    page.set_viewport_size({"width": 2048, "height": 1080})
    page.wait_for_timeout(100)
    wide = measure_discussion_layout(page)

    assert wide["cardWidth"] > regular["cardWidth"] + 180
    assert abs(wide["cardWidth"] - wide["composerWidth"]) < 1
    assert wide["paragraphWidth"] < wide["surfaceWidth"] - 120
    assert not wide["hasHorizontalOverflow"]

    page.set_viewport_size({"width": 1536, "height": 1024})
    page.wait_for_timeout(100)


def verify_card_bottom_collapse_control(page) -> None:
    first_card = page.locator(".message-card").first
    expand_toggle = first_card.get_by_role("button", name="展开全文", exact=True)
    expand_toggle.wait_for()
    assert expand_toggle.get_attribute("aria-expanded") == "false"

    expand_toggle.click()
    collapse_toggle = first_card.get_by_role("button", name="收起", exact=True)
    collapse_toggle.wait_for()
    assert collapse_toggle.get_attribute("aria-expanded") == "true"

    image_preview = first_card.locator(".markdown-image")
    image_preview.scroll_into_view_if_needed()
    image_box = image_preview.bounding_box()
    assert image_box is not None
    assert image_box["height"] <= 280

    collapse_toggle.click()
    first_card.get_by_role("button", name="展开全文", exact=True).wait_for()


def verify_message_jump_rail(page) -> None:
    cards = page.locator(".message-card")
    steps = page.locator(".message-jump-step")
    assert steps.count() == cards.count()

    last_step = steps.last
    last_step.click()
    page.wait_for_timeout(700)
    assert last_step.get_attribute("aria-current") == "true"

    first_step = steps.first
    first_step.click()
    page.wait_for_timeout(700)
    assert first_step.get_attribute("aria-current") == "true"


def verify_media_preview_and_lightbox(page) -> None:
    page.locator(".topic-row", has_text="对账任务分片策略").click()
    page.get_by_role("heading", name="对账任务分片策略", exact=True).wait_for()

    diagram = page.get_by_role("button", name="放大查看架构图", exact=True)
    diagram.wait_for()
    diagram_card = diagram.locator("xpath=ancestor::article[contains(@class, 'message-card')]")
    expand_toggle = diagram_card.get_by_role("button", name="展开全文", exact=True)
    if expand_toggle.count() > 0:
        expand_toggle.click()

    page.set_viewport_size({"width": 1536, "height": 1024})
    page.wait_for_timeout(100)
    regular_box = measure_element(diagram)
    assert regular_box["width"] <= 642
    assert regular_box["height"] <= 342

    page.set_viewport_size({"width": 2048, "height": 1080})
    page.wait_for_timeout(100)
    diagram.wait_for(state="visible")
    wide_box = measure_element(diagram)
    assert wide_box["width"] <= 642
    assert wide_box["height"] <= 342
    assert wide_box["height"] <= regular_box["height"] + 1

    diagram.click()
    lightbox = page.get_by_role("dialog", name="架构图放大视图")
    lightbox.wait_for()
    assert lightbox.evaluate("(element) => element.parentElement === document.body")
    frame_box = lightbox.locator(".markdown-lightbox-frame").bounding_box()
    assert frame_box is not None
    assert frame_box["width"] > wide_box["width"] + 300
    assert frame_box["height"] > wide_box["height"] + 300
    canvas_box = lightbox.locator(".markdown-lightbox-canvas").bounding_box()
    diagram_box = lightbox.locator(".markdown-lightbox-diagram svg").bounding_box()
    assert canvas_box is not None
    assert diagram_box is not None
    assert diagram_box["width"] <= canvas_box["width"]
    assert diagram_box["height"] <= canvas_box["height"], (canvas_box, diagram_box)

    if MEDIA_SCREENSHOT_PATH:
        page.wait_for_timeout(300)
        screenshot = Path(MEDIA_SCREENSHOT_PATH)
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot))

    zoom_label = lightbox.locator(".markdown-lightbox-controls > span")
    assert zoom_label.text_content() == "100%"
    stage_width = measure_element(lightbox.locator(".markdown-lightbox-stage"))["width"]
    lightbox.get_by_role("button", name="放大", exact=True).click()
    assert zoom_label.text_content() == "125%"
    zoomed_stage_width = measure_element(lightbox.locator(".markdown-lightbox-stage"))["width"]
    assert zoomed_stage_width > stage_width * 1.2
    lightbox.get_by_role("button", name="关闭大图", exact=True).click()

    page.set_viewport_size({"width": 1536, "height": 1024})
    page.locator(".topic-row", has_text="支付回调幂等方案").click()
    page.get_by_role("heading", name="支付回调幂等方案", exact=True).wait_for()


def verify_desktop(browser) -> list[str]:
    errors: list[str] = []
    page = browser.new_page(viewport={"width": 1536, "height": 1024})
    page.on("console", lambda message: collect_console_error(message, errors))
    page.goto(WEB_URL)
    page.wait_for_load_state("networkidle")

    page.get_by_role("heading", name="支付回调幂等方案", exact=True).wait_for()
    verify_fluid_discussion_width(page)
    verify_message_jump_rail(page)
    verify_card_bottom_collapse_control(page)
    verify_media_preview_and_lightbox(page)

    page.get_by_placeholder(
        "例如：先给出可回滚的最小架构方案，并列出失败条件。"
    ).fill("先审查状态机边界，再给出最小修复。")
    page.get_by_role("button", name="创建并启动", exact=True).click()
    page.get_by_text("自动轮次已创建并启动", exact=True).wait_for()
    page.get_by_text("等待 Agent", exact=True).wait_for()

    if SCREENSHOT_PATH:
        screenshot = Path(SCREENSHOT_PATH)
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot), full_page=True)

    page.get_by_placeholder("搜索议题标题或问题…").fill("状态机")
    assert page.locator(".topic-row").count() == 1
    page.get_by_placeholder("搜索议题标题或问题…").fill("")

    page.locator(".topic-row", has_text="订单状态机重构").click()
    page.get_by_role("heading", name="订单状态机重构", exact=True).wait_for()
    page.locator(".topic-row", has_text="支付回调幂等方案").click()
    page.get_by_text("等待 Agent", exact=True).wait_for()

    page.get_by_placeholder("写下公开结论、证据或回应…").fill(
        "补充验证：重复回调和乱序回调必须分别覆盖。"
    )
    page.get_by_role("button", name="Critique", exact=True).click()
    page.get_by_role("button", name="发布 Critique", exact=True).click()
    page.get_by_text("回复已发布并同步", exact=True).wait_for()
    page.get_by_text("补充验证：重复回调和乱序回调必须分别覆盖。", exact=True).wait_for()
    assert page.locator(".message-jump-step").count() == page.locator(".message-card").count()

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
    assert page.locator(".message-jump-rail").is_hidden()
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
