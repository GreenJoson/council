# docs - Council 用户与维护文档

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `mcp-setup.md` | 双语接入 | 首选「设置 → 客户端接入 → 写入」（目标文件、stash/applied、漂移与还原），备用手动 Claude/Codex MCP 示例和身份边界 |
| `local-release.md` | 发版流程 | 本地发版与替换：版本号规则（每次替换都升，默认末位）、更新日志与审核记录要求、version:set → 构建 → desktop:install 步骤、安装脚本的检查项与回退方法 |
| `release-0.10.1.md` | 发布审核 | 0.10.0 之后首个末位版本：图片显示与出图链路修复、看图与流水线界面、生图超时/卡住处理、本地发版脚本；源码验收与本机替换、真实流水线验收 |
| `release-0.10.0.md` | 发布审核 | V2 全部阶段并入主分支的发布审核：范围（Worker 团队 v20、客户端接入、消息图片、图标）、自审修复、测试结果、替换要求与真实验收 |
| `release-0.9.2.md` | 发布审核 | 记录 0.9.2 版自审修复、测试结果、发布范围与安装替换边界 |
| `execution-delivery.md` | 执行交付 | 说明完成条件、持久运行证据、需要我处理、检查点恢复、未提交代码接续与兼容边界 |
| `usage.md` | 用户指南 | 说明三栏壳与各视图入口、任务 / 资产库 / 流水线、模型/Provider 设置、多 Agent 接力、Accepted 决策实施项进度、自动完成和故障排查 |
| `evolution-goal.md` | 演进目标 | 拆分真实同步、自动编排、桌面迁移和集成交付的里程碑与验收标准 |
| `schema-migration-safety.md` | 运维与架构 | 说明 Node 单一迁移所有权、版本镜像、备份验证、失败语义和桌面 ready 门 |
| `actor-identity-migration.md` | 身份与迁移 | 说明 schema v2 动态 Actor、别名、冻结快照、旧作者映射、M3 RuntimeBinding/session 生命周期和回滚边界 |
| `review-fix-loop.md` | 设计正本 | 说明审核→修复→复审闭环、work item 树与 schema v12 数据模型、尾块协议、审核状态机与落地顺序 |
| `council-v2-refactor-plan.md` | 重构方案 | v2 执行正本：任务/资产/流水线一等化、Codex 生图通道、UI 按模式导航、schema v18–v20 与分阶段验收，交 Opus 执行 |
| `designs/` | 设计探索 | 保存 WebUI 视觉方案、信息架构取舍与 v2 三栏壳（讨论 / 任务 / 资产库 / 流水线）实现截图 |

执行交付文档包含分阶段预算、私有检查点、指令复用、schema v17 兼容性和桌面 sidecar 生命周期边界。

执行交付指南补充接续权限的显式选择与 OAuth 登录过期处理。
