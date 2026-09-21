# resources - 桌面 sidecar 运行资源

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `agent-service-defaults.json` | 配置正本 | 内置 Agent 服务的非敏感默认参数；独立配置 CLI 累计事件流与最终回复预算，以及迁移、ready、ACP 和 ToolLoop 边界 |
| `node-LICENSE` | 构建产物 | 从实际打包的 Node.js 发行版复制的许可证，不纳入 Git |
| `agent-service-THIRD-PARTY-NOTICES.txt` | 构建产物 | esbuild 汇总的 sidecar 第三方版权声明，不纳入 Git |

配置文件只存放非敏感默认值；日志库路径、用户项目路径和 API Key 永远不会写入本目录。

Claude 讨论/指令、实施、审核分别提供 24/120/48 回合默认值，可用对应环境配置覆盖。
