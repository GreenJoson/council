"""
@input  依赖：已启动的 Council HTTP/Web、Playwright Chromium 和测试 URL 环境变量
@output 导出：项目隔离、REST/SSE 共享与 Claude 自动轮次的端到端验收
@pos    真实 HTTP + SQLite + 子进程 Agent 链路的浏览器主验收

⚠️ 一旦本文件被更新，务必更新以上注释
"""

import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from playwright.sync_api import ConsoleMessage, sync_playwright


WEB_URL = os.environ["COUNCIL_WEB_URL"].rstrip("/")
API_URL = os.environ["COUNCIL_API_URL"].rstrip("/")
PROJECT_PATH = os.environ["COUNCIL_PROJECT_PATH"]
SCREENSHOT_PATH = os.environ.get("COUNCIL_WEB_SCREENSHOT")
web_parts = urlsplit(WEB_URL)
WEB_ORIGIN = f"{web_parts.scheme}://{web_parts.netloc}"
LOCAL_OPENER = build_opener(ProxyHandler({}))


def api_request(method: str, path: str, payload: dict | None = None):
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Origin": WEB_ORIGIN}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(f"{API_URL}{path}", data=body, headers=headers, method=method)
    try:
        with LOCAL_OPENER.open(request, timeout=5) as response:
            envelope = json.load(response)
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise AssertionError(f"API {method} {path} 失败：{error.code} {detail}") from error
    assert envelope["code"] == 0, envelope
    return envelope["data"]


def collect_console_error(message: ConsoleMessage, errors: list[str]) -> None:
    if message.type == "error":
        errors.append(message.text)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1536, "height": 1024})
    console_errors: list[str] = []
    page.on("console", lambda message: collect_console_error(message, console_errors))
    # EventSource 会保持长连接，HTTP 模式不能使用永远不空闲的 networkidle。
    page.goto(WEB_URL, wait_until="domcontentloaded")
    page.get_by_role("heading", name="这个工作区还没有议题", exact=True).wait_for()

    topic = api_request(
        "POST",
        "/api/v1/topics",
        {
            "title": "真实同步验收",
            "question": "另一个进程写入后，页面能否自动显示？",
            "constraints": ["不手动刷新页面"],
            "projectPath": PROJECT_PATH,
        },
    )
    topic_id = topic["id"]
    page.get_by_role("heading", name="真实同步验收", exact=True).wait_for()

    capabilities = api_request("GET", "/api/v1/orchestration/capabilities")
    assert capabilities["adapters"][0]["id"] == "claude"
    assert capabilities["adapters"][0]["available"] is True
    capability_ledger = page.get_by_label("Agent 主动调用能力")
    capability_ledger.get_by_text("Claude Code", exact=True).wait_for()
    capability_ledger.get_by_text("可由 Web 主动调用", exact=True).wait_for()
    page.get_by_placeholder(
        "例如：先给出可回滚的最小架构方案，并列出失败条件。"
    ).fill("真实编排 E2E：请给出可回滚的最小方案。")
    page.get_by_role("button", name="创建并启动", exact=True).click()
    page.get_by_text("自动轮次已创建并启动", exact=True).wait_for()
    agent_message = "自动 Claude 回帖：先固定状态机不变量，再验证可回滚的最小方案。"
    page.get_by_text(agent_message, exact=True).wait_for(timeout=15_000)
    page.get_by_text("等待确认", exact=True).wait_for()
    page.get_by_role("button", name="批准继续", exact=True).click()
    page.get_by_text("确认已提交，自动轮次继续", exact=True).wait_for()
    page.get_by_text("已完成", exact=True).wait_for()

    runs = api_request("GET", f"/api/v1/topics/{topic_id}/runs")
    assert runs["total"] == 1
    assert runs["runs"][0]["status"] == "completed"
    generated_detail = api_request("GET", f"/api/v1/topics/{topic_id}")
    assert any(
        message["author"] == "claude" and message["content"] == agent_message
        for message in generated_detail["messages"]
    )

    if SCREENSHOT_PATH:
        screenshot = Path(SCREENSHOT_PATH)
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot), full_page=True)

    api_request(
        "POST",
        f"/api/v1/topics/{topic_id}/messages",
        {
            "kind": "proposal",
            "content": "这条回复由另一个 human API 客户端写入。",
        },
    )
    page.get_by_text("这条回复由另一个 human API 客户端写入。", exact=True).wait_for()

    page.get_by_placeholder("写下公开结论、证据或回应…").fill(
        "浏览器已通过 SSE 自动看到该回复。"
    )
    page.get_by_role("button", name="Critique", exact=True).click()
    page.get_by_role("button", name="发布 Critique", exact=True).click()
    page.get_by_text("回复已发布并同步", exact=True).wait_for()
    detail = api_request("GET", f"/api/v1/topics/{topic_id}")
    assert any(
        message["content"] == "浏览器已通过 SSE 自动看到该回复。"
        for message in detail["messages"]
    )

    api_request(
        "POST",
        f"/api/v1/topics/{topic_id}/decisions",
        {
            "title": "采用 SQLite revision 与 SSE",
            "decision": "任一客户端写入后，由本地事件流通知浏览器刷新当前议题。",
            "rationale": "复用同一份本地数据且不需要复制粘贴。",
            "alternatives": ["手动刷新"],
            "status": "proposed",
        },
    )
    page.get_by_text("采用 SQLite revision 与 SSE", exact=True).wait_for()
    page.get_by_role("button", name="标记为 Accepted", exact=True).click()
    page.get_by_text("决策已记录为 Accepted", exact=True).wait_for()
    accepted_detail = api_request("GET", f"/api/v1/topics/{topic_id}")
    assert any(decision["status"] == "accepted" for decision in accepted_detail["decisions"])

    second_topic = api_request(
        "POST",
        "/api/v1/topics",
        {
            "title": "惰性详情验收",
            "question": "切换议题时是否只读取当前详情？",
            "constraints": [],
            "projectPath": PROJECT_PATH,
        },
    )
    page.locator(".topic-row", has_text="惰性详情验收").wait_for()
    page.locator(".topic-row", has_text="惰性详情验收").click()
    page.get_by_role("heading", name="惰性详情验收", exact=True).wait_for()
    assert second_topic["id"] != topic_id

    assert not console_errors, console_errors
    page.close()
    browser.close()

print("Council HTTP/SSE/Claude 自动轮次端到端验收通过")
