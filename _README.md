# council - 多 Agent 本地架构讨论工程

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `README.md` | 英文入口 | 说明用户痛点、交付流程、用法、架构、运行预算与当前边界 |
| `README.zh.md` | 中文入口 | 与英文版同步的产品说明、快速开始、架构与运行预算 |
| `LICENSE` | 许可 | 项目自有内容的 MIT 开源许可证 |
| `SECURITY.md` | 安全 | 双语漏洞报告、凭据管理和本地部署边界 |
| `package.json` | 工程 | 统一编排 MCP、WebUI、Rust core 与桌面应用的安装、启动、构建和验证命令 |
| `.gitignore` | 配置 | 排除依赖、构建产物、本地配置、SQLite 数据库及 WAL/SHM/journal、日志和本地备份目录 |
| `docs/` | 文档 | 保存用户指南、提示词模板和故障排查 |
| `packages/` | 运行时 | 保存可独立构建和测试的服务包 |
| `crates/` | Rust 核心 | 保存与现有 SQLite 协议兼容的桌面共享核心 |
| `scripts/` | 工程 | 保存一键开发与跨进程浏览器 E2E 编排脚本 |
| `skills/` | Agent 层 | 保存供多个 Agent 客户端发现的 Skill |
