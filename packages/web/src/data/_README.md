# data - Council Web 数据边界

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `repository.ts` | 边界 | 定义可替换的数据访问接口 |
| `create-repository.ts` | 配置 | 根据环境选择当前数据实现 |
| `mock-data.ts` | 示例 | 提供脱敏的 Operator Console 工作区数据 |
| `mock-repository.ts` | 原型 | 模拟议题创建、发帖、同步和决策接受 |
| `selectors.ts` | 查询 | 提供可测试的议题筛选逻辑 |
