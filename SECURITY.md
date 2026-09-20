# Security / 安全说明

## Report a vulnerability privately

Use GitHub's **Security → Report a vulnerability** entry for this repository when available. Do not put a working credential, private project content, personal data, or a detailed unpatched exploit into a public issue. If private reporting is unavailable, open an issue requesting a private contact channel without including the sensitive details.

Include the affected version or commit, the smallest reproducible case with synthetic data, and the expected versus actual behavior. Revoke or rotate any real exposed credential with its provider; removing it from a Git commit does not revoke it.

## Trust and deployment boundaries

- Council is currently a local, single-user application. Its HTTP control plane is loopback-only, without a per-instance authentication token. It is not suitable for public hosting, port forwarding, or untrusted multi-user access.
- API keys entered for remote providers are stored in macOS Keychain. SQLite stores credential references; public API responses expose whether a key is configured, not the key itself. Local CLIs retain their own authentication state.
- A local database is not an offline-model guarantee. Selected topic context and permitted file contents can be sent to the configured model provider. Review the provider, project, and permission profile before starting a call.
- Read-only discussion and explicit write delegation are distinct execution paths. A worktree protects the original checkout from ordinary edits; it does not contain a malicious process. Do not grant unrestricted execution to untrusted code or agents.
- Audit events are redacted and append-only through the application schema, but remain in a user-controlled SQLite database. They are not an external or cryptographic attestation service.
- Keep data libraries, `.env` files, credentials, logs, local settings, and private screenshots out of Git. Model output is untrusted input even when it looks like a tool instruction.

Provider API URLs in `packages/mcp-server/resources/provider-catalog.json` are editable official defaults. Runtime commands, paths, ports, and time budgets are configured through the documented local settings and environment examples. Test suites use dummy credentials and reserved example addresses.

## Checks before contributing

Before the initial public release on 2026-09-20, Gitleaks scans of reachable Git history, commit messages, and the tracked source tree reported no secrets. Manual review classified credential literals as test fixtures and API hosts as official defaults, local endpoints, or reserved examples. Included UI images contained sample data. This records the scope of that check; it is not a guarantee about future changes or files outside the repository.

Run the relevant tests and `npm run audit`. If Gitleaks is installed, scan both the tree and history before publishing changes. Do not suppress a real credential finding; remove the credential, revoke it, and assess whether it remains reachable through history, branches, tags, or attachments.

Third-party dependencies and provider brand assets retain their respective licenses and trademark rights. See the catalog for brand provenance and the generated desktop notices for bundled dependencies.

## 私密报告漏洞

优先使用仓库 **Security → Report a vulnerability** 入口。不要把可用凭据、私人项目内容、个人数据或尚未修复的完整利用细节发到公开 Issue；入口不可用时，只发布“请求私密联系渠道”的简短 Issue，不附敏感信息。

报告请包含受影响版本或提交、使用合成数据的最小复现，以及预期与实际行为。真实凭据一旦泄露，应立即在所属服务撤销或轮换；从 Git 删除不等于凭据失效。

## 信任与部署边界

- 当前产品面向本机单用户，HTTP 仅监听 loopback，尚无每实例认证令牌。不要公网部署、转发端口或供不受信任的其他用户访问。
- 远程 API Key 存在 macOS Keychain；SQLite 保存凭据引用，公开响应只说明是否已配置。各本机 CLI 自行管理登录状态。
- 本地数据存储不等于离线推理。选定的议题上下文与获授权文件内容可能发送给模型 Provider；调用前确认项目、连接和权限。
- 只读讨论与显式写入委派属于不同路径。worktree 隔离普通代码改动，不是恶意进程沙箱，不应向不可信代码或 Agent 授予无限制权限。
- 审计在应用 schema 中只追加并脱敏，但仍位于用户控制的 SQLite 中，不提供独立防篡改存证。
- 日志库、`.env`、凭据、日志、本机设置和私人截图不得提交 Git；模型输出始终按不可信输入处理。

Provider catalog 里的官方 API 地址是可修改的默认配置，不含私人上游连接。测试中的 Key、域名与地址为夹具。贡献前运行相关测试与依赖审计，并在发布前检查当前文件、分支、标签、历史和附件中的敏感内容。

2026-09-20 首次公开前，可达 Git 历史、提交消息及受跟踪源码的 Gitleaks 扫描均未检出密钥；人工复核确认凭据字面量属于测试夹具，API 主机属于官方默认地址、本地端点或保留示例地址，随仓库提供的界面图使用示例数据。该记录仅说明本次检查范围，不保证未来改动或仓库之外文件的安全性。
