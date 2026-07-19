# packages - 可独立构建的运行时模块

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `mcp-server/` | 核心 | 提供共享存储、MCP/REST/SSE、Claude Adapter 和后台执行管理器 |
| `web/` | 前端 | 提供 Operator Console、内容同步与自动轮次控制面 |
| `orchestrator/` | 编排 | 提供受控状态机、SQLite Store、lease fencing、人工门、取消和恢复 |
