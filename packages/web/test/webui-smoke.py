"""
@input  依赖：已启动的 Council Web、Playwright Chromium 和可选环境变量
@output 导出：桌面交互、系统 Agent 身份只读、单一当前 Agent 调用/折叠历史、Agent 回复动态、过长议题折叠、大屏流体讨论列、
         媒体缩略/大图浏览、卡片底部折叠、移动端布局和控制台错误的浏览器验收
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


def verify_topic_question_collapse_control(page) -> None:
    topic_question = page.locator(".topic-question")
    collapse_frame = topic_question.locator(".markdown-collapse-frame")
    expand_toggle = topic_question.get_by_role("button", name="展开议题", exact=True)
    expand_toggle.wait_for()

    collapsed_box = measure_element(collapse_frame)
    assert collapsed_box["height"] <= 154
    assert expand_toggle.get_attribute("aria-expanded") == "false"

    expand_toggle.click()
    collapse_toggle = topic_question.get_by_role("button", name="收起议题", exact=True)
    collapse_toggle.wait_for()
    expanded_box = measure_element(collapse_frame)
    assert expanded_box["height"] > collapsed_box["height"] + 120
    assert collapse_toggle.get_attribute("aria-expanded") == "true"

    collapse_toggle.click()
    expand_toggle.wait_for()
    assert measure_element(collapse_frame)["height"] <= 154


def verify_last_card_tail_access(page) -> None:
    timeline = page.locator(".message-timeline")
    last_card = page.locator(".message-card").last
    expand_toggle = last_card.get_by_role("button", name="展开全文", exact=True)
    expand_toggle.wait_for()

    timeline.evaluate("(element) => { element.scrollTop = element.scrollHeight; }")
    page.wait_for_timeout(700)

    collapsed_gap = page.evaluate(
        """
        () => {
          const timeline = document.querySelector('.message-timeline');
          const cards = document.querySelectorAll('.message-card');
          const card = cards.item(cards.length - 1);
          if (!timeline || !card) {
            throw new Error('最后卡片滚动目标缺失');
          }
          return {
            bottomDistance:
              timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
            visibleTail:
              timeline.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom,
          };
        }
        """
    )
    assert collapsed_gap["bottomDistance"] <= 2
    assert collapsed_gap["visibleTail"] >= 100

    expand_toggle.click()
    collapse_toggle = last_card.get_by_role("button", name="收起", exact=True)
    timeline.evaluate("(element) => { element.scrollTop = element.scrollHeight; }")
    page.wait_for_timeout(700)
    collapse_toggle.wait_for()
    collapse_toggle.click()


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


def start_mock_agent_run(page, instruction: str) -> None:
    page.get_by_placeholder(
        "例如：先给出可回滚的最小架构方案，并列出失败条件。"
    ).fill(instruction)
    page.get_by_role("button", name="启动 Agent", exact=True).click()
    page.get_by_text("Agent 调用已启动", exact=True).wait_for()
    page.get_by_text("等待 Agent", exact=True).wait_for()


def verify_compact_run_history(page) -> None:
    review_checkbox = page.get_by_role("checkbox")
    assert not review_checkbox.is_checked()

    for instruction in ("检查第一次调用。", "检查第二次调用。"):
        start_mock_agent_run(page, instruction)
        page.locator(".run-card").get_by_role("button", name="取消", exact=True).click()
        page.locator(".run-card").get_by_text("已取消", exact=True).wait_for()

    start_mock_agent_run(page, "保持第三次调用为当前状态。")
    assert page.locator(".run-card").count() == 1
    history = page.locator(".run-history")
    assert history.count() == 1
    assert "2" in history.locator("summary").inner_text()
    history.locator("summary").click()
    assert page.locator(".run-history-row").count() == 2


def verify_agent_reply_activity(page) -> None:
    activity = page.get_by_role("status", name="Claude 正在回复", exact=True)
    activity.wait_for()
    assert activity.locator(".agent-reply-dots i").count() == 3
    assert activity.locator(
        "xpath=ancestor::section[contains(@class, 'message-timeline')]"
    ).count() == 1
    assert page.locator(".message-jump-step").count() == page.locator(".message-card").count()
    preview = activity.locator(".agent-reply-preview")
    preview.wait_for()
    page.get_by_text("实时草稿 · 尚未发布", exact=True).wait_for()
    page.get_by_text("正在审查状态机边界", exact=False).wait_for()


def verify_system_agent_identity_lock(page) -> None:
    page.get_by_role("button", name="打开模型与 Provider 设置").click()
    dialog = page.get_by_role("dialog", name="Provider 与 Agent")
    dialog.wait_for()
    assert dialog.get_by_label("Agent 名称").is_disabled()
    assert dialog.get_by_label("召唤别名").is_disabled()
    assert dialog.get_by_role("button", name="移除 Agent", exact=True).count() == 0
    dialog.locator(".model-router-list-item", has_text="@codex").click()
    assert dialog.get_by_label("Agent 名称").is_disabled()
    assert dialog.get_by_label("召唤别名").is_disabled()
    assert dialog.get_by_role("button", name="移除 Agent", exact=True).count() == 0

    provider_section = dialog.locator(
        ".model-router-nav-section",
        has_text="PROVIDER CONNECTIONS",
    )
    for provider_name in ("Claude", "OpenAI Codex"):
        provider_section.locator(
            ".model-router-list-item",
            has_text=provider_name,
        ).click()
        assert dialog.get_by_label("Provider 名称").is_disabled()
        assert (
            dialog.get_by_role("button", name="移除 Provider", exact=True).count()
            == 0
        )

    dialog.get_by_role("button", name="关闭模型路由").click()


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
    assert page.get_by_role("button", name="展开议题", exact=True).count() == 0
    verify_system_agent_identity_lock(page)
    verify_fluid_discussion_width(page)
    verify_message_jump_rail(page)
    verify_card_bottom_collapse_control(page)
    verify_media_preview_and_lightbox(page)

    verify_compact_run_history(page)
    verify_agent_reply_activity(page)

    if SCREENSHOT_PATH:
        screenshot = Path(SCREENSHOT_PATH)
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot), full_page=True)

    page.get_by_placeholder("搜索议题标题或问题…").fill("状态机")
    assert page.locator(".topic-row").count() == 1
    page.get_by_placeholder("搜索议题标题或问题…").fill("")

    page.locator(".topic-row", has_text="订单状态机重构").click()
    page.get_by_role("heading", name="订单状态机重构", exact=True).wait_for()
    assert page.locator(".agent-reply-activity").count() == 0
    page.locator(".topic-row", has_text="支付回调幂等方案").click()
    page.get_by_text("等待 Agent", exact=True).wait_for()
    verify_agent_reply_activity(page)

    page.get_by_placeholder("写下公开结论、证据或回应…").fill(
        """补充验证：重复回调和乱序回调必须分别覆盖。

## 并发与重放

- 相同回调并发到达时只能有一个请求进入业务处理。
- 已完成事件再次到达时直接返回稳定结果。
- 处理中事件重复到达时不得启动第二份副作用。
- 唯一索引冲突必须转换为可重试读取。

## 状态边界

- 旧状态事件不得覆盖已经确认的新状态。
- 失败重试不能绕过合法状态迁移。
- 人工恢复必须留下独立审计记录。
- 终态之后不再接受反向迁移。

## 观测与恢复

- 每次处理记录稳定请求标识和耗时。
- 超时、冲突与重复命中分别计数。
- 恢复任务使用相同幂等键重新进入流程。
- 缓存丢失后仍能从持久化结果恢复。

## 验收

- 覆盖并发、乱序、重复、超时和恢复五类测试。
- 连续刷新期间最后一张卡片必须可以滚动到完整可见。
- 展开长回复后仍能滚到正文底部并执行收起。
- 等待页面刷新后滚动位置不能自动反弹。"""
    )
    page.get_by_role("button", name="Critique", exact=True).click()
    page.get_by_role("button", name="发布 Critique", exact=True).click()
    page.get_by_text("回复已发布并同步", exact=True).wait_for()
    page.get_by_text("补充验证：重复回调和乱序回调必须分别覆盖。", exact=True).wait_for()
    assert page.locator(".message-jump-step").count() == page.locator(".message-card").count()
    verify_last_card_tail_access(page)

    page.get_by_role("button", name="标记为 Accepted", exact=True).click()
    page.get_by_text("决策已记录为 Accepted", exact=True).wait_for()

    page.get_by_role("button", name="新建议题", exact=True).click()
    page.get_by_label("议题标题").fill("本地事件同步策略")
    page.get_by_label("待解决的问题").fill(
        """如何在多个客户端之间同步新消息，并确保异常恢复后仍然保持一致？

## 背景

当前桌面端、命令行和自动 Agent 都可能向同一个议题写入消息。新的同步方案必须让用户无需手动刷新，也不能因为读取竞态覆盖已经到达的新内容。

## 预期行为

- 新消息写入后，所有打开的客户端都能及时看到。
- 网络或进程短暂中断后，恢复连接能够补齐错过的变更。
- 切换项目时，旧项目的延迟响应不能覆盖当前项目。
- 同一条消息不会因为重试而重复出现。

## 失败条件

- 依赖固定轮询作为唯一同步机制。
- 在不同客户端之间复制完整私有会话。
- 服务恢复后必须重新启动桌面应用。
- 快速切换议题时出现内容串线。

## 验证

需要覆盖连续写入、断线恢复、切换项目、重复事件和过期响应五类浏览器用例。"""
    )
    page.locator("dialog label", has_text="约束条件").locator("textarea").fill(
        "不依赖公网服务"
    )
    page.get_by_role("button", name="创建议题", exact=True).click()
    page.get_by_role("heading", name="本地事件同步策略", exact=True).wait_for()
    verify_topic_question_collapse_control(page)

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
