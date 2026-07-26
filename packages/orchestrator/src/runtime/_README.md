# runtime - 统一运行时契约

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `contracts.ts` | 契约 | 定义 RuntimeBinding 的只读 session 投影、统一事件、事件 Sink 与 delegated / tool-loop 工具所有权校验 |

`RuntimeSessionRef` 不能独立持久化；`RuntimeBinding` 始终是 session、cursor、epoch 与配置版本的唯一真源。
Council 自管的 ToolLoop 仅允许只读能力，任何写仓库、写 Shell 或提交请求都默认拒绝。
