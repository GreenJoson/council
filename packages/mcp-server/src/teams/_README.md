# teams - P4 Worker 团队

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `team-store.ts` | 持久层 | v20 `task_teams` / `task_workers` 读写（每任务最多一个 active 团队、每团队最多一个聚焦 Worker）、Lead 执行者 Actor 的 @别名查询；`deriveWorkerStatus` 是委派状态 → Worker 状态的唯一映射（archived 粘性，queued→idle，approved→done，failed/cancelled→error，其余 running） |
| `team-git.ts` | Git 写入口 | Lead 工作区检查点提交（先 `reset --mixed` 回 Council 记录的 HEAD，再走与交付提交同一套敏感路径/凭据扫描）、Worker worktree 分叉与清理、`merge --no-ff` 合并（冲突时列文件、`merge --abort`，抛 `TeamMergeConflictError`） |
| `lead-mcp-config.ts` | 运行时配置 | 定位本机 stdio MCP 入口（`dist/src/index.js`，`process.execPath` 启动）并组装 Lead 专用的 `council` MCP：继承 `collectCouncilEnv()`，固定 `COUNCIL_CALLER_ACTOR_ALIAS` = Lead 执行者别名、`COUNCIL_TEAM_LEAD_DELEGATION_ID`、`COUNCIL_HTTP_HOST/PORT`，工具超时 900 秒 |
| `team-lead-brief.ts` | 提示词 | Lead 执行提示词的「团队模式」段：六个工具、并行上限、检查点规则、只合并检查过的 Worker、单次最终审核 |
| `team-service.ts` | 用例 | startTeam / dispatchWorker / listWorkers / waitWorker / interruptWorker / mergeWorker / archiveWorker / focusWorker / endTeam / getTeam；同团队写操作串行；Lead 进入终态自动结束团队；启动对账 |

## 模型

- 团队 = 一条代码委派（Lead）+ 若干 `team_worker=1` 的子委派（Worker），挂在同一任务上。Worker 沿用 Lead 的执行者、审核者与完成策略，
  权限取「执行者 ∩ Lead ∩ 请求」；不进委派列表、不进工作注意力、不认领实施项、不单独审核。
- Lead：普通 `#executeInWorkspace` 流程，执行阶段额外注入 Council MCP（只注册六个团队工具）和「团队模式」指令；快照与交付提交前从仓储同步
  HEAD（Worker 合并会移动它）。Lead 收尾后的那次审核覆盖 Lead 与所有已合并 Worker 的提交——全团队只审一次。
- Worker：派发时先把 Lead 未提交改动做成检查点提交，再从该提交 `worktree add` 出 `codex/council-worker-<12位>` 分支；Worker 执行完由
  Council 提交到自己分支，状态到 approved（= done）。没有改动则失败（error）。
- 合并：只合并 done 且未合并的 Worker；先检查点，再 `merge --no-ff`，成功后回写 Lead HEAD 与 `mergedCommit`；冲突 409，由 Lead 自行在工作区处理。
- 中断：取消 Worker 委派，状态 error，不能再合并。归档：运行中先取消，状态 archived（粘性）。结束团队：中断全部运行中的 Worker，不取消 Lead。

## 入口与依赖方向

- REST：`http/routes/team-routes.ts`（`/api/v1/tasks/:taskId/team*`）；编排服务未启用时 503。
- MCP：`mcp/tools/team-tools.ts`；读（list/wait）直接读库，写经回环 HTTP 转发到上面的 REST。
- 装配：`orchestration/service.ts` 工厂创建 `TeamService` 并接入 initialize/close；构造时向委派管理器注册 `leadRuntime` 钩子。

`http/routes`、`mcp/tools`、`orchestration/service.ts` → `teams/` → `orchestration/work-item-delegation-*`（只用类型与快照扫描）、
`process-utils.ts`、`errors.ts`。TeamService 对委派管理器只经注入端口，不 import 管理器实现。

## 限制

- 桌面 sidecar 是单文件打包，没有 `dist/src/index.js`，`resolveCouncilMcpEntry()` 返回 undefined，组队直接 409。
- 检查点/合并与 Lead 正在写文件并发时，正在写的文件可能被收进检查点提交。
- 执行者必须是有 @别名的 Claude/Codex CLI Agent，否则 409「团队模式需要系统 Claude/Codex Agent 作为执行者」。
