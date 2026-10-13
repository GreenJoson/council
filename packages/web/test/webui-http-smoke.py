"""
@input  依赖：已启动的 Council HTTP/Web、Playwright Chromium 和测试 URL 环境变量
@output 导出：项目隔离、附件内部预览、消息图片（项目内相对路径出站、API 上传去重与自动挂到消息、编辑器文件选择发布、403/404/415）、REST/SSE、模型路由、持久审计、包装交接/损坏交接、长任务上下文、人工验收边界、直接任务闭环、图像委派闭环（生图、去重入库、参考图变体、非 Codex 拒绝）与 P3 流水线闭环（自动修订且被接手的首轮出图子任务即收尾、选终稿、原型委派、失败 resume、清单损坏后 resume 且复盘只看本次入库产物、生图超时收回已写完整的图并把缺图记为 missing 由修订轮补做、原型交接暂停后 resume 接续并保留第一段改动、取消、409/400 含简报合计张数超上限）、讨论消息派活（尾块重解析、参考图入库、跳过简报确认直接生图、重复派活返回原流水线、取消后可重派且同名标题自动加序号、无尾块/越界参考图 400、消息不存在 404）及流水线界面链路（列表分组与取消徽标、已完成详情、界面新建 → 确认 brief → 并排勾选 → 选定收尾、消息派活卡点击跳到新流水线与坏方案只提示不给按钮）、P4 Worker 团队闭环（组队、Lead 注入 MCP 工具面、派发 3 个 Worker 与并行上限 409、中断 1 个、合并 2 个、Lead 收尾后全团队只审一次、被中断 Worker 不进交付）与客户端接入（委托 client_config_smoke.py：隔离目标路径上的写入 → 漂移 409 → 还原）检查
@pos    真实 HTTP + SQLite + 子进程 Agent 链路的浏览器主验收；控制台错误收集放过团队契约「GET …/team 404 = 没有团队」

⚠️ 一旦本文件被更新，务必更新以上注释
"""

import json
import os
import re
import struct
import subprocess
import time
import zlib
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from playwright.sync_api import ConsoleMessage, sync_playwright

from client_config_smoke import verify_client_config


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


def tiny_png(rgb: tuple[int, int, int]) -> bytes:
    """1×1 真 PNG：服务端按文件头嗅探并解析 IHDR，不同颜色得到不同 sha256 以区分去重用例。"""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00" + bytes(rgb))) + chunk(b"IEND", b"")


def api_upload(path: str, data: bytes, content_type: str):
    """浏览器上传入口：请求正文就是文件字节；返回 (HTTP 状态, 资产)。"""
    request = Request(f"{API_URL}{path}", data=data, headers={"Origin": WEB_ORIGIN, "Content-Type": content_type}, method="POST")
    try:
        with LOCAL_OPENER.open(request, timeout=10) as response:
            status = response.status
            envelope = json.load(response)
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise AssertionError(f"上传 {path} 失败：{error.code} {detail}") from error
    assert envelope["code"] == 0, envelope
    return status, envelope["data"]


def api_upload_expect_error(path: str, data: bytes, content_type: str, expected_status: int):
    request = Request(f"{API_URL}{path}", data=data, headers={"Origin": WEB_ORIGIN, "Content-Type": content_type}, method="POST")
    try:
        LOCAL_OPENER.open(request, timeout=10)
    except HTTPError as error:
        envelope = json.loads(error.read().decode(errors="replace"))
        assert error.code == expected_status, envelope
        return envelope
    raise AssertionError(f"上传 {path} 应返回 {expected_status}")


def wait_for_image_loaded(image) -> None:
    """消息内嵌图片是 loading=lazy，先滚进视口，再等真正解码出尺寸；失败占位会替换掉 img，所以要限时。"""
    image.scroll_into_view_if_needed()
    image.evaluate(
        """async (element) => {
          const settled = element.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
                element.addEventListener("load", resolve, { once: true });
                element.addEventListener("error", resolve, { once: true });
              });
          await Promise.race([
            settled,
            new Promise((_, reject) => setTimeout(() => reject(new Error("图片加载超时：" + element.currentSrc)), 10000)),
          ]);
          if (!(element.naturalWidth > 0)) throw new Error("图片未加载：" + element.currentSrc);
        }"""
    )


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


def stage_status(page, stage_id: str) -> str | None:
    return page.locator(f".pipeline-track [data-stage-id='{stage_id}']").get_attribute("data-stage-status")


def wait_stage(page, stage_id: str, statuses: tuple[str, ...], timeout: int = 60000) -> None:
    """等阶段轨道上某阶段进入给定状态之一；真实后端经替身 Agent 推进，比 mock 慢，默认 60 秒。"""
    page.wait_for_function(
        "([id, statuses]) => statuses.includes("
        "document.querySelector(`.pipeline-track [data-stage-id='${id}']`)?.dataset.stageStatus)",
        arg=[stage_id, list(statuses)],
        timeout=timeout,
    )


# 团队契约：GET /api/v1/tasks/:taskId/team 以 404 表示「没有团队」，任务详情每次重读都会触发；
# 浏览器把它记成资源加载失败，这是约定内的状态而非页面错误，只放过这一条路径的 404。
TEAM_NOT_FOUND_URL = re.compile(r"/api/v1/tasks/[^/]+/team$")


def collect_console_error(message: ConsoleMessage, errors: list[str]) -> None:
    if message.type != "error":
        return
    location_url = urlsplit(message.location.get("url") or "").path
    if "status of 404" in message.text and TEAM_NOT_FOUND_URL.search(location_url):
        return
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

    # 消息图片：项目内相对路径经议题只读图片接口出站；council-asset: 引用经资产接口渲染并自动挂到消息。
    api_request("POST", f"/api/v1/topics/{topic_id}/messages", {
        "kind": "note", "content": "项目内架构草图：\n\n![架构草图](docs/logo.png)",
    })
    project_image = page.locator("img.markdown-image[alt='架构草图']")
    wait_for_image_loaded(project_image)
    project_image_src = project_image.get_attribute("src") or ""
    assert f"/api/v1/topics/{topic_id}/files/image?" in project_image_src and "docs%2Flogo.png" in project_image_src, project_image_src

    upload_path = f"/api/v1/assets/upload?project={quote(PROJECT_PATH, safe='')}"
    upload_status, uploaded = api_upload(upload_path, tiny_png((200, 30, 30)), "image/png")
    assert upload_status == 201 and uploaded["kind"] == "image", (upload_status, uploaded)
    duplicate_status, duplicate = api_upload(upload_path, tiny_png((200, 30, 30)), "image/png")
    assert duplicate_status == 200 and duplicate["id"] == uploaded["id"], (duplicate_status, duplicate)
    asset_message = api_request("POST", f"/api/v1/topics/{topic_id}/messages", {
        "kind": "note", "content": f"API 上传的参考图：\n\n![上传图](council-asset:{uploaded['id']})",
    })
    asset_image = page.locator("img.markdown-image[alt='上传图']")
    wait_for_image_loaded(asset_image)
    assert f"/api/v1/assets/{uploaded['id']}/" in (asset_image.get_attribute("src") or "")
    linked = api_request("GET", f"/api/v1/assets/{uploaded['id']}")
    assert any(
        link["targetKind"] == "message" and link["targetId"] == asset_message["id"] and link["role"] == "reference"
        for link in linked["links"]
    ), linked["links"]

    # 编辑器「引用图片」：浏览器端经隐藏文件输入上传，正文插入 council-asset: 引用，发布后内嵌渲染并挂到新消息。
    page.get_by_label("选择要引用的图片").set_input_files(
        {"name": "composer-upload.png", "mimeType": "image/png", "buffer": tiny_png((30, 30, 200))}
    )
    page.wait_for_function(
        "() => /council-asset:asset_[A-Za-z0-9_-]+/.test(document.querySelector('textarea[placeholder^=\"写下公开结论\"]')?.value ?? '')"
    )
    composer_value = page.get_by_placeholder("写下公开结论、证据或回应…").input_value()
    composer_asset_id = re.search(r"council-asset:(asset_[A-Za-z0-9_-]+)", composer_value).group(1)
    assert composer_asset_id != uploaded["id"]
    page.get_by_role("button", name="Critique", exact=True).click()
    page.get_by_role("button", name="发布 Critique", exact=True).click()
    page.get_by_text("回复已发布并同步", exact=True).wait_for()
    wait_for_image_loaded(page.locator("img.markdown-image[alt='composer-upload']"))
    detail = api_request("GET", f"/api/v1/topics/{topic_id}")
    composer_message = next(message for message in detail["messages"] if composer_asset_id in message["content"])
    composer_links = api_request("GET", f"/api/v1/assets/{composer_asset_id}")["links"]
    assert any(
        link["targetKind"] == "message" and link["targetId"] == composer_message["id"] for link in composer_links
    ), composer_links

    for href, status in [("../outside.png", 403), ("docs/missing.png", 404), ("docs/design.md", 415)]:
        api_expect_error("GET", f"/api/v1/topics/{topic_id}/files/image?href={quote(href, safe='')}", status)
    api_upload_expect_error(upload_path, b"not an image", "text/plain", 415)

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
    page.get_by_role("button", name=re.compile(r"^需要我处理")).click()  # 徽标会把可访问名拼成「需要我处理 · N 个…」，只按前缀匹配
    page.get_by_role("heading", name="需要我处理", exact=True).wait_for()
    page.locator(".work-attention-view").get_by_text("等待回复或确认 1", exact=False).wait_for()
    if SCREENSHOT_PATH:
        page.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("needs-attention.png")), full_page=True)
    page.locator(".work-attention-view").get_by_role("button", name="真实同步验收", exact=False).click()
    page.get_by_role("button", name="确认并完成", exact=True).click()
    page.get_by_text("确认已提交，自动轮次继续", exact=True).wait_for()
    wait_for_run_status(claude_run["id"], "completed")
    page.get_by_role("button", name=re.compile(r"^需要我处理")).click()  # 徽标会把可访问名拼成「需要我处理 · N 个…」，只按前缀匹配
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

    # 直接任务闭环：不经议题，从浏览器新建 -> REST 委派 -> Agent 执行审核 -> 人工在任务页验收完成；
    # 全程议题数量不变，证明任务已是一等入口而不是议题的附属。
    topics_before = api_request("GET", "/api/v1/topics", None)["total"]
    page.goto(f"{WEB_URL}#/tasks", wait_until="domcontentloaded")
    page.get_by_role("button", name="新建任务", exact=True).click()
    page.get_by_label("任务标题", exact=True).fill("直接任务闭环")
    page.get_by_label("任务说明", exact=False).fill("COUNCIL_SEGMENT_E2E：直接任务两段交付")
    page.get_by_role("button", name="创建任务", exact=True).click()
    page.get_by_role("heading", name="直接任务闭环", exact=True).wait_for()
    direct_tasks = api_request("GET", f"/api/v1/tasks?project={PROJECT_PATH}&source=direct")
    direct_task = next(task for task in direct_tasks if task["title"] == "直接任务闭环")
    assert direct_task.get("topicId") is None and direct_task["kind"] == "code", direct_task
    direct_detail = api_request("GET", f"/api/v1/tasks/{direct_task['id']}")
    assert direct_detail.get("topic") is None and direct_detail["delegations"] == [], direct_detail
    api_request("POST", f"/api/v1/tasks/{direct_task['id']}/delegations", {
        "expectedVersion": direct_task["version"], "executorAgentId": completed["executorAgentId"],
        "supervisorAgentId": completed["supervisorAgentId"], "requestedPermission": "workspace_write",
        "acceptanceCriteria": "COUNCIL_SEGMENT_E2E：直接任务两段交付", "completionPolicy": "human",
        "kind": "code", "inputAssetIds": [],
    })

    def wait_task_delegation(task_id, expected, timeout=20):
        deadline = time.monotonic() + timeout
        latest = None
        while time.monotonic() < deadline:
            runs = api_request("GET", f"/api/v1/tasks/{task_id}/delegations")
            latest = runs[0] if runs else None
            if latest and latest["status"] == expected:
                return latest
            if latest and latest["status"] in {"failed", "cancelled", "approved"}:
                break
            time.sleep(0.1)
        raise AssertionError(f"任务委派没有达到 {expected}：{latest}")

    direct_done = wait_task_delegation(direct_task["id"], "approved")
    assert direct_done.get("topicId") is None and direct_done["kind"] == "code", direct_done
    assert direct_done["execution"]["segmentsUsed"] == 2 and direct_done.get("headCommit"), direct_done
    for filename in ["stage-one.txt", "stage-two.txt"]:
        assert subprocess.check_output(["git", "-C", PROJECT_PATH, "show", f"{direct_done['headCommit']}:{filename}"]).strip()
    # 人工验收在任务页完成：证据必填，保存后状态落库。
    page.goto(f"{WEB_URL}#/tasks/{direct_task['id']}", wait_until="domcontentloaded")
    page.get_by_text("Agent 审核通过，等待人工验收；请在任务状态中填写验收证据并完成。", exact=True).wait_for()
    status_form = page.locator(".task-status-form")
    status_form.get_by_label("任务状态", exact=True).select_option("completed")
    assert status_form.get_by_role("button", name="保存进度", exact=True).is_disabled()
    status_form.get_by_label("说明", exact=True).fill("已核对两段交付提交")
    status_form.get_by_role("button", name="保存进度", exact=True).click()
    page.locator(".task-status-form").get_by_role("button", name="保存进度", exact=True).wait_for()
    deadline = time.monotonic() + 10
    while True:
        finished_task = api_request("GET", f"/api/v1/tasks/{direct_task['id']}")["task"]
        if finished_task["status"] == "completed":
            break
        assert time.monotonic() < deadline, finished_task
        time.sleep(0.1)
    assert finished_task["statusNote"] == "已核对两段交付提交", finished_task
    assert api_request("GET", "/api/v1/topics", None)["total"] == topics_before
    if SCREENSHOT_PATH:
        page.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("direct-task-completed.png")), full_page=True)

    # 图像委派闭环：Codex（替身）生图 -> 三路收集按 sha256 去重入库 -> 以 output 角色挂到任务；
    # 监督者省略时取默认 Claude，completionPolicy 强制 human，工作项停在 in_progress 等人工验收。
    router_snapshot = api_request("GET", "/api/v1/settings/model-router")
    codex_provider = next(provider for provider in router_snapshot["providers"] if provider["protocol"] == "codex-cli")
    if codex_provider["status"] != "active":
        api_request("PUT", f"/api/v1/settings/providers/{codex_provider['id']}", {
            "displayName": codex_provider["displayName"], "brandAssetId": codex_provider["brandAssetId"],
            "active": True,
        })
    codex_agent = next(agent for agent in router_snapshot["agents"] if agent["providerId"] == codex_provider["id"])
    api_request("PUT", f"/api/v1/settings/agents/{codex_agent['id']}", {
        "displayName": codex_agent["displayName"], "model": codex_agent["model"],
        "mentionAlias": codex_agent["mentionAlias"], "enabled": True,
        "permissionProfile": "workspace_write", "executionRole": "executor",
    })
    image_brief = {
        "schemaVersion": 1, "kind": "custom", "goal": "图像委派闭环验收",
        "deliverables": [{"id": "hero", "description": "首页主视觉占位图", "size": "1024x1024"}],
        "acceptance": ["产物入库并挂到任务"],
    }
    image_task = api_request("POST", "/api/v1/tasks", {
        "projectPath": PROJECT_PATH, "title": "图像委派闭环", "kind": "image", "brief": image_brief,
    })
    assert image_task["kind"] == "image", image_task
    # 执行者不是 Codex 时固定拒绝，且不留下委派记录。
    rejected = api_expect_error("POST", f"/api/v1/tasks/{image_task['id']}/delegations", 400, {
        "expectedVersion": image_task["version"], "executorAgentId": completed["executorAgentId"],
        "requestedPermission": "workspace_write", "acceptanceCriteria": "产物入库", "completionPolicy": "human",
        "kind": "image", "inputAssetIds": [],
    })
    assert "生图需要本机 ChatGPT 登录的 Codex" in rejected["message"], rejected
    assert api_request("GET", f"/api/v1/tasks/{image_task['id']}/delegations") == []
    api_request("POST", f"/api/v1/tasks/{image_task['id']}/delegations", {
        "expectedVersion": image_task["version"], "executorAgentId": codex_agent["id"],
        "requestedPermission": "workspace_write", "acceptanceCriteria": "产物入库", "completionPolicy": "review",
        "kind": "image", "inputAssetIds": [],
    })
    image_done = wait_task_delegation(image_task["id"], "approved")
    assert image_done["kind"] == "image" and image_done["completionPolicy"] == "human", image_done
    assert image_done["supervisorAgentId"] == completed["executorAgentId"], image_done
    # 出图在委派根目录下的隔离空目录执行，不建 worktree、不提交，委派不带 baseCommit/headCommit。
    assert not image_done.get("headCommit") and not image_done.get("baseCommit"), image_done
    manifest_outputs = image_done["outputManifest"]["outputs"]
    assert manifest_outputs and all(not item["path"].startswith("/") for item in manifest_outputs), image_done
    image_assets = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{image_task['id']}")
    assert image_assets["total"] >= 2 and all(asset["kind"] == "image" for asset in image_assets["items"]), image_assets
    content_request = Request(
        f"{API_URL}/api/v1/assets/{image_assets['items'][0]['id']}/content", headers={"Origin": WEB_ORIGIN},
    )
    with LOCAL_OPENER.open(content_request, timeout=5) as response:
        assert response.headers.get_content_type() == "image/png", response.headers
        assert response.read(8) == b"\x89PNG\r\n\x1a\n"
    image_item = api_request("GET", f"/api/v1/tasks/{image_task['id']}")["task"]
    assert image_item["status"] == "in_progress" and "等待人工验收" in image_item["statusNote"], image_item
    # 出图不在项目里落 .council/ 投递目录，项目工作区保持干净。
    council_status = subprocess.run(
        ["git", "-C", PROJECT_PATH, "status", "--porcelain", "--", ".council"],
        check=True, capture_output=True, text=True,
    )
    assert council_status.stdout == "", council_status.stdout
    # 第二轮：先经 PUT 写入 brief，再以首轮产物作参考图委派；同内容产物按 sha256 去重仍挂到新任务。
    variant_task = api_request("POST", "/api/v1/tasks", {
        "projectPath": PROJECT_PATH, "title": "图像变体闭环", "kind": "image",
    })
    variant_task = api_request("PUT", f"/api/v1/tasks/{variant_task['id']}", {
        "status": variant_task["status"], "expectedVersion": variant_task["version"],
        "brief": {**image_brief, "goal": "基于参考图出变体"},
    })
    assert variant_task["brief"]["goal"] == "基于参考图出变体", variant_task
    reference_id = image_assets["items"][0]["id"]
    api_request("POST", f"/api/v1/tasks/{variant_task['id']}/delegations", {
        "expectedVersion": variant_task["version"], "executorAgentId": codex_agent["id"],
        "requestedPermission": "workspace_write", "acceptanceCriteria": "变体入库", "completionPolicy": "human",
        "kind": "image", "inputAssetIds": [reference_id],
    })
    variant_done = wait_task_delegation(variant_task["id"], "approved")
    assert variant_done["inputAssetIds"] == [reference_id], variant_done
    variant_assets = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{variant_task['id']}")
    assert variant_assets["total"] >= 2, variant_assets
    first_ids = {asset["id"] for asset in image_assets["items"]}
    assert {asset["id"] for asset in variant_assets["items"]} == first_ids, (variant_assets, first_ids)

    # P3 流水线闭环：brief（Claude 替身）→ 人工确认 → 生图（Codex 替身）→ 复盘首轮 revise 自动修订 → 次轮 pass
    # → 人工选终稿 → 原型代码委派；另一条 concept-sheet 首轮生图无产物失败后 resume，
    # 第二次清单损坏（草稿图已入库）再 resume，复盘只看本次入库的产物，最后取消；
    # 第三条首轮生图超时，收回已完成的图交复盘、缺的由修订轮补做。
    pipeline_started = time.monotonic()

    def wait_pipeline(pipeline_id, predicate, description, timeout=60):
        deadline = time.monotonic() + timeout
        latest = None
        while time.monotonic() < deadline:
            latest = api_request("GET", f"/api/v1/pipelines/{pipeline_id}")
            if predicate(latest):
                return latest
            time.sleep(0.1)
        raise AssertionError(f"流水线没有到达{description}：{json.dumps(latest, ensure_ascii=False)[:4000]}")

    def pipeline_stage(detail, stage_id):
        return next(stage for stage in detail["document"]["stages"] if stage["id"] == stage_id)

    def waiting_at(stage_id):
        return lambda detail: detail["document"]["currentStageId"] == stage_id \
            and pipeline_stage(detail, stage_id)["status"] == "waiting_human"

    api_expect_error("POST", "/api/v1/tasks", 400, {"projectPath": PROJECT_PATH, "title": "绕过入口", "kind": "pipeline"})
    mockup_payload = {
        "project": PROJECT_PATH, "template": "app-mockup",
        "goal": "COUNCIL_SEGMENT_E2E PIPELINE_HANDOFF_ONCE 流水线：记账 App 首页与详情页",
        "agents": {"prototype": {
            "executor": completed["executorAgentId"], "supervisor": completed["supervisorAgentId"],
        }},
    }
    mockup = api_request("POST", "/api/v1/pipelines", mockup_payload)["pipeline"]
    mockup_id = mockup["task"]["id"]
    assert mockup["task"]["kind"] == "pipeline" and mockup["task"]["source"] == "direct", mockup
    assert mockup["task"]["title"] == f"[App 原型] {mockup_payload['goal']}", mockup
    api_expect_error("POST", "/api/v1/pipelines", 409, mockup_payload)
    mockup = wait_pipeline(mockup_id, waiting_at("brief"), " brief 待确认")
    draft = mockup["document"]["draftBrief"]
    assert draft["kind"] == "app-mockup" and draft["nextStage"]["kind"] == "prototype", draft
    version = mockup["task"]["version"]
    api_expect_error("POST", f"/api/v1/pipelines/{mockup_id}/brief", 400,
                     {"brief": {**draft, "kind": "concept-sheet"}, "expectedVersion": version})
    # 交付物 count 合计超过单次生图上限（默认 16）也在确认时拒绝
    oversized = {**draft, "deliverables": [{**item, "count": 16} for item in draft["deliverables"]]}
    assert sum(item["count"] for item in oversized["deliverables"]) > 16, oversized
    api_expect_error("POST", f"/api/v1/pipelines/{mockup_id}/brief", 400,
                     {"brief": oversized, "expectedVersion": version})
    api_expect_error("POST", f"/api/v1/pipelines/{mockup_id}/brief", 409,
                     {"brief": draft, "expectedVersion": version + 1})
    api_expect_error("POST", f"/api/v1/pipelines/{mockup_id}/final", 409,
                     {"assetIds": sorted(first_ids)[:1], "expectedVersion": version})
    api_expect_error("POST", f"/api/v1/pipelines/{mockup_id}/resume", 409, {"expectedVersion": version})
    api_request("POST", f"/api/v1/pipelines/{mockup_id}/brief", {"brief": draft, "expectedVersion": version})
    mockup = wait_pipeline(mockup_id, waiting_at("select"), "选定终稿")
    document = mockup["document"]
    assert [review["verdict"] for review in document["reviews"]] == ["revise", "pass"], document
    assert document["revisionCount"] == 1, document
    image_children = [child for child in mockup["children"] if child["kind"] == "image"]
    assert len(image_children) == 2, mockup["children"]
    assert all(child["source"] == "pipeline" and child["parentId"] == mockup_id for child in image_children), image_children
    # 修订轮派出后，被接手的首轮出图子任务即收尾（否则父任务一直派生为进行中）；修订轮仍等选定终稿。
    first_round = next(child for child in image_children if child["title"] == "生图 第1轮")
    revision_round = next(child for child in image_children if child["title"] == "生图修订 第1轮")
    assert first_round["status"] == "completed" and "生图修订 第1轮" in first_round["statusNote"], first_round
    assert revision_round["status"] == "in_progress", revision_round
    assert mockup["outputAssetIds"], mockup
    listed = api_request("GET", f"/api/v1/pipelines?project={quote(PROJECT_PATH)}")["items"]
    assert any(item["id"] == mockup_id and item["currentStageId"] == "select" for item in listed), listed
    version = mockup["task"]["version"]
    api_expect_error("POST", f"/api/v1/pipelines/{mockup_id}/final", 400,
                     {"assetIds": ["asset_00000000-0000-0000-0000-000000000000"], "expectedVersion": version})
    final_ids = mockup["outputAssetIds"][:1]
    mockup = api_request("POST", f"/api/v1/pipelines/{mockup_id}/final", {"assetIds": final_ids, "expectedVersion": version})
    assert mockup["document"]["finalAssetIds"] == final_ids, mockup["document"]
    parent_assets = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{mockup_id}")
    assert any(
        asset["id"] == final_ids[0] and any(link["role"] == "final" and link["targetId"] == mockup_id for link in asset["links"])
        for asset in parent_assets["items"]
    ), parent_assets
    for child in mockup["children"]:
        if child["kind"] == "image":
            note = "已在流水线中选定终稿" if child["id"] == revision_round["id"] else first_round["statusNote"]
            assert child["status"] == "completed" and child["statusNote"] == note, child
    prototype_child = next(child for child in mockup["children"] if child["kind"] == "prototype")
    # 原型第一段以 canContinue:false 交接（沙箱不许起服务验证）→ 委派 execution_checkpoint、阶段 failed 带接续提示；
    # 流水线「恢复」接续上一次委派而不是重做：新委派带 resumedFromId、沿用输入图，第一段的文件保留进最终提交。
    prototype_paused = wait_task_delegation(prototype_child["id"], "failed", timeout=30)
    assert prototype_paused["failureCode"] == "execution_checkpoint" and not prototype_paused.get("headCommit"), prototype_paused
    mockup = wait_pipeline(mockup_id, lambda detail: pipeline_stage(detail, "prototype")["status"] == "failed", "原型交接暂停")
    prototype_error = pipeline_stage(mockup, "prototype")["error"]
    assert prototype_error["code"] == "execution_checkpoint" and "接续" in prototype_error["message"], prototype_error
    mockup = api_request("POST", f"/api/v1/pipelines/{mockup_id}/resume", {"expectedVersion": mockup["task"]["version"]})
    assert pipeline_stage(mockup, "prototype")["status"] == "running", mockup["document"]
    prototype_done = wait_task_delegation(prototype_child["id"], "approved", timeout=30)
    assert prototype_done["id"] != prototype_paused["id"], prototype_done
    assert prototype_done["resumedFromId"] == prototype_paused["id"], prototype_done
    assert prototype_done["kind"] == "code" and prototype_done["inputAssetIds"] == final_ids, prototype_done
    assert prototype_done["completionPolicy"] == "human", prototype_done
    for filename in ["stage-one.txt", "stage-two.txt"]:
        assert subprocess.check_output(["git", "-C", PROJECT_PATH, "show", f"{prototype_done['headCommit']}:{filename}"]).strip()
    mockup = wait_pipeline(mockup_id, lambda detail: pipeline_stage(detail, "prototype")["status"] == "completed", "原型完成")
    prototype_task = next(child for child in mockup["children"] if child["id"] == prototype_child["id"])
    assert prototype_task["status"] == "in_progress", prototype_task
    api_expect_error("POST", f"/api/v1/pipelines/{mockup_id}/cancel", 409, {"expectedVersion": mockup["task"]["version"]})

    concept = api_request("POST", "/api/v1/pipelines", {
        "project": PROJECT_PATH, "template": "concept-sheet",
        "goal": "COUNCIL_PIPELINE_NO_OUTPUTS_ONCE COUNCIL_PIPELINE_BAD_MANIFEST_ONCE 概念设定：森林守卫",
    })["pipeline"]
    concept_id = concept["task"]["id"]
    concept = wait_pipeline(concept_id, waiting_at("brief"), " brief 待确认")
    api_request("POST", f"/api/v1/pipelines/{concept_id}/brief", {
        "brief": concept["document"]["draftBrief"], "expectedVersion": concept["task"]["version"],
    })
    concept = wait_pipeline(concept_id, lambda detail: pipeline_stage(detail, "image")["status"] == "failed", "生图失败")
    assert pipeline_stage(concept, "image")["error"]["code"] == "outputs_missing", concept["document"]
    failed_child = pipeline_stage(concept, "image")["workItemId"]
    concept = api_request("POST", f"/api/v1/pipelines/{concept_id}/resume", {"expectedVersion": concept["task"]["version"]})
    # 第二次重跑：替身写了一张草稿图但清单损坏 → manifest_invalid；草稿图已入库，以 output 挂在同一子任务上。
    concept = wait_pipeline(
        concept_id,
        lambda detail: pipeline_stage(detail, "image")["status"] == "failed"
        and pipeline_stage(detail, "image")["error"]["code"] == "manifest_invalid",
        "清单损坏失败",
    )
    assert pipeline_stage(concept, "image")["workItemId"] == failed_child, concept["document"]
    draft_assets = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{failed_child}")
    assert draft_assets["total"] == 1, draft_assets
    draft_asset_id = draft_assets["items"][0]["id"]
    concept = api_request("POST", f"/api/v1/pipelines/{concept_id}/resume", {"expectedVersion": concept["task"]["version"]})
    concept = wait_pipeline(concept_id, waiting_at("select"), "选定终稿")
    concept_images = [child for child in concept["children"] if child["kind"] == "image"]
    # resume 只对原子任务重新委派，不新建子任务；同一子任务的产物不因重跑翻倍（草稿 1 张 + 本次 2 张）。
    assert len(concept_images) == 2 and concept_images[0]["id"] == failed_child, concept["children"]
    rerun_assets = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{failed_child}")
    assert rerun_assets["total"] == 3, rerun_assets
    # 复盘只看本次委派入库的产物：失败尝试留下的草稿图不进复盘，也不会被当成修订对象。
    reviewed_asset_ids = {item["assetId"] for review in concept["document"]["reviews"] for item in review["items"]}
    assert reviewed_asset_ids and draft_asset_id not in reviewed_asset_ids, concept["document"]["reviews"]
    assert all(item["deliverableId"] == "main-screen" for item in concept["document"]["reviews"][0]["items"]), concept["document"]["reviews"]
    # 选定阶段仍能从子任务全部 output 资产里挑，草稿图也在并排对比之列。
    assert len(concept["outputAssetIds"]) == len(set(concept["outputAssetIds"])) == 3, concept
    assert draft_asset_id in concept["outputAssetIds"], concept
    concept = api_request("POST", f"/api/v1/pipelines/{concept_id}/cancel", {"expectedVersion": concept["task"]["version"]})
    assert concept["document"]["status"] == "cancelled", concept["document"]
    select_stage = pipeline_stage(concept, "select")
    assert select_stage["status"] == "skipped" and select_stage["error"]["code"] == "cancelled", select_stage
    cancelled_version = concept["task"]["version"]
    api_expect_error("POST", f"/api/v1/pipelines/{concept_id}/final", 409,
                     {"assetIds": concept["outputAssetIds"][:1], "expectedVersion": cancelled_version})
    api_expect_error("POST", f"/api/v1/pipelines/{concept_id}/resume", 409, {"expectedVersion": cancelled_version})

    # 生图整轮超时不作废已画好的图：替身写好 main-screen、detail-screen 只写一半（缺 IEND）就挂起，到生图超时被终止。
    # 写完整的那张照常入库交复盘，写一半的不收；复盘把没出图的 detail-screen 记为 missing 判返工，修订轮补齐后通过。
    salvage = api_request("POST", "/api/v1/pipelines", {
        "project": PROJECT_PATH, "template": "concept-sheet",
        "goal": "COUNCIL_PIPELINE_IMAGE_TIMEOUT_ONCE 概念设定：超时收回",
    })["pipeline"]
    salvage_id = salvage["task"]["id"]
    salvage = wait_pipeline(salvage_id, waiting_at("brief"), " brief 待确认")
    api_request("POST", f"/api/v1/pipelines/{salvage_id}/brief", {
        "brief": salvage["document"]["draftBrief"], "expectedVersion": salvage["task"]["version"],
    })
    salvage = wait_pipeline(salvage_id, waiting_at("select"), "超时收回后选定终稿", timeout=120)
    salvage_reviews = salvage["document"]["reviews"]
    assert [review["verdict"] for review in salvage_reviews] == ["revise", "pass"], salvage_reviews
    assert salvage_reviews[0].get("missing") == ["detail-screen"], salvage_reviews[0]
    assert {item["deliverableId"] for item in salvage_reviews[0]["items"]} == {"main-screen"}, salvage_reviews[0]
    timeout_round = next(child for child in salvage["children"] if child["title"] == "生图 第1轮")
    salvaged = wait_task_delegation(timeout_round["id"], "approved", timeout=5)
    assert "超时" in salvaged["summary"] and "detail-screen" in salvaged["summary"], salvaged
    assert [output["deliverableId"] for output in salvaged["outputManifest"]["outputs"]] == ["main-screen"], salvaged
    salvaged_assets = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{timeout_round['id']}")
    assert salvaged_assets["total"] == 1, salvaged_assets
    salvage = api_request("POST", f"/api/v1/pipelines/{salvage_id}/cancel", {"expectedVersion": salvage["task"]["version"]})
    assert salvage["document"]["status"] == "cancelled", salvage["document"]

    # 上游请求挂住：替身首次一张不写、只输出 thread.started 后静默挂起，到事件流静默上限被判定卡住。
    # 输出目录为空就原地自动重试一次，第二次正常出图：生图阶段不失败、无需人工恢复，首轮两项交付物齐全交复盘。
    stall = api_request("POST", "/api/v1/pipelines", {
        "project": PROJECT_PATH, "template": "concept-sheet",
        "goal": "COUNCIL_PIPELINE_IMAGE_STALL_ONCE 概念设定：卡住重试",
    })["pipeline"]
    stall_id = stall["task"]["id"]
    stall = wait_pipeline(stall_id, waiting_at("brief"), " brief 待确认")
    api_request("POST", f"/api/v1/pipelines/{stall_id}/brief", {
        "brief": stall["document"]["draftBrief"], "expectedVersion": stall["task"]["version"],
    })
    stall = wait_pipeline(
        stall_id,
        lambda detail: waiting_at("select")(detail) or pipeline_stage(detail, "image")["status"] == "failed",
        "卡住重试后选定终稿",
        timeout=120,
    )
    assert pipeline_stage(stall, "image")["status"] != "failed", stall["document"]
    stall_reviews = stall["document"]["reviews"]
    assert not stall_reviews[0].get("missing"), stall_reviews[0]
    stall_round = next(child for child in stall["children"] if child["title"] == "生图 第1轮")
    retried = wait_task_delegation(stall_round["id"], "approved", timeout=5)
    assert retried["attempt"] == 1 and "卡住" not in retried.get("summary", ""), retried
    assert [output["deliverableId"] for output in retried["outputManifest"]["outputs"]] == ["main-screen", "detail-screen"], retried
    stall = api_request("POST", f"/api/v1/pipelines/{stall_id}/cancel", {"expectedVersion": stall["task"]["version"]})
    assert stall["document"]["status"] == "cancelled", stall["document"]

    # 讨论消息一键派活：消息带 council-dispatch 尾块（模板 + 项目内参考图 + 完整简报），服务端从已存消息重解析，
    # 参考图导入资产库后跳过简报确认直接生图；同一条消息重复派活返回原流水线，取消后可重新派；
    # 没有尾块 / 参考图越出项目 400，消息不存在 404。界面点击链路在流水线界面验收之后。
    def post_dispatch_message(goal, references=("docs/logo.png",)):
        plan = {
            "template": "concept-sheet", "references": list(references),
            "brief": {
                "schemaVersion": 1, "kind": "concept-sheet", "goal": goal,
                "deliverables": [
                    {"id": "guard-front", "description": "森林守卫正面立绘", "size": "1024x1536", "count": 1},
                    {"id": "guard-back", "description": "森林守卫背面立绘", "size": "1024x1536", "count": 1},
                ],
                "acceptance": ["正背面服装与配色一致"],
            },
        }
        return api_request("POST", f"/api/v1/topics/{topic_id}/messages", {
            "kind": "note",
            "content": f"按讨论结论派活。\n\n```council-dispatch\n{json.dumps(plan, ensure_ascii=False)}\n```",
        })

    dispatch_message = post_dispatch_message("派活：森林守卫正背面")
    dispatch_body = {"topicId": topic_id, "messageId": dispatch_message["id"]}
    dispatched = api_request("POST", "/api/v1/pipelines/dispatch", dispatch_body)
    assert dispatched["created"] is True, dispatched
    dispatch_id = dispatched["pipeline"]["task"]["id"]
    dispatch_doc = dispatched["pipeline"]["document"]
    assert dispatch_doc["request"]["source"] == {"topicId": topic_id, "messageId": dispatch_message["id"]}, dispatch_doc
    assert pipeline_stage(dispatched["pipeline"], "brief")["status"] == "completed", dispatch_doc
    assert pipeline_stage(dispatched["pipeline"], "image")["status"] == "running", dispatch_doc
    assert [item["id"] for item in dispatch_doc["brief"]["deliverables"]] == ["guard-front", "guard-back"], dispatch_doc
    dispatch_refs = dispatch_doc["request"]["referenceAssetIds"]
    assert len(dispatch_refs) == 1 and dispatch_doc["brief"]["style"]["references"] == dispatch_refs, dispatch_doc
    assert api_request("GET", f"/api/v1/assets/{dispatch_refs[0]}")["kind"] == "image"
    again = api_request("POST", "/api/v1/pipelines/dispatch", dispatch_body)
    assert again["created"] is False and again["pipeline"]["task"]["id"] == dispatch_id, again["pipeline"]["task"]
    api_expect_error("POST", "/api/v1/pipelines/dispatch", 400, {"topicId": topic_id, "messageId": asset_message["id"]})
    api_expect_error("POST", "/api/v1/pipelines/dispatch", 404, {"topicId": topic_id, "messageId": "message_missing-dispatch"})
    outside = post_dispatch_message("派活：越界参考图", references=("../outside.png",))
    api_expect_error("POST", "/api/v1/pipelines/dispatch", 400, {"topicId": topic_id, "messageId": outside["id"]})
    dispatch_detail = wait_pipeline(dispatch_id, waiting_at("select"), "派活后选定终稿", timeout=120)
    assert [review["verdict"] for review in dispatch_detail["document"]["reviews"]] == ["revise", "pass"], dispatch_detail["document"]
    first_round = next(child for child in dispatch_detail["children"] if child["title"] == "生图 第1轮")
    assert "参考图 1 张" in wait_task_delegation(first_round["id"], "approved", timeout=5)["summary"]
    cancelled_dispatch = api_request("POST", f"/api/v1/pipelines/{dispatch_id}/cancel", {
        "expectedVersion": dispatch_detail["task"]["version"],
    })
    assert cancelled_dispatch["document"]["status"] == "cancelled", cancelled_dispatch["document"]
    redispatched = api_request("POST", "/api/v1/pipelines/dispatch", dispatch_body)
    assert redispatched["created"] is True and redispatched["pipeline"]["task"]["id"] != dispatch_id, redispatched["pipeline"]["task"]
    redispatch_id = redispatched["pipeline"]["task"]["id"]
    # 顶层任务标题项目内唯一且不分状态：重派的同名目标自动加序号，不撞 409。
    assert redispatched["pipeline"]["task"]["title"] == f'{dispatched["pipeline"]["task"]["title"]}（2）', redispatched["pipeline"]["task"]
    # 删除：阶段在跑时 409 要求先取消（版本被驱动抢先推进时按最新版本重试）；已取消的整棵子树物理删除，
    # 详情 404、实施项链接随之清掉，图片仍留在资产库。
    for _ in range(5):
        running_detail = api_request("GET", f"/api/v1/pipelines/{redispatch_id}")
        assert pipeline_stage(running_detail, "image")["status"] == "running", running_detail["document"]
        refused = api_expect_error("DELETE", f"/api/v1/pipelines/{redispatch_id}?expectedVersion={running_detail['task']['version']}", 409)
        if refused["message"] != "流水线已被更新，请刷新后重试。":
            break
    assert refused["message"] == "流水线还在运行，请先取消再删除。", refused
    first_round_assets = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{first_round['id']}")
    assert first_round_assets["total"] >= 1, first_round_assets
    api_request("DELETE", f"/api/v1/pipelines/{dispatch_id}?expectedVersion={cancelled_dispatch['task']['version']}")
    api_expect_error("GET", f"/api/v1/pipelines/{dispatch_id}", 404)
    for asset in first_round_assets["items"]:
        assert api_request("GET", f"/api/v1/assets/{asset['id']}").get("deletedAt") is None, asset
    orphan_links = api_request("GET", f"/api/v1/assets?project={quote(PROJECT_PATH)}&target=work_item:{first_round['id']}")
    assert orphan_links["total"] == 0, orphan_links
    redispatched = wait_pipeline(redispatch_id, lambda detail: pipeline_stage(detail, "image")["status"] != "running", "重新派活后出图结束", timeout=120)
    api_request("POST", f"/api/v1/pipelines/{redispatch_id}/cancel", {"expectedVersion": redispatched["task"]["version"]})
    print(f"P3 流水线闭环通过，耗时 {time.monotonic() - pipeline_started:.1f}s")

    # P3 流水线界面（http 模式，真实后端 + 替身 Agent）：列表分组与取消徽标 → 已完成详情 →
    # 界面新建 concept-sheet → 确认 brief → 自动修订后并排勾选 → 选定收尾（无原型阶段，父任务直接完成）
    ui_started = time.monotonic()
    page.goto(f"{WEB_URL}#/pipelines", wait_until="domcontentloaded")
    page.get_by_role("heading", name="流水线", exact=True).wait_for()
    page.locator(f"[data-pipeline-group='done'] [data-pipeline-id='{mockup_id}']").wait_for()
    cancelled_row = page.locator(f"[data-pipeline-group='done'] [data-pipeline-id='{concept_id}']")
    cancelled_row.wait_for()
    assert "已取消" in cancelled_row.locator(".pipeline-stage-badge").inner_text()
    page.locator(f"[data-pipeline-id='{mockup_id}']").click()
    page.locator(f"[data-pipeline-detail='{mockup_id}']").wait_for()
    for stage_id in ("brief", "image", "review", "select", "prototype"):
        wait_stage(page, stage_id, ("completed",))
    assert page.locator("[data-pipeline-final] code").count() == len(final_ids)

    page.get_by_role("link", name="返回流水线列表").click()
    page.get_by_role("button", name="新建流水线", exact=True).click()
    dialog = page.locator("dialog.pipeline-create-dialog")
    dialog.get_by_role("radio", name="概念设定图").check()
    dialog.get_by_role("textbox", name="目标").fill("界面新建：概念设定图冒烟")
    dialog.get_by_role("button", name="创建流水线", exact=True).click()
    page.wait_for_function("location.hash.startsWith('#/pipelines/')")
    ui_pipeline_id = page.locator("[data-pipeline-detail]").get_attribute("data-pipeline-detail")
    assert ui_pipeline_id and ui_pipeline_id not in (mockup_id, concept_id), ui_pipeline_id
    wait_stage(page, "brief", ("waiting_human",))
    brief_control = page.locator("[data-pipeline-control='brief']")
    brief_control.locator(".brief-editor").wait_for()
    brief_control.get_by_role("button", name="确认简报", exact=True).click()
    wait_stage(page, "brief", ("completed",))
    wait_stage(page, "select", ("waiting_human",))
    assert stage_status(page, "image") == "completed" and stage_status(page, "review") == "completed"
    compare = page.locator(".pipeline-compare")
    compare.wait_for()
    final_boxes = compare.get_by_role("checkbox", name="选为最终稿")
    assert final_boxes.count() >= 1
    final_boxes.nth(0).check()
    page.get_by_role("button", name="选定", exact=True).click()
    wait_stage(page, "select", ("completed",))
    page.locator("[data-pipeline-final] code").first.wait_for()
    ui_detail = api_request("GET", f"/api/v1/pipelines/{ui_pipeline_id}")
    assert ui_detail["task"]["status"] == "completed" and ui_detail["document"]["template"] == "concept-sheet", ui_detail["task"]
    assert len(ui_detail["document"]["reviews"]) == 2 and ui_detail["document"]["revisionCount"] == 1, ui_detail["document"]
    assert len(ui_detail["document"]["finalAssetIds"]) == 1, ui_detail["document"]
    page.goto(f"{WEB_URL}#/pipelines", wait_until="domcontentloaded")
    page.locator(f"[data-pipeline-group='done'] [data-pipeline-id='{ui_pipeline_id}']").wait_for()
    print(f"P3 流水线界面通过，耗时 {time.monotonic() - ui_started:.1f}s")

    # 讨论消息派活卡：尾块不再露出原始 JSON，改为方案卡（模板、交付物、参考图数）；点「按此起流水线」跳到新流水线，
    # 已直接开始生图；方案解析不了时只给问题提示、不给按钮。
    page.goto(f"{WEB_URL}#/discussion/{topic_id}", wait_until="domcontentloaded")
    page.get_by_role("heading", name="真实同步验收", exact=True).wait_for()
    ui_dispatch_message = post_dispatch_message("界面派活：森林守卫")
    api_request("POST", f"/api/v1/topics/{topic_id}/messages", {
        "kind": "note", "content": "坏方案：\n\n```council-dispatch\n{not json}\n```",
    })
    dispatch_card = page.locator(f"[data-message-id='{ui_dispatch_message['id']}'] .pipeline-dispatch-card")
    dispatch_card.wait_for()
    card_text = dispatch_card.inner_text()
    assert "概念设定图" in card_text and "2 项交付物，共 2 张" in card_text and "参考图 1 张" in card_text, card_text
    assert "guard-front" in card_text and "council-dispatch" not in page.locator(f"[data-message-id='{ui_dispatch_message['id']}']").inner_text()
    invalid_card = page.locator(".pipeline-dispatch-card.is-invalid").last
    invalid_card.get_by_text("派活方案不是合法 JSON，请让 Agent 重新给出。").wait_for()
    assert invalid_card.get_by_role("button").count() == 0
    dispatch_card.get_by_role("button", name="按此起流水线", exact=True).click()
    page.wait_for_function("location.hash.startsWith('#/pipelines/')")
    ui_dispatch_id = page.locator("[data-pipeline-detail]").get_attribute("data-pipeline-detail")
    ui_dispatch = api_request("GET", f"/api/v1/pipelines/{ui_dispatch_id}")
    assert ui_dispatch["document"]["request"]["source"]["messageId"] == ui_dispatch_message["id"], ui_dispatch["document"]
    wait_stage(page, "brief", ("completed",))
    # 阶段在跑时不给删除，只给取消；取消后只剩「删除流水线」，两步确认后回到列表，该行消失。
    assert page.get_by_role("button", name="删除流水线", exact=True).count() == 0
    ui_dispatch = wait_pipeline(ui_dispatch_id, lambda detail: pipeline_stage(detail, "image")["status"] != "running", "界面派活出图结束", timeout=120)
    api_request("POST", f"/api/v1/pipelines/{ui_dispatch_id}/cancel", {"expectedVersion": ui_dispatch["task"]["version"]})
    page.get_by_role("button", name="删除流水线", exact=True).click()
    page.get_by_text("删除后流水线与子任务记录不可恢复，生成的图片仍留在资产库。确定吗？").wait_for()
    page.get_by_role("button", name="确认删除", exact=True).click()
    page.wait_for_function("location.hash === '#/pipelines'")
    page.get_by_role("heading", name="流水线", exact=True).wait_for()
    assert page.locator(f"[data-pipeline-id='{ui_dispatch_id}']").count() == 0
    api_expect_error("GET", f"/api/v1/pipelines/{ui_dispatch_id}", 404)
    print("讨论消息派活卡界面通过")
    page.goto(f"{WEB_URL}#/discussion/{topic_id}", wait_until="domcontentloaded")

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

    # P4 Worker 团队闭环（真实 HTTP + Git + 子进程替身）：组队 → Lead（替身）真实拉起注入的 council MCP 核对工具面 →
    # 派发 3 个 Worker（第 4 个超并行上限 409）→ 中断 1 个 → 另 2 个 done → 逐个合并 → Lead 收尾 → 全团队只审一次。
    team_started = time.monotonic()
    team_item = api_request("POST", f"/api/v1/topics/{topic_id}/work-items", {
        "items": [{"title": "Worker 团队闭环", "details": "COUNCIL_TEAM_E2E 团队并行交付"}],
    })[0]
    team_base = f"/api/v1/tasks/{team_item['id']}/team"
    api_expect_error("GET", team_base, 404)
    team_payload = {
        "expectedVersion": team_item["version"], "executorAgentId": completed["executorAgentId"],
        "supervisorAgentId": completed["supervisorAgentId"], "requestedPermission": "workspace_write",
        "acceptanceCriteria": "COUNCIL_TEAM_E2E 团队并行交付", "completionPolicy": "human",
    }
    started_team = api_request("POST", team_base, team_payload)
    lead_id = started_team["leadDelegation"]["id"]
    assert started_team["team"]["leadDelegationId"] == lead_id and started_team["team"]["status"] == "active", started_team
    api_expect_error("POST", team_base, 409, team_payload)

    def dispatch_worker(label, brief):
        # Lead 工作区在执行阶段前才建好；之前派发返回 409「尚未就绪」，短暂重试。
        deadline = time.monotonic() + 15
        while True:
            try:
                return api_request("POST", f"{team_base}/workers", {"label": label, "brief": brief, "scopePaths": [label]})
            except AssertionError as error:
                if "尚未就绪" not in str(error) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)

    worker_a = dispatch_worker("team-a", "COUNCIL_TEAM_E2E dir=team-a delay=2500")
    worker_b = dispatch_worker("team-b", "COUNCIL_TEAM_E2E dir=team-b delay=2500")
    worker_slow = dispatch_worker("team-slow", "COUNCIL_TEAM_E2E dir=team-slow delay=4000")
    assert all(worker["id"].startswith("worker-") and worker["branchName"] for worker in (worker_a, worker_b, worker_slow))
    over_limit = api_expect_error("POST", f"{team_base}/workers", 409, {"label": "team-extra", "brief": "COUNCIL_TEAM_E2E dir=x delay=0"})
    assert "上限" in over_limit["message"], over_limit
    interrupted = api_request("POST", f"{team_base}/workers/{worker_slow['id']}/actions/interrupt")
    assert interrupted["status"] == "error", interrupted
    done_workers = []
    for worker in (worker_a, worker_b):
        settled = api_request("GET", f"{team_base}/workers/{worker['id']}/wait?timeoutMs=20000", timeout=25)
        assert settled["status"] == "done" and settled["delegation"]["headCommit"], settled
        done_workers.append(settled)
    api_expect_error("POST", f"{team_base}/workers/{worker_slow['id']}/actions/merge", 409)
    for worker in done_workers:
        try:
            merged = api_request("POST", f"{team_base}/workers/{worker['id']}/actions/merge")
        except AssertionError as error:
            # 合并失败时带上团队视图（含 Lead failureCode），便于定位 Lead 为何提前结束。
            raise AssertionError(f"{error}; team={api_request('GET', team_base)}") from error
        assert merged["mergedCommit"], merged

    deadline = time.monotonic() + 40
    while True:
        team_view = api_request("GET", team_base)
        lead_status = team_view["delegation"]["status"]
        if lead_status in {"approved", "failed", "cancelled"}:
            break
        assert time.monotonic() < deadline, team_view
        time.sleep(0.2)
    assert lead_status == "approved", team_view
    lead_head = team_view["delegation"]["headCommit"]
    assert team_view["status"] == "ended" and team_view.get("endedAt"), team_view
    workers_by_id = {worker["id"]: worker for worker in team_view["workers"]}
    slow_view = workers_by_id[worker_slow["id"]]
    assert slow_view["status"] == "error" and not slow_view.get("mergedCommit"), slow_view
    assert slow_view["delegation"]["status"] == "cancelled", slow_view
    for worker in done_workers:
        view = workers_by_id[worker["id"]]
        assert view["status"] == "done" and view["mergedCommit"], view
        # Lead 交付分支同时包含 Worker 自己的提交与合并提交。
        for commit in (view["delegation"]["headCommit"], view["mergedCommit"]):
            subprocess.run(["git", "-C", PROJECT_PATH, "merge-base", "--is-ancestor", commit, lead_head], check=True)
    for filename in ["team-lead.txt", "team-a/worker.txt", "team-b/worker.txt"]:
        assert subprocess.check_output(["git", "-C", PROJECT_PATH, "show", f"{lead_head}:{filename}"]).strip()
    slow_listing = subprocess.run(["git", "-C", PROJECT_PATH, "show", f"{lead_head}:team-slow/worker.txt"], capture_output=True)
    assert slow_listing.returncode != 0, "被中断的 Worker 不应进入 Lead 交付"

    def audit_kinds(source_id):
        events = api_request("GET", f"/api/v1/topics/{topic_id}/runtime-audit?sourceKind=delegation&sourceId={source_id}")
        return [event["kind"] for event in events["events"]]

    # 全团队只审一次：Lead 一次审核材料，Worker 一次都没有。
    assert audit_kinds(lead_id).count("review.evidence") == 1, audit_kinds(lead_id)
    for worker in team_view["workers"]:
        assert "review.evidence" not in audit_kinds(worker["delegationId"]), worker
    # Worker 不进委派列表：任务委派只有 Lead 一条。
    assert [run["id"] for run in api_request("GET", f"/api/v1/tasks/{team_item['id']}/delegations")] == [lead_id]
    print(f"P4 Worker 团队闭环通过，耗时 {time.monotonic() - team_started:.1f}s")
    verify_client_config(api_request, api_expect_error)

    assert not console_errors, console_errors
    page.close()
    browser.close()

print("Council HTTP/SSE/Claude 自动轮次端到端验收通过")
