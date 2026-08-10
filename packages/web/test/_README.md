# test - Council Web 自动化验证

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `mock-repository.test.ts` | 数据测试 | 验证议题创建、公开发帖、订阅、决策状态转换和只读议题详情加载 |
| `api-mapping.test.ts` | 协议测试 | 验证未知 JSON 解析、动态 Actor/冻结快照映射和不伪造证据 |
| `http-repository.test.ts` | 集成测试 | 验证惰性详情、写后校准、revision 重置/恢复、旧请求竞态、timer 生命周期和只读议题详情加载 |
| `orchestration-repository.test.ts` | 编排测试 | 验证 policy、公开 RuntimeBinding 解析/动作、revision 分流、草稿隔离、选题竞态和审批重放 |
| `agent-reply-activity.test.ts` | UI 逻辑 | 验证活动 Agent 只从当前议题最新 Run 派生，并读取匹配 run/adapter 的草稿 |
| `frozen-actor-rendering.test.tsx` | UI 回归 | 验证 Actor 改名后，旧议题所有者、决策提出者和备选作者仍显示写入时冻结快照 |
| `configuration.test.ts` | 配置测试 | 验证 http 模式拒绝空值、相对路径和残缺 UNC 项目路径，以及 desktop 模式编排工厂的完整配置要求 |
| `desktop-orchestration.test.ts` | 桌面编排 | 验证服务地址解析、离线降级与诚实文案、autostart 只拉起一次、服务恢复后自动转 LIVE 和健康轮询生命周期 |
| `model-router.test.ts` | UI 逻辑 | 验证 Kimi API/Kimi Code ACP/DeepSeek 名称与品牌、同 Provider 多 Agent、Claude/Codex 身份锁定、按需 catalog 及 API Key 不回显 |
| `auto-rounds.test.ts` | UI 逻辑 | 验证创建互斥、已决议题统一阻断、当前/历史调用、每 Agent 最新逻辑绑定分区和恢复预算 |
| `selectors.test.ts` | 查询测试 | 验证议题搜索的空值、中文和大小写行为，以及 groupTopicsByStatus 的固定分组顺序、组内保序与空数组场景 |
| `desktop-bridge.test.ts` | 桌面边界 | 验证原生目录取消、设置解析和 invoke payload |
| `native-repository.test.ts` | 桌面仓储 | 验证 Rust 同形响应映射、最近项目切换、旧加载世代隔离与只读议题详情加载 |
| `mention-parser.test.ts` | 查询测试 | 验证动态 mentionAlias、同 Provider 多 Agent、未知名/代码围栏/多标记边界、自动补全光标定位和前导芯片提取 |
| `commit-association.test.tsx` | 协议/UI 回归 | 验证多仓库 commit 校验与协议编解码，并确保消息卡隐藏协议 JSON、展示可读关联提交 |
| `webui-smoke.py` | 浏览器测试 | 验证人工决策零 Agent Run、圆桌三段审查范围、Composer `@Agent` 单一当前调用、Model Router 身份只读、实时草稿、议题隔离、大屏讨论列、移动端抽屉与控制台错误 |
| `webui-http-smoke.py` | 端到端测试 | 验证项目隔离、远程 Provider 双 Agent 在圆桌名册热加载、HTTP 安全失败原因展示、别名/停用/删除恢复边界、Provider 滚动、外部 API 回帖经 SSE 自动出现、Claude 子进程编排、人工门与 Web 回写 |
| `error-message.test.ts` | 单元测试 | 验证启动失败路径的文案归一化：Tauri 字符串 reject 与对象 message 必须保留，只有空白值才回落到通用文案 |
