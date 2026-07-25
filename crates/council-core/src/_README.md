# src - council-core 源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `lib.rs` | 入口 | 统一导出错误、存储和领域类型 |
| `error.rs` | 错误 | 定义可识别的存储错误 |
| `store.rs` | 核心 | 失败关闭地校验 Node canonical v7 schema（含 RuntimeBinding、圆桌收敛容器、逻辑请求唯一键、活动 session 唯一索引与 Provider/Agent 配置版本），并读写共享 SQLite 内容数据 |
| `types.rs` | 类型 | 定义与 TypeScript 同构的序列化模型 |
