"""
@input  依赖：已启动的 Council HTTP/Web、Playwright Chromium 和测试 URL 环境变量
@output 导出：项目隔离、REST/SSE、圆桌名册热加载、远程 Provider 安全失败原因、受控 Git ToolLoop、配置失效边界与 Claude 验收
@pos    真实 HTTP + SQLite + 子进程 Agent 链路的浏览器主验收

⚠️ 一旦本文件被更新，务必更新以上注释
"""

import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from playwright.sync_api import ConsoleMessage, sync_playwright


WEB_URL = os.environ["COUNCIL_WEB_URL"].rstrip("/")
API_URL = os.environ["COUNCIL_API_URL"].rstrip("/")
PROJECT_PATH = os.environ["COUNCIL_PROJECT_PATH"]
FAKE_PROVIDER_URL = os.environ["COUNCIL_FAKE_PROVIDER_URL"]
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


def api_expect_error(
    method: str,
    path: str,
    expected_status: int,
    payload: dict | None = None,
):
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Origin": WEB_ORIGIN}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(f"{API_URL}{path}", data=body, headers=headers, method=method)
    try:
        LOCAL_OPENER.open(request, timeout=5)
    except HTTPError as error:
        envelope = json.loads(error.read().decode(errors="replace"))
        assert error.code == expected_status, envelope
        assert envelope["code"] == expected_status, envelope
        return envelope
    raise AssertionError(f"API {method} {path} 应返回 {expected_status}")


def create_and_start_run(
    topic_id: str,
    agent_id: str,
    instruction: str,
    confirmation_before_completion: bool = False,
):
    run = api_request(
        "POST",
        f"/api/v1/topics/{topic_id}/runs",
        {
            "confirmationBeforeCompletion": confirmation_before_completion,
            "plan": [
                {
                    "adapterId": agent_id,
                    "messageKind": "proposal",
                    "instruction": instruction,
                }
            ],
        },
    )
    api_request("POST", f"/api/v1/runs/{run['id']}/actions/start", {})
    return run


def wait_for_run_status(run_id: str, expected_status: str, timeout: float = 10):
    deadline = time.monotonic() + timeout
    last_run = None
    while time.monotonic() < deadline:
        last_run = api_request("GET", f"/api/v1/runs/{run_id}")
        if last_run["status"] == expected_status:
            return last_run
        if last_run["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.05)
    raise AssertionError(f"Run {run_id} 未进入 {expected_status}：{last_run}")


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
    claude_adapter = next(
        adapter
        for adapter in capabilities["adapters"]
        if adapter["label"] == "Claude"
    )
    assert claude_adapter["id"] == "claude"

    page.get_by_role("button", name="打开模型与 Provider 设置", exact=True).click()
    page.get_by_role("heading", name="Provider 与 Agent", exact=True).wait_for()
    claude_editor = page.locator(".model-router-editor", has_text="Claude")
    claude_editor.get_by_text("模型 ID", exact=True).locator("..").locator("input").fill(
        "claude-opus-router-test"
    )
    claude_editor.get_by_role("button", name="保存 Agent", exact=True).click()
    page.get_by_text("立即生效。", exact=False).wait_for()
    assert page.locator(".model-router-list-item", has_text="DeepSeek").count() == 0
    assert page.locator(".model-router-list-item", has_text="Kimi").count() == 0
    page.get_by_role("button", name="连接 Provider", exact=False).click()
    page.get_by_role("button", name="DeepSeek", exact=False).wait_for()
    provider_catalog = page.locator(".agent-provider-catalog-list")
    kimi_api = provider_catalog.locator("button").filter(
        has=page.get_by_text("Kimi", exact=True)
    )
    kimi_code = provider_catalog.locator("button").filter(
        has=page.get_by_text("Kimi Code", exact=True)
    )
    kimi_api.wait_for()
    kimi_code.wait_for()
    assert kimi_api.count() == 1
    assert kimi_code.count() == 1
    assert "OpenAI 兼容连接" in kimi_api.inner_text()
    assert "本机 ACP Agent 连接" in kimi_code.inner_text()
    page.get_by_role("button", name="DeepSeek", exact=False).click()
    page.get_by_text("连接 DeepSeek", exact=True).wait_for()
    page.get_by_role("button", name="取消", exact=True).click()
    page.get_by_role("button", name="关闭模型路由", exact=True).click()
    model_router = api_request("GET", "/api/v1/settings/model-router")
    assert next(
        agent for agent in model_router["agents"] if agent["mentionAlias"] == "claude"
    )["model"] == "claude-opus-router-test"

    grok_provider = api_request(
        "POST",
        "/api/v1/settings/providers",
        {
            "templateId": "grok",
            "slug": "grok",
            "displayName": "Grok",
            "active": False,
        },
    )
    assert "credentialRef" not in grok_provider
    immutable_error = api_expect_error(
        "PUT",
        f"/api/v1/settings/providers/{grok_provider['id']}",
        400,
        {
            "displayName": "Other",
            "baseUrl": grok_provider["baseUrl"],
            "brandAssetId": "brand-custom",
            "active": False,
        },
    )
    assert "名称与品牌不能修改" in immutable_error["message"]

    remote_provider = api_request(
        "POST",
        "/api/v1/settings/providers",
        {
            "templateId": "custom",
            "slug": "router-e2e",
            "displayName": "Router E2E",
            "baseUrl": FAKE_PROVIDER_URL,
            "brandAssetId": "brand-custom",
            "apiKey": "e2e-example-key",
            "active": True,
        },
    )
    assert remote_provider["hasApiKey"] is True
    assert "credentialRef" not in remote_provider
    alpha_agent = api_request(
        "POST",
        "/api/v1/settings/agents",
        {
            "providerId": remote_provider["id"],
            "slug": "router-alpha",
            "displayName": "Router Alpha",
            "model": "router-model-alpha",
            "mentionAlias": "router-alpha",
            "enabled": True,
        },
    )
    beta_agent = api_request(
        "POST",
        "/api/v1/settings/agents",
        {
            "providerId": remote_provider["id"],
            "slug": "router-beta",
            "displayName": "Router Beta",
            "model": "router-model-beta",
            "mentionAlias": "router-beta",
            "enabled": True,
        },
    )
    tool_agent = api_request(
        "POST",
        "/api/v1/settings/agents",
        {
            "providerId": remote_provider["id"],
            "slug": "router-tool",
            "displayName": "Router Tool",
            "model": "router-model-tool",
            "mentionAlias": "router-tool",
            "enabled": True,
        },
    )
    git_agent = api_request(
        "POST",
        "/api/v1/settings/agents",
        {
            "providerId": remote_provider["id"],
            "slug": "router-git",
            "displayName": "Router Git",
            "model": "router-model-git",
            "mentionAlias": "router-git",
            "enabled": True,
        },
    )
    ready_snapshot = api_request("GET", "/api/v1/settings/model-router")
    ready_provider = next(
        provider
        for provider in ready_snapshot["providers"]
        if provider["id"] == remote_provider["id"]
    )
    assert ready_provider["hasApiKey"] is True, ready_provider
    remote_capabilities = api_request("GET", "/api/v1/orchestration/capabilities")
    available_remote_ids = {
        adapter["id"]
        for adapter in remote_capabilities["adapters"]
        if adapter["available"]
    }
    assert {
        alpha_agent["id"],
        beta_agent["id"],
        tool_agent["id"],
        git_agent["id"],
    } <= available_remote_ids, remote_capabilities
    # 配置由外部 API 客户端写入；重新加载浏览器快照，但不重启 Agent Service。
    page.reload(wait_until="domcontentloaded")
    page.get_by_role("heading", name="真实同步验收", exact=True).wait_for()
    roundtable_roster = page.locator(".cycle-roster")
    roundtable_roster.get_by_text("Router Alpha", exact=True).wait_for()
    roundtable_roster.get_by_text("Router Beta", exact=True).wait_for()
    roundtable_roster.get_by_text("Router Tool", exact=True).wait_for()
    roundtable_roster.get_by_text("Router Git", exact=True).wait_for()

    alpha_run = create_and_start_run(
        topic_id,
        alpha_agent["id"],
        "远程 Alpha 即时调用验收。",
    )
    page.get_by_text("远程 Alpha Agent 已完成即时调用。", exact=True).wait_for()
    wait_for_run_status(alpha_run["id"], "completed")
    beta_run = create_and_start_run(
        topic_id,
        beta_agent["id"],
        "远程 Beta 即时调用验收。",
    )
    page.get_by_text("远程 Beta Agent 已完成即时调用。", exact=True).wait_for()
    wait_for_run_status(beta_run["id"], "completed")
    tool_run = create_and_start_run(
        topic_id,
        tool_agent["id"],
        "使用 Council 只读工具核对项目 package.json。",
    )
    page.get_by_text(
        "远程 ToolLoop 已通过 Council 只读工具读取项目 package.json。",
        exact=True,
    ).wait_for()
    wait_for_run_status(tool_run["id"], "completed")
    git_run = create_and_start_run(
        topic_id,
        git_agent["id"],
        "使用 Council 受控 Git 工具核对当前 HEAD 的已提交差异。",
    )
    page.get_by_text(
        "远程 ToolLoop 已通过 Council 受控 Git 工具读取已提交 diff。",
        exact=True,
    ).wait_for()
    wait_for_run_status(git_run["id"], "completed")

    renamed_alpha = api_request(
        "PUT",
        f"/api/v1/settings/agents/{alpha_agent['id']}",
        {
            "displayName": "Router Alpha",
            "model": "router-model-alpha",
            "mentionAlias": "router-alpha-renamed",
            "enabled": True,
        },
    )
    assert renamed_alpha["mentionAlias"] == "router-alpha-renamed"
    renamed_snapshot = api_request("GET", "/api/v1/settings/model-router")
    live_aliases = {
        agent["mentionAlias"]
        for agent in renamed_snapshot["agents"]
        if not agent.get("deletedAt")
    }
    assert "router-alpha-renamed" in live_aliases
    assert "router-alpha" not in live_aliases

    disabled_agent = api_request(
        "POST",
        "/api/v1/settings/agents",
        {
            "providerId": remote_provider["id"],
            "slug": "router-disabled",
            "displayName": "Router Disabled",
            "model": "failure-model",
            "mentionAlias": "router-disabled",
            "enabled": True,
        },
    )
    disabled_run = create_and_start_run(
        topic_id,
        disabled_agent["id"],
        "制造可恢复失败后停用 Agent。",
    )
    wait_for_run_status(disabled_run["id"], "failed")
    page.get_by_text(
        "Provider 服务暂时不可用（HTTP 503），请稍后恢复。",
        exact=True,
    ).wait_for()
    api_request(
        "PUT",
        f"/api/v1/settings/agents/{disabled_agent['id']}",
        {
            "displayName": "Router Disabled",
            "model": "failure-model",
            "mentionAlias": "router-disabled",
            "enabled": False,
        },
    )
    api_expect_error(
        "POST",
        f"/api/v1/runs/{disabled_run['id']}/actions/recover",
        409,
        {},
    )

    deleted_agent = api_request(
        "POST",
        "/api/v1/settings/agents",
        {
            "providerId": remote_provider["id"],
            "slug": "router-deleted",
            "displayName": "Router Deleted",
            "model": "failure-model",
            "mentionAlias": "router-deleted",
            "enabled": True,
        },
    )
    deleted_run = create_and_start_run(
        topic_id,
        deleted_agent["id"],
        "制造可恢复失败后删除 Agent。",
    )
    wait_for_run_status(deleted_run["id"], "failed")
    api_request("DELETE", f"/api/v1/settings/agents/{deleted_agent['id']}")
    api_expect_error(
        "POST",
        f"/api/v1/runs/{deleted_run['id']}/actions/recover",
        409,
        {},
    )

    for index in range(1, 5):
        api_request(
            "POST",
            "/api/v1/settings/providers",
            {
                "templateId": "custom",
                "slug": f"archive-provider-{index}",
                "displayName": f"Archive Provider {index}",
                "brandAssetId": "brand-custom",
                "active": False,
            },
        )
    eight_provider_snapshot = api_request("GET", "/api/v1/settings/model-router")
    live_providers = [
        provider
        for provider in eight_provider_snapshot["providers"]
        if provider["status"] != "deleted"
    ]
    assert len(live_providers) == 8

    page.get_by_role("button", name="打开模型与 Provider 设置", exact=True).click()
    page.get_by_role("heading", name="Provider 与 Agent", exact=True).wait_for()
    page.get_by_text("8 个 Provider 连接", exact=True).wait_for()
    router_nav = page.locator(".model-router-nav")
    assert router_nav.evaluate("(element) => element.scrollHeight > element.clientHeight")
    last_provider = page.locator(
        ".model-router-list-item",
        has_text="Archive Provider 4",
    )
    last_provider.scroll_into_view_if_needed()
    last_provider.click()
    page.locator(".model-router-editor", has_text="Archive Provider 4").wait_for()
    assert page.locator('svg[aria-label="OpenAI"]').count() > 0
    assert page.locator('svg[aria-label="Grok"]').count() > 0
    page.get_by_role("button", name="关闭模型路由", exact=True).click()

    claude_run = create_and_start_run(
        topic_id,
        "claude",
        "真实编排 E2E：请给出可回滚的最小方案。",
        confirmation_before_completion=True,
    )
    wait_for_run_status(claude_run["id"], "waiting_user")
    agent_message = "自动 Claude 回帖：先固定状态机不变量，再验证可回滚的最小方案。"
    page.get_by_text(agent_message, exact=True).wait_for(timeout=15_000)
    page.get_by_role("heading", name="运行状态", exact=True).wait_for()
    page.get_by_text("等待确认", exact=True).wait_for()
    page.get_by_role("button", name="确认并完成", exact=True).click()
    page.get_by_text("确认已提交，自动轮次继续", exact=True).wait_for()
    wait_for_run_status(claude_run["id"], "completed")

    runs = api_request("GET", f"/api/v1/topics/{topic_id}/runs")
    assert runs["total"] >= 5
    assert next(
        run for run in runs["runs"] if run["id"] == claude_run["id"]
    )["status"] == "completed"
    generated_detail = api_request("GET", f"/api/v1/topics/{topic_id}")
    assert any(
        message["actorId"] == "claude" and message["content"] == agent_message
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
