# scripts - MCP 服务工程脚本

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `create-rust-test-database.mjs` | 跨语言测试 | 调用真实 Node migrator 生成 fresh/v2/v3→v5 SQLite；v3 fixture 含旧固定 Kimi Actor，供 Rust Store 验证迁移后 UUID 重绑与兼容读取 |

Rust fixture 生成器覆盖 v16；构造历史版本时先移除审计表与验收触发器，避免残留新对象伪装旧 schema。
