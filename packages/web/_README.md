# web - Council Operator Console 前端

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 工程 | 锁定 React、Vite、字体、图标与测试依赖，包含已修复安全问题的 Mermaid 和 Vitest 版本 |
| `package-lock.json` | 锁定 | 固化前端依赖解析结果 |
| `index.html` | 入口 | 提供浏览器根文档和无障碍跳转入口 |
| `vite.config.ts` | 构建 | 配置 React 开发服务和生产构建 |
| `tsconfig*.json` | 类型 | 启用严格 TypeScript 和浏览器类型检查 |
| `.env.example` | 配置 | 声明 mock/http 模式、API 地址、分页与恢复参数 |
| `.env.desktop` | 配置 | 为 Tauri 构建启用 desktop 数据模式和本地 revision 轮询 |
| `src/` | 核心 | 保存应用、组件、数据边界、样式和类型 |
| `test/` | 验证 | 验证内容/编排/Model Router repository、协议映射、SSE 分流及浏览器交互 |

## 使用

```bash
npm install
npm run dev
```

默认 `VITE_COUNCIL_DATA_MODE=mock`，用于不依赖后端的视觉与交互验证。连接真实共享数据时，复制 `.env.example` 为 `.env.local`，将模式改为 `http`，通过 `VITE_COUNCIL_API_URL` 提供 Council API origin，并通过 `VITE_COUNCIL_PROJECT_PATH` 提供当前项目的绝对路径。支持 POSIX、盘符和 UNC 形式；相对路径会在启动时被拒绝。服务地址和项目路径不得写入源码。

`desktop` 模式只由 Tauri 构建使用。内容读写通过 `invoke` 直接调用 Rust 内容命令，以原生目录选择器配置日志库和项目，并用事件加低频 status 轮询发现其他 MCP 进程的写入。自动轮次则复用本地 Agent 服务（Node 编排服务，与桌面共享同一 SQLite 库文件）：服务地址由 Rust 设置层提供，桌面探测到服务可达后经 loopback HTTP/SSE 直连编排 API；服务离线时面板显示带地址的可执行指引，并按 `VITE_COUNCIL_DESKTOP_HEALTH_INTERVAL_MS` 周期重试，服务启动后自动转 LIVE。接入前提与 CORS 配置见 `packages/desktop/local-agent-service.md`。

`http` 模式通过 REST 创建议题、发帖和接受决策，并通过独立 orchestration API 创建、启动、批准、恢复和取消自动轮次。顶栏 Model Router 通过同一安全本地服务分层管理 Provider 连接、品牌和独立 Agent/Actor/`@alias`；API Key 不进入前端回读数据。普通内容写入不提交作者字段，由服务端固定 human；Agent 输出只走 orchestration。同一议题存在待启动或进行中的 Run 时不会重复新建，运行 policy 的人工恢复预算耗尽后也不会展示无效恢复操作。

`ImplementationProgress` 按 Accepted 决策展示实施计划：用户显式选择 Agent 后，
以只读调用把方案拆成结构化任务；服务端校验后按 Agent 身份写入执行账本。接受决策不会自动调用模型。
已有计划可再次让 AI 补充遗漏，也可手动追加。任务可单项或批量委派给独立执行 Agent，冻结验收条件，
默认由用户验收；持久执行证据、当前项目待处理项和已提交进度恢复见 [执行交付](../../docs/execution-delivery.md)。
完成度由 `completed / total` 自动计算，四态流转可同时记录完成证据或受阻原因；
外部 MCP 写入会沿内容 revision 自动刷新到同一视图。

内容和编排仓储各自订阅 `/api/v1/events` 的 `council.changed` 总 revision，再读取 `/api/v1/status`，分别按 `revisions.content` 与 `revisions.orchestration` 校准，互不触发对方的数据重载。EventSource 断线时保留最后快照，由浏览器负责原生重连；快速重试耗尽后以配置化低频定时器继续恢复。
