# test - 编排核心验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `fakes.ts` | 测试基础 | 提供支持运行/绑定双 lease、session、批准幂等和故障注入的内存 Store 与 Fake Agent |
| `orchestrator.test.ts` | 核心验证 | 覆盖双 lease、session 恢复、cleanup 屏障、begin/drive、取消、安全失败和恢复；未分类异常必须报给宿主且不进公开文案 |
| `sqlite-council-store.test.ts` | 持久化验证 | 覆盖历史升级、v4 快照、RuntimeBinding 生命周期、稳定增量游标、跨物理 binding 逻辑请求账本、accepted fencing、空闲关闭、CAS 和损坏快照 |
| `runtime-capabilities.test.ts` | 能力协议 | 验证周期需求推导、策略与 Runtime 声明取交集、纯文本 Runtime 的修复/附件能力缺口 |
