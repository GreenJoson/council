"""
@input  依赖：已启动的 Council HTTP/Web、Playwright Chromium 和测试 URL 环境变量
@output 导出：项目隔离、附件内部预览、REST/SSE、模型路由、持久审计、包装交接/损坏交接、长任务上下文与人工验收边界检查
@pos    真实 HTTP + SQLite + 子进程 Agent 链路的浏览器主验收

⚠️ 一旦本文件被更新，务必更新以上注释
"""

import json
import os
import subprocess
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


def api_request(method: str, path: str, payload: dict | None = None, timeout: int = 5):
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Origin": WEB_ORIGIN}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(f"{API_URL}{path}", data=body, headers=headers, method=method)
    try:
        with LOCAL_OPENER.open(request, timeout=timeout) as response:
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
    page = browser.new_page(viewport={"width": 1536, "height": 1024}, locale="zh-CN")
    console_errors: list[str] = []
    page.on("console", lambda message: collect_console_error(message, console_errors))
    page.on("pageerror", lambda error: console_errors.append(str(error)))
    # EventSource 会保持长连接，HTTP 模式不能使用永远不空闲的 networkidle。
    page.goto(WEB_URL, wait_until="domcontentloaded")
    try:
        page.get_by_role("heading", name="这个工作区还没有议题", exact=True).wait_for()
    except Exception:
        print("首屏内容：", page.locator("body").inner_text())
        print("页面错误：", console_errors)
        raise

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


    # 对应用户的本地 Excel/配置链接：在真实服务与浏览器内完成预览，不打开外部窗口。
    api_request("POST", f"/api/v1/topics/{topic_id}/messages", {
        "kind": "note", "content": "[完整策划 Excel](docs/design.xlsx) / [配置](docs/model.json) / [说明](docs/design.md) / [结果](docs/results.csv) / [已删除文件](docs/missing.json)"
    })
    page.get_by_role("button", name="完整策划 Excel", exact=True).wait_for()
    before_pages = len(browser.contexts[0].pages)
    page.get_by_role("button", name="完整策划 Excel", exact=True).click()
    preview = page.get_by_role("dialog", name="文件预览：design.xlsx", exact=True)
    preview.get_by_role("tab", name="总览", exact=True).wait_for()
    preview.get_by_role("cell", name="示例鱼种", exact=True).wait_for()
    preview.get_by_role("cell", name="72", exact=True).wait_for()
    preview.get_by_role("tab", name="参数", exact=True).click()
    preview.get_by_role("cell", name="成本", exact=True).wait_for()
    assert len(browser.contexts[0].pages) == before_pages
    page.keyboard.press("Escape")
    page.get_by_role("button", name="架构档案", exact=True).click()
    attachments = page.get_by_role("region", name="项目附件", exact=True)
    attachments.get_by_role("button", name="预览附件：配置", exact=True).click()
    preview = page.get_by_role("dialog", name="文件预览：model.json", exact=True)
    preview.locator("pre").filter(has_text="preview-e2e").wait_for()
    preview.get_by_role("button", name="关闭文件预览", exact=True).click()
    attachments.get_by_role("button", name="预览附件：说明", exact=True).click()
    preview = page.get_by_role("dialog", name="文件预览：design.md", exact=True)
    preview.get_by_role("heading", name="设计文档", exact=True).wait_for()
    preview.get_by_role("button", name="参数配置", exact=True).click()
    page.get_by_role("dialog", name="文件预览：model.json", exact=True).locator("pre").filter(has_text="preview-e2e").wait_for()
    page.keyboard.press("Escape")
    attachments.get_by_role("button", name="预览附件：结果", exact=True).click()
    preview = page.get_by_role("dialog", name="文件预览：results.csv", exact=True)
    preview.get_by_role("cell", name="含逗号,和换行\n第二行", exact=True).wait_for()
    page.set_viewport_size({"width": 390, "height": 844})
    assert preview.evaluate("e => e.getBoundingClientRect().right <= window.innerWidth")
    page.set_viewport_size({"width": 1536, "height": 1024})
    page.keyboard.press("Escape")
    page.screenshot(path="/tmp/council-project-attachments-e2e.png", full_page=True)
    page.get_by_role("button", name="议题", exact=True).click()
    for href, status in [("../outside.json", 403), (".env", 403), ("file:///etc/passwd", 403), ("docs/missing.json", 404), ("docs/bad.xlsx", 422), ("https://example.com/model.json", 400)]:
        api_expect_error("POST", f"/api/v1/topics/{topic_id}/files/preview", status, {"href": href})
    # 故障预览使用独立页面，预期 HTTP 404 不混入主流程控制台错误。
    failure_page = browser.new_page(locale="zh-CN")
    failure_page.goto(WEB_URL, wait_until="domcontentloaded")
    failure_page.get_by_role("button", name="已删除文件", exact=True).click()
    failure_page.get_by_role("dialog", name="文件预览：missing.json", exact=True).get_by_role("alert").filter(has_text="可能已移动或删除").wait_for()
    failure_page.close()

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
    # 所选 CLI 模型必须实际读取临时验证文件；写入权限仍不能被误标通过。
    claude_editor.get_by_role("button", name="测试", exact=True).click()
    native_diagnosis = page.get_by_role("region", name="连接诊断结果", exact=True)
    native_diagnosis.get_by_text("只读工具 · 通过", exact=True).wait_for()
    native_diagnosis.get_by_text("项目写入权限 · 未验证", exact=True).wait_for()
    native_diagnosis.get_by_text("fake-probe-model", exact=True).wait_for()
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

    # 模型发现、真实响应模型与分项结果在设置页可见；列表不能改写 Agent 模型。
    page.get_by_role("button", name="打开模型与 Provider 设置", exact=True).click()
    page.locator(".model-router-list-item", has_text="Router Alpha").click()
    editor = page.locator(".model-router-editor")
    editor.get_by_role("button", name="获取模型列表", exact=True).click()
    editor.get_by_text("当前连接返回 2 个模型", exact=True).wait_for()
    assert editor.locator("datalist option").evaluate_all("nodes => nodes.map(n => n.value)") == ["router-model-alpha", "router-model-beta"]
    editor.get_by_role("button", name="测试", exact=True).click()
    diagnosis = page.get_by_role("region", name="连接诊断结果", exact=True)
    diagnosis.get_by_text("reported-provider-model", exact=True).wait_for()
    diagnosis.get_by_text("项目写入权限 · 未验证", exact=True).wait_for()
    model_input = editor.get_by_text("模型 ID", exact=True).locator("..").locator("input")
    model_input.fill("unavailable-model")
    assert editor.locator("datalist option").count() == 2
    assert diagnosis.count() == 0
    editor.get_by_role("button", name="保存 Agent", exact=True).click()
    page.get_by_text("立即生效。", exact=False).wait_for()
    editor.get_by_role("button", name="测试", exact=True).click()
    diagnosis.get_by_text("连接诊断发现问题", exact=False).wait_for()
    diagnosis.get_by_text("模型或接口不可用，请核对精确模型 ID 与账号权限。", exact=True).wait_for()
    assert "sensitive-body-must-not-escape" not in page.locator("body").inner_text()
    # 配置写入包含 CLI 可用性刷新，单独给出有界等待；不重复超时的写请求。
    # 更换 Provider 地址或凭据后，列表失败不应伪装成成功，更不能回显上游正文。
    original_connection = {"displayName": remote_provider["displayName"], "baseUrl": FAKE_PROVIDER_URL,
        "brandAssetId": remote_provider["brandAssetId"], "active": True}
    provider_url = f"/api/v1/settings/providers/{remote_provider['id']}"
    api_request("PUT", provider_url, {**original_connection, "apiKey": "intentionally-invalid"}, timeout=20)
    unavailable_list = api_request("POST", provider_url + "/actions/models", {})
    assert unavailable_list["status"] == "failed" and unavailable_list["code"] == "authentication_failed", unavailable_list
    assert "sensitive-body-must-not-escape" not in json.dumps(unavailable_list)
    api_request("PUT", provider_url, {**original_connection, "apiKey": "e2e-example-key", "baseUrl": FAKE_PROVIDER_URL + "/unsupported"}, timeout=20)
    unsupported_list = api_request("POST", provider_url + "/actions/models", {})
    assert unsupported_list["status"] == "unsupported", unsupported_list
    api_request("PUT", provider_url, original_connection, timeout=20)
    if SCREENSHOT_PATH:
        page.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("model-diagnostics.png")), full_page=True)
    model_input.fill("router-model-alpha")
    editor.get_by_role("button", name="保存 Agent", exact=True).click()
    page.get_by_text("立即生效。", exact=False).wait_for()
    page.get_by_role("button", name="关闭模型路由", exact=True).click()

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
    wait_for_run_status(git_run["id"], "completed")
    page.get_by_text(
        "远程 ToolLoop 已通过 Council 受控 Git 工具读取已提交 diff。",
        exact=True,
    ).wait_for()

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
    # 新运行记录来自同一次真实子进程调用，展开后可读；待处理入口能跳回原议题。
    page.locator(".run-card .runtime-audit summary").click()
    page.locator(".run-card .runtime-audit-body").get_by_text("调用开始", exact=True).wait_for()
    if SCREENSHOT_PATH:
        screenshot = Path(SCREENSHOT_PATH)
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot.with_name("audit-expanded.png")), full_page=True)
    page.get_by_role("button", name="需要我处理", exact=True).click()
    page.get_by_role("heading", name="需要我处理", exact=True).wait_for()
    page.locator(".work-attention-view").get_by_text("等待回复或确认 1", exact=False).wait_for()
    if SCREENSHOT_PATH:
        page.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("needs-attention.png")), full_page=True)
    page.locator(".work-attention-view").get_by_role("button", name="真实同步验收", exact=False).click()
    page.get_by_role("button", name="确认并完成", exact=True).click()
    page.get_by_text("确认已提交，自动轮次继续", exact=True).wait_for()
    wait_for_run_status(claude_run["id"], "completed")
    page.get_by_role("button", name="需要我处理", exact=True).click()
    page.get_by_text("当前没有需要处理的事项。", exact=True).wait_for()
    page.get_by_role("button", name="议题", exact=True).click()


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
    page.get_by_role("tab", name="决策", exact=False).click()
    page.get_by_role("button", name="接受此决策", exact=True).click()
    page.get_by_text("决策已接受；任务尚未分拆，请在任务页选择 Agent 后手动开始", exact=True).wait_for()
    accepted_detail = api_request("GET", f"/api/v1/topics/{topic_id}")
    assert any(decision["status"] == "accepted" for decision in accepted_detail["decisions"])

    # 在隔离测试库配置两个可用的 CLI Agent，只验证委派表单，不启动写入调用。
    settings = api_request("GET", "/api/v1/settings/model-router")
    executor = next(agent for agent in settings["agents"] if agent["mentionAlias"] == "claude")
    api_request("PUT", f"/api/v1/settings/agents/{executor['id']}", {
        "displayName": executor["displayName"], "model": executor["model"],
        "mentionAlias": executor["mentionAlias"], "enabled": True,
        "permissionProfile": "workspace_write", "executionRole": "hybrid",
    })
    api_request("POST", "/api/v1/settings/agents", {
        "providerId": executor["providerId"], "slug": "acceptance-reviewer",
        "displayName": "Acceptance Reviewer", "model": executor["model"],
        "mentionAlias": "acceptance-reviewer", "enabled": True,
        "permissionProfile": "read_only", "executionRole": "reviewer",
    })
    created = api_request("POST", f"/api/v1/topics/{topic_id}/work-items", {
        "items": [{"title": "验证交付表单", "details": "检查提交与验收证据"}],
    })
    item_id = created[0]["id"]
    # 单条委派入口已迁到任务详情页，直接按任务 id 打开；只改 hash 不会重新加载页面，
    # 需 reload 才能取到刚配置的 Agent 能力。
    page.goto(f"{WEB_URL}#/tasks/{item_id}", wait_until="domcontentloaded")
    page.reload(wait_until="domcontentloaded")
    page.get_by_role("button", name="委派", exact=True).click()
    delegation_form = page.locator(".work-item-delegation-form")
    delegation_form.wait_for()
    if SCREENSHOT_PATH:
        page.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("delegation-form.png")), full_page=True)
    assert delegation_form.get_by_label("完成条件", exact=True).input_value() == "human"
    assert delegation_form.get_by_label("验收标准", exact=True).input_value() == "检查提交与验收证据"
    delegation_form.get_by_label("验收标准", exact=True).fill("  ")
    assert delegation_form.get_by_role("button", name="开始执行与审核", exact=True).is_disabled()
    delegation_form.get_by_label("验收标准", exact=True).fill("人工检查提交与测试结果")
    delegation_form.get_by_label("完成条件", exact=True).select_option("review")
    assert delegation_form.get_by_role("button", name="开始执行与审核", exact=True).is_enabled()
    delegation_form.get_by_label("完成条件", exact=True).select_option("human")
    if SCREENSHOT_PATH:
        page.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("delegation-acceptance.png")), full_page=True)
    # 真实 HTTP -> 子进程 -> 两段改代码 -> Git 提交 -> 审核 -> 人工验收边界。
    delegation_form.get_by_label("验收标准", exact=True).fill("COUNCIL_SEGMENT_E2E：两段文件交付，保留人工验收")
    delegation_form.locator("select").nth(1).select_option(label="Acceptance Reviewer")
    delegation_form.get_by_role("button", name="开始执行与审核", exact=True).click()
    page.get_by_text("后台执行中，关闭桌面后任务继续；重新打开可查看进度。", exact=True).wait_for()
    service = api_request("GET", "/api/v1/status")
    api_expect_error("POST", "/api/v1/service/actions/stop", 409, {"databaseInstanceId": service["databaseInstanceId"]})
    page.close()

    def wait_delegation(expected, timeout=20, delegation_topic_id=None):
        deadline = time.monotonic() + timeout
        latest = None
        while time.monotonic() < deadline:
            runs = api_request("GET", f"/api/v1/topics/{delegation_topic_id or topic_id}/work-item-delegations")
            latest = runs[0] if runs else None
            if latest and latest["status"] == expected:
                return latest
            if latest and latest["status"] in {"failed", "cancelled", "approved"}:
                break
            time.sleep(0.1)
        raise AssertionError(f"委派没有达到 {expected}：{latest}")

    completed = wait_delegation("approved")
    assert completed["execution"]["segmentsUsed"] == 2, completed
    assert completed["execution"]["segmentLimit"] == 4, completed
    detail = api_request("GET", f"/api/v1/topics/{topic_id}")
    item = next(value for value in detail["workItems"] if value["id"] == completed["workItemId"])
    assert item["status"] == "in_progress", item
    assert not (Path(PROJECT_PATH) / "stage-one.txt").exists()
    for filename in ["stage-one.txt", "stage-two.txt"]:
        assert subprocess.check_output(["git", "-C", PROJECT_PATH, "show", f"{completed['headCommit']}:{filename}"]).strip()
    page = browser.new_page(viewport={"width": 1536, "height": 1024}, locale="zh-CN")
    page.on("console", lambda message: collect_console_error(message, console_errors))
    page.on("pageerror", lambda error: console_errors.append(str(error)))
    page.goto(f"{WEB_URL}#/tasks/{completed['workItemId']}", wait_until="domcontentloaded")
    page.get_by_text("执行段：2/4", exact=True).wait_for()
    page.get_by_text("Agent 审核通过，等待人工验收；请在任务状态中填写验收证据并完成。", exact=True).wait_for()
    if SCREENSHOT_PATH:
        page.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("delegation-segments.png")), full_page=True)

    # 无文件进展的连续交接须暂停，不能无限续跑或产生交付提交。
    created_items = api_request("POST", f"/api/v1/topics/{topic_id}/work-items", {
        "items": [{"title": "无进展必须暂停", "details": "COUNCIL_SEGMENT_E2E NO_PROGRESS"}],
    })
    blocked_item = created_items[0]
    api_request("POST", f"/api/v1/topics/{topic_id}/work-items/{blocked_item['id']}/delegations", {
        "expectedVersion": blocked_item["version"], "executorAgentId": completed["executorAgentId"],
        "supervisorAgentId": completed["supervisorAgentId"], "requestedPermission": "workspace_write",
        "acceptanceCriteria": "COUNCIL_SEGMENT_E2E NO_PROGRESS", "completionPolicy": "human",
    })
    paused = wait_delegation("failed")
    assert paused["failureCode"] == "execution_no_progress", paused
    assert paused["execution"]["segmentsUsed"] == 2 and not paused.get("headCommit"), paused
    page.goto(f"{WEB_URL}#/tasks/{blocked_item['id']}", wait_until="domcontentloaded")
    page.get_by_text("已暂停，等待接续", exact=True).wait_for()

    # 对应实际故障：CLI 回合上限中断后，有安全文件进展和会话才能自动接续。
    turn_item = api_request("POST", f"/api/v1/topics/{topic_id}/work-items", {
        "items": [{"title": "回合用尽保留进展继续", "details": "COUNCIL_SEGMENT_E2E TURN_LIMIT"}],
    })[0]
    api_request("POST", f"/api/v1/topics/{topic_id}/work-items/{turn_item['id']}/delegations", {
        "expectedVersion": turn_item["version"], "executorAgentId": completed["executorAgentId"],
        "supervisorAgentId": completed["supervisorAgentId"], "requestedPermission": "workspace_write",
        "acceptanceCriteria": "COUNCIL_SEGMENT_E2E TURN_LIMIT", "completionPolicy": "human",
    })
    continued = wait_delegation("approved")
    assert continued["execution"]["segmentsUsed"] == 2 and continued.get("headCommit"), continued

    # 包装后的损坏交接不能被当作完成；草稿留在原工作区，不进入提交或审核。
    malformed_item = api_request("POST", f"/api/v1/topics/{topic_id}/work-items", {
        "items": [{"title": "损坏交接必须停住", "details": "COUNCIL_SEGMENT_E2E INVALID_CHECKPOINT"}],
    })[0]
    api_request("POST", f"/api/v1/topics/{topic_id}/work-items/{malformed_item['id']}/delegations", {
        "expectedVersion": malformed_item["version"], "executorAgentId": completed["executorAgentId"],
        "supervisorAgentId": completed["supervisorAgentId"], "requestedPermission": "workspace_write",
        "acceptanceCriteria": malformed_item["details"], "completionPolicy": "human",
    })
    malformed = wait_delegation("failed")
    assert malformed["failureCode"] == "invalid_execution_checkpoint" and not malformed.get("headCommit"), malformed
    assert malformed["execution"]["phase"] == "execution", malformed

    # 背景与约束的前缀超过旧截断位置时，实施正文仍完整传到指令、执行与审核阶段。
    long_topic = api_request("POST", "/api/v1/topics", {
        "title": "长背景不能挤掉任务", "question": "背景资料 " + "b" * 11800,
        "constraints": [f"保留约束 {index}: " + "c" * 940 for index in range(9)],
        "projectPath": PROJECT_PATH,
    })
    api_request("POST", f"/api/v1/topics/{long_topic['id']}/decisions", {
        "title": "长背景下仍按完整任务实施", "decision": "保留全部任务正文和约束。",
        "rationale": "不能用背景占用预算作为遗漏任务的理由。", "alternatives": [], "status": "accepted",
    })
    long_item = api_request("POST", f"/api/v1/topics/{long_topic['id']}/work-items", {
        "items": [{"title": "完整保留当前任务", "details": "COUNCIL_SEGMENT_E2E LONG_CONTEXT\nCOUNCIL_REQUIRED_TASK_TAIL"}],
    })[0]
    api_request("POST", f"/api/v1/topics/{long_topic['id']}/work-items/{long_item['id']}/delegations", {
        "expectedVersion": long_item["version"], "executorAgentId": completed["executorAgentId"],
        "supervisorAgentId": completed["supervisorAgentId"], "requestedPermission": "workspace_write",
        "acceptanceCriteria": "COUNCIL_SEGMENT_E2E LONG_CONTEXT", "completionPolicy": "human",
    })
    long_completed = wait_delegation("approved", delegation_topic_id=long_topic["id"])
    assert long_completed["execution"]["segmentsUsed"] == 2 and long_completed.get("headCommit"), long_completed

    oversized_topic = api_request("POST", "/api/v1/topics", {
        "title": "关键要求超限须拒绝", "question": "不得截断强制约束。",
        "constraints": [f"constraint-{index}:" + "c" * 800 for index in range(26)],
        "projectPath": PROJECT_PATH,
    })
    api_request("POST", f"/api/v1/topics/{oversized_topic['id']}/decisions", {
        "title": "保留全部关键约束", "decision": "上下文不足时停止派发。",
        "rationale": "不能在缺少关键要求时执行。", "alternatives": [], "status": "accepted",
    })
    oversized_item = api_request("POST", f"/api/v1/topics/{oversized_topic['id']}/work-items", {
        "items": [{"title": "不能丢失要求", "details": "COUNCIL_SEGMENT_E2E"}],
    })[0]
    api_expect_error("POST", f"/api/v1/topics/{oversized_topic['id']}/work-items/{oversized_item['id']}/delegations", 400, {
        "expectedVersion": oversized_item["version"], "executorAgentId": completed["executorAgentId"],
        "supervisorAgentId": completed["supervisorAgentId"], "requestedPermission": "workspace_write",
        "acceptanceCriteria": "保留全部约束", "completionPolicy": "human",
    })
    assert api_request("GET", f"/api/v1/topics/{oversized_topic['id']}/work-item-delegations") == []

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
