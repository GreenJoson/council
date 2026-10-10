"""
@input  依赖：webui-http-smoke.py 传入的 api_request / api_expect_error，以及 e2e.mjs 注入的 COUNCIL_DATA_DIR 与四个 COUNCIL_CLIENT_CONFIG_* 隔离路径
@output 导出：verify_client_config 客户端接入验收（预置用户配置 → 写入 → 漂移 409 → 还原，Codex 保留用户追加行、Claude 精确回放）
@pos    真实 HTTP 主验收的客户端接入分段；独立成文件以控制 webui-http-smoke.py 体量

⚠️ 一旦本文件被更新，务必更新以上注释
"""

import json
import os
from pathlib import Path


def verify_client_config(api_request, api_expect_error) -> None:
    """客户端接入：四个目标路径由 e2e.mjs 指向隔离数据目录，绝不触碰真实家目录配置。"""
    data_dir = Path(os.environ["COUNCIL_DATA_DIR"])
    claude_file = Path(os.environ["COUNCIL_CLIENT_CONFIG_CLAUDE_FILE"])
    claude_skills = Path(os.environ["COUNCIL_CLIENT_CONFIG_CLAUDE_SKILLS_DIR"])
    codex_file = Path(os.environ["COUNCIL_CLIENT_CONFIG_CODEX_FILE"])
    codex_skills = Path(os.environ["COUNCIL_CLIENT_CONFIG_CODEX_SKILLS_DIR"])
    for target in (claude_file, claude_skills, codex_file, codex_skills):
        assert data_dir in target.parents, target

    def states() -> dict[str, str]:
        clients = api_request("GET", "/api/v1/settings/client-config")["clients"]
        return {item["client"]: item["state"] for item in clients}

    assert states() == {"claude": "not_applied", "codex": "not_applied"}

    # 预置用户已有配置：Claude 带另一个 MCP 服务，Codex 带模型与另一个服务
    claude_file.parent.mkdir(parents=True, exist_ok=True)
    codex_file.parent.mkdir(parents=True, exist_ok=True)
    claude_original = json.dumps({"numStartups": 3, "mcpServers": {"other": {"command": "other-mcp"}}}) + "\n"
    codex_original = 'model = "e2e-model"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n'
    claude_file.write_text(claude_original, encoding="utf-8")
    codex_file.write_text(codex_original, encoding="utf-8")

    for client in ("claude", "codex"):
        applied = api_request("POST", f"/api/v1/settings/client-config/{client}/actions/apply", {})
        assert applied["state"] == "applied" and applied.get("appliedAt"), applied

    claude_doc = json.loads(claude_file.read_text(encoding="utf-8"))
    assert claude_doc["numStartups"] == 3 and "other" in claude_doc["mcpServers"], claude_doc
    claude_entry = claude_doc["mcpServers"]["council"]
    assert claude_entry["env"]["COUNCIL_CALLER_ACTOR_ALIAS"] == "claude", claude_entry
    assert claude_entry["env"]["COUNCIL_DATA_DIR"] == str(data_dir), claude_entry
    codex_text = codex_file.read_text(encoding="utf-8")
    assert codex_text.startswith(codex_original), codex_text
    assert "# >>> council managed (do not edit) >>>" in codex_text and "[mcp_servers.council]" in codex_text, codex_text
    assert 'COUNCIL_CALLER_ACTOR_ALIAS = "codex"' in codex_text, codex_text
    assert (claude_skills / "SKILL.md").is_file() and (codex_skills / "SKILL.md").is_file()
    ledger = data_dir / "client-config"
    applied_records = json.loads((ledger / "applied.json").read_text(encoding="utf-8"))
    assert set(applied_records["clients"]) == {"claude", "codex"}, applied_records
    for client in ("claude", "codex"):
        assert any((ledger / "stash" / client).iterdir()), client

    # 用户在 Codex 文件里追加一行 → 漂移；未带 force 的写入被 409 拒绝
    with codex_file.open("a", encoding="utf-8") as handle:
        handle.write("# e2e user line\n")
    assert states() == {"claude": "applied", "codex": "drifted"}
    api_expect_error("POST", "/api/v1/settings/client-config/codex/actions/apply", 409, {})

    for client in ("codex", "claude"):
        restored = api_request("POST", f"/api/v1/settings/client-config/{client}/actions/restore", {})
        assert restored["state"] == "not_applied", restored
    assert codex_file.read_text(encoding="utf-8") == codex_original + "# e2e user line\n"
    assert claude_file.read_text(encoding="utf-8") == claude_original
    assert not claude_skills.exists() and not codex_skills.exists()
    assert states() == {"claude": "not_applied", "codex": "not_applied"}
    print("客户端接入写入/漂移/还原通过")
