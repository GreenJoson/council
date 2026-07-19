# web - Council Operator Console 前端

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 工程 | 锁定 React、Vite、字体、图标与测试依赖 |
| `package-lock.json` | 锁定 | 固化前端依赖解析结果 |
| `index.html` | 入口 | 提供浏览器根文档和无障碍跳转入口 |
| `vite.config.ts` | 构建 | 配置 React 开发服务和生产构建 |
| `tsconfig*.json` | 类型 | 启用严格 TypeScript 和浏览器类型检查 |
| `.env.example` | 配置 | 声明 mock/http 模式、API 地址、分页与恢复参数 |
| `.env.desktop` | 配置 | 为 Tauri 构建启用 desktop 数据模式和本地 revision 轮询 |
| `src/` | 核心 | 保存应用、组件、数据边界、样式和类型 |
| `test/` | 验证 | 验证内容/编排 repository、协议映射、SSE 分流及浏览器交互 |

## 使用

```bash
npm install
npm run dev
```

默认 `VITE_COUNCIL_DATA_MODE=mock`，用于不依赖后端的视觉与交互验证。连接真实共享数据时，复制 `.env.example` 为 `.env.local`，将模式改为 `http`，通过 `VITE_COUNCIL_API_URL` 提供 Council API origin，并通过 `VITE_COUNCIL_PROJECT_PATH` 提供当前项目的绝对路径。支持 POSIX、盘符和 UNC 形式；相对路径会在启动时被拒绝。服务地址和项目路径不得写入源码。

`desktop` 模式只由 Tauri 构建使用。它通过 `invoke` 直接调用 Rust 内容命令，以原生目录选择器配置日志库和项目，并用事件加低频 status 轮询发现其他 MCP 进程的写入；不要求本地 HTTP 服务。

`http` 模式通过 REST 创建议题、发帖和接受决策，并通过独立 orchestration API 创建、启动、批准、恢复和取消自动轮次。普通内容写入不提交作者字段，由服务端固定 human；Agent 输出只走 orchestration。Claude 可由 Web 主动调用，Codex 当前仅自动共享回帖，不从 Web 主动唤醒。同一议题存在待启动或进行中的 Run 时不会重复新建，运行 policy 的人工恢复预算耗尽后也不会展示无效恢复操作。

内容和编排仓储各自订阅 `/api/v1/events` 的 `council.changed` 总 revision，再读取 `/api/v1/status`，分别按 `revisions.content` 与 `revisions.orchestration` 校准，互不触发对方的数据重载。EventSource 断线时保留最后快照，由浏览器负责原生重连；快速重试耗尽后以配置化低频定时器继续恢复。
