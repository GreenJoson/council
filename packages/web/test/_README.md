# test - Council Web 自动化验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `mock-repository.test.ts` | 数据测试 | 验证议题创建、公开发帖、订阅、决策状态转换和只读议题详情加载 |
| `api-mapping.test.ts` | 协议测试 | 验证未知 JSON 解析、Author 映射和不伪造证据 |
| `http-repository.test.ts` | 集成测试 | 验证惰性详情、写后校准、revision 重置/恢复、旧请求竞态、timer 生命周期和只读议题详情加载 |
| `orchestration-repository.test.ts` | 编排测试 | 验证 policy 解析、双 revision 分流、双向选题竞态、审批重放和 timer 生命周期 |
| `configuration.test.ts` | 配置测试 | 验证 http 模式拒绝空值、相对路径和残缺 UNC 项目路径，以及 desktop 模式编排工厂的完整配置要求 |
| `desktop-orchestration.test.ts` | 桌面编排 | 验证服务地址解析、离线降级与诚实文案、autostart 只拉起一次、服务恢复后自动转 LIVE 和健康轮询生命周期 |
| `agent-settings.test.ts` | UI 逻辑 | 验证本机 Agent 常驻、未配置远程 Provider 按需隐藏及有状态 Provider 回到路由列表 |
| `auto-rounds.test.ts` | UI 逻辑 | 验证创建互斥、全局 busy 锁定和人工恢复预算耗尽状态 |
| `selectors.test.ts` | 查询测试 | 验证议题搜索的空值、中文和大小写行为，以及 groupTopicsByStatus 的固定分组顺序、组内保序与空数组场景 |
| `desktop-bridge.test.ts` | 桌面边界 | 验证原生目录取消、设置解析和 invoke payload |
| `native-repository.test.ts` | 桌面仓储 | 验证 Rust 同形响应映射、最近项目切换、旧加载世代隔离与只读议题详情加载 |
| `mention-parser.test.ts` | 查询测试 | 验证本机 publicAuthor 与远程 adapter ID 召唤解析、未知名/代码围栏/多标记边界、自动补全光标定位和前导芯片提取 |
| `webui-smoke.py` | 浏览器测试 | 验证自动轮次、大屏讨论列随窗口增长、正文行长、移动端抽屉、无横向滚动和控制台错误 |
| `webui-http-smoke.py` | 端到端测试 | 验证项目隔离、按需 Provider 设置、外部 API 回帖经 SSE 自动出现、多适配器能力账本、Claude 子进程编排、人工门与 Web 回写 |
