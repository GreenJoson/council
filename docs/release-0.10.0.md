# Council 0.10.0 发布审核

本版把 V2 重构全部阶段并入主分支：P1 直接任务、P2 资产库与 Codex 生图、P3 流水线、P5 UI 收口（`6585819`），以及本次追加的 P4 Worker 团队 + 客户端接入配置分发（schema v20）、消息图片附件、重绘的应用图标。V2 的目标、分阶段方案与各阶段落地记录以 [council-v2-refactor-plan.md](council-v2-refactor-plan.md) 为正本。

## 本版范围

- **Worker 团队（schema v20）**：代码任务可勾「团队模式」交给 Lead 并行拆分；Lead 在自己的会话里用六个 `council_*_worker` 工具派发、等待、打断、合并、归档 Worker；每个 Worker 在独立 worktree/分支上工作，受控 `merge --no-ff` 回 Lead 分支，全团队只审一次。任务详情右栏「团队」可聚焦、打断、归档与结束团队。
- **客户端接入**：设置「客户端接入」一键把 Council MCP 注册与 Skill 写入本机 Claude Code / Codex 配置，只碰 Council 自己的片段，首次写入拍 stash，漂移时拒绝覆盖（可强制），随时还原；`docs/mcp-setup.md` 以此为首选、手动配置降为备用。
- **消息图片附件**：编辑器「引用图片」/粘贴把图片存入日志库资产库（不落项目目录），正文插入 `council-asset:` 引用，发布后内嵌渲染并挂到消息；Agent 写在正文里的项目内相对路径图片只读出站显示。
- **图标**：圆桌三席位符号，应用图标、`BrandLogo` 与 favicon 统一。
- 版本号 0.9.8 → 0.10.0：v20 为破坏性迁移，旧二进制不读新库。

## 自审修复

- Worker 合并提交与 Lead 交付提交竞态：Lead 交付提交经 `withLeadWorkspace` 排进团队锁，不再丢失已合并提交。
- 团队分支原按 `dist/src/index.js` 定位 Lead 的 MCP 入口，桌面 sidecar 会组队 409；合并时把启动命令定位收成 `stdio-mcp.ts` 的 `resolveStdioMcpLaunch`（sidecar 用自身可执行 + `--council-stdio-mcp`），与客户端接入写入的注册同源。
- `council-asset:` 引用的资产 ID 字符集漏了下划线，mock 上传的引用解析不出、渲染成占位；前端、服务端与冒烟脚本同步修正。
- 流水线阶段的审查修复：接续沿用原委派权限并保留 delegationId、复盘只看本次入库产物、原型交接暂停后 resume 接续并保留第一段改动、简报张数上限与生图超时文案、图像清单 prompt/notes 入库前脱敏。
- 合并收口：`config.ts` 两路新增函数合并时补回缺失的右括号；文档与冒烟脚本头注释按「两路都保留」合并。

## 源码验收

2026-10-11 在本机（Apple Silicon）完成，合并分支 `refactor/v2-p4-workers`：

| 检查 | 结果 |
|---|---|
| `npm run check`（web / mcp-server / orchestrator） | TypeScript 全部通过 |
| `npm run check:rust` | cargo fmt + Clippy（拒绝警告）通过 |
| `npm test` | 前端 195、后端 280、编排 101、Rust 核心 15、桌面 17 项通过 |
| `npm run test:e2e`（第一次，`0220180`） | 真实 HTTP/SSE + SQLite + 子进程替身：P1 直接任务、P2 图像委派、P3 流水线闭环与界面、P4 Worker 团队闭环（组队、Lead 注入 MCP 工具面、派发 3 个 Worker 与并行上限 409、中断 1 个、合并 2 个、全团队只审一次）、客户端接入写入 → 漂移 409 → 还原、消息图片出站/上传/挂接；Mock 浏览器冒烟（含团队右栏、编辑器引用图片）全部通过 |

真实 Codex 验收以桌面替换后的记录为准（见下）。

## 边界与替换要求

- 安装包由干净提交执行 `npm run build:desktop` 生成（`prebuild` 会重建内置 Agent Service），核对应用内版本与提交标识后替换。替换前退出应用并停止旧 Agent Service（它在退出桌面后仍常驻，否则新应用会连上旧版服务），保留旧应用，并对日志库 `council.sqlite3` 做一致性备份；迁移器自身也会在同目录生成迁移前备份。
- 启动后核对 schema v20 就绪、历史议题与任务完整。旧二进制不读 v20；回退必须配合对应版本的迁移前备份。
- 团队模式要求执行者是带 @别名的系统 Claude/Codex CLI Agent；检查点/合并与 Lead 正在写文件并发时，半写文件可能被收进检查点提交。
- 浏览器验收使用 Agent 替身，不代表真实上游模型已验收；E2E 在高负载下首轮偶发 `agent_timeout`，重跑一次再判定。
