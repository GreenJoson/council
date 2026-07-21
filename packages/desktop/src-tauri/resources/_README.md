# resources - 桌面 sidecar 运行资源

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `agent-service-defaults.json` | 配置正本 | 内置 Agent 服务的非敏感、安全默认参数 |
| `node-LICENSE` | 构建产物 | 从实际打包的 Node.js 发行版复制的许可证，不纳入 Git |
| `agent-service-THIRD-PARTY-NOTICES.txt` | 构建产物 | esbuild 汇总的 sidecar 第三方版权声明，不纳入 Git |

配置文件只存放非敏感默认值；日志库路径、用户项目路径和 API Key 永远不会写入本目录。
