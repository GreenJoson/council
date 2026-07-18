# src - MCP 服务核心源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `index.ts` | 入口 | 加载配置并连接 stdio MCP |
| `server.ts` | 核心 | 注册议题、消息、决策和 Claude 工具 |
| `database.ts` | 核心 | 管理 SQLite schema、事务和查询 |
| `claude-client.ts` | 核心 | 安全启动并恢复后台 Claude Code 会话 |
| `config.ts` | 配置 | 集中加载并校验运行参数 |
| `constants.ts` | 常量 | 定义协议枚举和输入边界 |
| `types.ts` | 类型 | 定义共享领域模型 |
| `logger.ts` | 基础设施 | 将结构化日志写入 stderr |
