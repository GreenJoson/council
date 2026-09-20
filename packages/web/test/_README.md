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
| `commit-association.test.tsx` | 协议/UI 回归 | 验证批量 SHA 多分隔符展开、同仓库多轮 commit、多仓库校验与协议编解码，并确保消息卡隐藏协议 JSON、展示可读关联提交 |
| `implementation-progress.test.tsx` | 进度回归 | 验证中英界面下右栏摘要从叶子任务派生完成度，父任务缩进渲染且状态按钮只读，审核发现标出严重度与轮次，已认领叶子显示执行者与修复提交 |
| `discussion-task-tab.test.tsx` | 布局回归 | 验证长任务清单进入主区任务 tab，tab 以完成数/总数展示紧凑进度 |
| `i18n.test.tsx` | 国际化回归 | 验证保存偏好与系统语言回退、中英词典插值、用户内容不翻译及顶部语言切换入口 |
| `architecture-section.test.tsx` | 折叠回归 | 验证展开渲染正文并标 `aria-expanded`、折叠时正文不进 DOM、中英开关提示，以及存量折叠值损坏时回落全展开 |
| `i18n-coverage.test.ts` | 国际化守卫 | 扫描 src 下所有 `t("中文")` 字面量，缺英文条目即失败；防止新文案只有中文 |
| `work-item-tree.test.ts` | 树结构单测 | 验证父状态派生优先级（受阻 > 进行中 > 全完成）、按 sortOrder 父前子后排序、父级缺失条目回落顶层，以及完成度只数叶子与阻断发现单独计数 |
| `topic-sidebar-progress.test.tsx` | 侧栏回归 | 验证完成度渲染在时间右侧并按受阻/完成切换色调，未拆分实施项的议题不渲染徽标（`0/0` 与「还没拆」不是一回事）|
| `webui-smoke.py` | 浏览器测试 | 验证人工决策零 Agent Run、圆桌三段审查范围、Composer `@Agent` 单一当前调用、Model Router 身份只读、实时草稿、议题隔离、大屏讨论列、移动端抽屉与控制台错误 |
| `webui-http-smoke.py` | 端到端测试 | 验证项目隔离、远程 Provider 双 Agent 在圆桌名册热加载、HTTP 安全失败原因展示、别名/停用/删除恢复边界、Provider 滚动、外部 API 回帖经 SSE 自动出现、Claude 子进程编排、人工门与 Web 回写 |
| `error-message.test.ts` | 单元测试 | 验证启动失败路径的文案归一化：Tauri 字符串 reject 与对象 message 必须保留，只有空白值才回落到通用文案 |

HTTP/SSE 浏览器验收覆盖运行审计展开、待处理导航及确认后的自动消退；HTTP 和 Mock 浏览器显式设置 zh-CN，嵌套审计折叠区使用精确父级定位。
