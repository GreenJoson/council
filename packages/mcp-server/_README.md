# mcp-server - 本地架构讨论 MCP 服务

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 核心 | 锁定依赖与构建、测试命令 |
| `package-lock.json` | 锁定 | 固化依赖解析结果 |
| `tsconfig.json` | 配置 | 启用严格 TypeScript 编译 |
| `.env.example` | 配置 | 列出全部可配置运行参数 |
| `src/` | 核心 | MCP、数据库与 Claude 适配器源码 |
| `test/` | 验证 | 数据库、适配器和协议测试 |
