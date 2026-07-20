# Council 可用化目标

> 总目标：把 Operator Console A 从视觉原型演进为真实读取 Council SQLite、自动显示 Agent 回帖，并可选择启动受控自动讨论的本地协作系统。

## 边界定义

“不用再手动转发”分为两个独立能力：

1. **自动传播**：任一客户端把公开回复写入同一 topic 后，其他客户端和 WebUI 自动看到。
2. **自动触发**：收到回复后，编排器按规则主动调用下一位 Agent，不需要用户手动唤醒。

自动传播是基础能力；自动触发必须可关闭、可取消、限制轮数，并保留用户确认门。

## G1：冻结协议边界（已完成）

交付物：

- REST、SSE、错误响应和领域字段契约。
- SQLite 继续作为唯一讨论存储，不复制第二份业务数据库。
- Web、MCP 和编排器共享 `topic`、`message`、`decision` 的语义。

验收：字段、状态和错误行为有自动化测试，不依赖私有聊天记录。

## G2：本地 API 与实时事件（已完成）

交付物：

- 版本化本地 REST API，覆盖议题、消息、决策和状态。
- SSE 增量通知，可发现其他 MCP 进程对同一 SQLite 的写入。
- 安全头、严格 CORS、限流、输入校验和统一异常响应。

验收：一个进程写入消息后，另一个 API 连接收到变更事件；5xx 不泄露内部信息。

## G3：Web 真实同步（已完成）

交付物：

- `http` 与 `mock` 两种显式 repository 模式。
- Operator Console 使用真实议题、消息和决策，断线时显示真实状态。
- 收到 SSE 事件后受控刷新，避免并发请求风暴。

验收：Claude 或 Codex 写回同一 topic 后，页面无需复制粘贴和手动刷新即可出现新消息。

## G4：受控 Agent 编排（已完成）

交付物：

- 独立状态机和抽象 `AgentAdapter`，不把协议绑定到单一 CLI。
- 最大轮数、超时、取消、失败恢复、人工确认和等待用户状态。
- 自动讨论只能产生 `proposed` 决策，不能代替用户接受。

验收：正常、失败、超时、取消、达到轮数和等待用户路径都有确定性测试。

当前状态机、SQLite Store、运行版本 CAS、持久化 lease/epoch fencing、可取消 Claude 纯运行时和 Claude `AgentAdapter` 已完成。`begin/drive` 分离保证 HTTP 可以先返回 `202`，后台执行不绑定请求连接；`waiting_agent` 在进程中断后不会被偷偷重放。

## G5：集成与交付（已完成）

交付物：

- 一条命令启动本地 API 与 WebUI。
- API、Web、编排核心和跨进程端到端测试。
- 安装、迁移、故障排查和同步边界文档。

验收：全仓类型检查、测试、生产构建、安全审计和浏览器验收全部通过。根目录 `npm run test:e2e` 会用隔离数据库重放真实 HTTP/SSE/Claude 子进程链路与 Mock 响应式布局。

## 当前分工

| 工作流 | 责任 | 当前状态 |
|---|---|---|
| API 与 SSE | 子代理：后端数据流 | 已完成并独立复审 |
| Web repository | 子代理：前端同步 | 已完成并独立复审 |
| Agent 状态机 | 子代理：编排核心 | 已完成并独立复审 |
| SQLite Store 与 lease | 子代理：持久化 | 已完成并独立复审 |
| Claude Runtime 与 Adapter | 子代理：运行时 | 已完成并独立复审 |
| 运行 REST 与 ExecutionManager | 子代理：产品接线 | 已完成并独立复审 |
| Web 自动轮次控制 | 子代理：前端运行面 | 已完成并独立复审 |
| 契约整合与端到端验收 | 主代理 | 已完成 |
| Rust SQLite 内容核心 | 子代理：Rust 数据流 | 已完成 |
| Tauri 桌面壳与本机设置 | 主代理 | 已完成 |
| React 桌面仓储与项目切换 | 主代理整合 | 已完成并完成真实桌面验收 |

## G6：Tauri 桌面工作台（已完成）

交付物：

- Tauri 2 桌面壳，打包现有 React Operator Console。
- 与 TypeScript 内容 schema 同构的 `council-core` Rust crate，直接读写同一 `council.sqlite3`。
- 原生日志库设置、项目目录选择、最近项目和首次运行引导。
- 桌面内容仓储、revision 校准与跨进程回帖刷新。

验收：桌面应用无需手动启动 API；已通过原生目录选择器绑定外部日志库、切换到现有项目，并加载历史议题与完整讨论链。SQLite 迁移只在首次打开或切库时执行，常规轮询复用持久连接；项目切换用设置世代隔离旧请求，目录失效可直接从错误页重选。创建议题、发布消息和确认决策由同一 Rust IPC/SQLite 路径覆盖；桌面自动轮次当时明确不可用（该限制已由本地 Agent 服务接入取代，见后续目标 1）。

## 后续目标

1. ~~把现有 Claude Runtime 与 ExecutionManager 迁入 Rust 桌面服务层。~~ 已改道并完成桌面侧接线：不在 Rust 重写编排状态机，桌面自动轮次复用 Node 编排服务（本地 Agent 服务），经 loopback HTTP/SSE 接入并共享同一 SQLite 库文件；服务离线时面板降级为诚实指引并自动重连（见 `packages/desktop/local-agent-service.md`）。
2. Codex 无可靠后台适配器时继续通过 Council MCP 与人工门参与，不伪造自动唤醒。
3. 把 accepted 决策导出为项目 ADR，并保留来源 topic 与证据链接。
4. 增加运行审计视图、筛选和保留策略。
5. 只有在出现稳定、可取消的外部触发接口后，才新增 Codex 或其他 Agent 适配器。
