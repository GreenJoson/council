# test - 编排核心验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `fakes.ts` | 测试基础 | 提供支持版本、lease、批准幂等和故障注入的内存 Store 与 Fake Agent |
| `orchestrator.test.ts` | 核心验证 | 覆盖 cleanup 屏障、begin/drive、lease 丢失、人工门、取消、安全失败消息和恢复 |
| `sqlite-council-store.test.ts` | 持久化验证 | 显式创建测试 schema，并覆盖跨连接取消、状态分页、旧快照、迟到提交、CAS 和损坏快照 |
