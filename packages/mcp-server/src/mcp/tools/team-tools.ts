/**
 * @input  依赖：McpToolContext（数据库路径、回环 HTTP 基址/转发超时、团队 Lead 委派 id）、TeamStore、WorkItemDelegationStore、
 *         deriveWorkerStatus、Zod、tool-support 共享件与全局 fetch
 * @output 导出：registerTeamTools，注册 council_dispatch_worker / council_list_workers / council_wait_worker /
 *         council_interrupt_worker / council_merge_worker / council_archive_worker
 * @pos    P4 Worker 团队的 MCP 入口，主要给团队 Lead 用：读（list/wait）直接只读本地库，写（派发/中断/合并/归档）经回环 HTTP
 *         转发到 /api/v1/tasks/:taskId/team*，由 HTTP 进程里的 TeamService 唯一驱动 Git 与委派
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 团队定位：进程带 COUNCIL_TEAM_LEAD_DELEGATION_ID（Lead 注入）时按 Lead 委派找团队，taskId 可省略；否则 taskId 必填。
 */

import { z } from "zod/v4";
import { MAX_ID_CHARS } from "../../constants.js";
import { CouncilValidationError } from "../../errors.js";
import { WorkItemDelegationStore } from "../../orchestration/work-item-delegation-store.js";
import { deriveWorkerStatus, TeamStore, type TaskTeamRecord, type TaskWorkerRecord } from "../../teams/team-store.js";
import type { McpToolContext } from "../tool-context.js";
import { executeTool, success } from "../tool-support.js";

const MAX_WAIT_MS = 600_000;
const WAIT_POLL_MS = 1_000;
const SETTLED = new Set(["done", "error", "archived"]);

const taskIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^work_item_[A-Za-z0-9-]+$/, "taskId 格式无效")
  .optional()
  .describe("任务 ID（work_item_<uuid>）；团队 Lead 调用时可省略");
const workerIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^worker-[A-Za-z0-9-]+$/, "workerId 格式无效")
  .describe("Worker ID（council_dispatch_worker / council_list_workers 返回的 worker-<uuid>）");

interface WorkerSnapshot {
  id: string;
  label: string;
  role?: string;
  status: string;
  focused: boolean;
  branchName?: string;
  mergedCommit?: string;
  headCommit?: string;
  scopePaths: string[];
  summary?: string;
  error?: string;
}

interface Envelope {
  message?: unknown;
  data?: unknown;
}

function formatWorker(worker: WorkerSnapshot): string {
  return [
    `${worker.id}「${worker.label}」${worker.role ? `（${worker.role}）` : ""}：${worker.status}`,
    worker.mergedCommit ? `已合并 ${worker.mergedCommit.slice(0, 12)}` : worker.headCommit ? `提交 ${worker.headCommit.slice(0, 12)}` : "",
    worker.error ? `错误：${worker.error}` : "",
    worker.summary ? `摘要：${worker.summary}` : "",
  ].filter(Boolean).join("；");
}

export function registerTeamTools(context: McpToolContext): void {
  const { server, config } = context;

  /** 每次调用开一次只读连接：MCP 进程长驻，团队与委派行由 HTTP 进程持续改写。 */
  const withStores = <T>(run: (teams: TeamStore, delegations: WorkItemDelegationStore) => T): T => {
    const teams = new TeamStore(config.databasePath, config.sqliteBusyTimeoutMs);
    const delegations = new WorkItemDelegationStore(config.databasePath, config.sqliteBusyTimeoutMs);
    try {
      return run(teams, delegations);
    } finally {
      teams.close();
      delegations.close();
    }
  };

  const resolveTeam = (teams: TeamStore, taskId: string | undefined): TaskTeamRecord => {
    if (config.teamLeadDelegationId) {
      const team = teams.activeForLead(config.teamLeadDelegationId);
      if (!team) throw new CouncilValidationError("你的 Worker 团队已结束（Lead 委派已到终态或团队被人工结束）。");
      return team;
    }
    if (!taskId) throw new CouncilValidationError("缺少 taskId：非团队 Lead 调用时必须指定任务。");
    const team = teams.latestForWorkItem(taskId);
    if (!team) throw new CouncilValidationError("这条任务还没有 Worker 团队。");
    return team;
  };

  const snapshot = (worker: TaskWorkerRecord, delegations: WorkItemDelegationStore): WorkerSnapshot => {
    const delegation = delegations.get(worker.delegationId);
    return {
      id: worker.id, label: worker.label, ...(worker.role ? { role: worker.role } : {}),
      status: deriveWorkerStatus(worker.status, delegation), focused: worker.focused,
      ...(delegation?.branchName ? { branchName: delegation.branchName } : {}),
      ...(worker.mergedCommit ? { mergedCommit: worker.mergedCommit } : {}),
      ...(delegation?.headCommit && delegation.headCommit !== delegation.baseCommit ? { headCommit: delegation.headCommit } : {}),
      scopePaths: worker.scopePaths,
      ...(delegation?.summary ? { summary: delegation.summary } : {}),
      ...(delegation?.error ? { error: delegation.error } : {}),
    };
  };

  const workerOf = (teams: TeamStore, team: TaskTeamRecord, workerId: string): TaskWorkerRecord => {
    const worker = teams.getWorker(workerId);
    if (!worker || worker.teamId !== team.id) throw new CouncilValidationError("Worker 不存在或不属于这个团队。");
    return worker;
  };

  /** 写操作转发到同机 HTTP 服务；4xx 文案是 TeamService 的公开错误，原样返回（合并冲突含冲突文件与处理提示）。 */
  const forward = async (route: string, body: object = {}): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${config.httpServiceUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.httpForwardTimeoutMs),
      });
    } catch {
      throw new CouncilValidationError("Worker 团队需要本机 Council HTTP 服务在运行；当前无法连接，请稍后重试。");
    }
    let envelope: Envelope = {};
    try {
      envelope = await response.json() as Envelope;
    } catch {
      // 非 JSON 响应按状态码给出通用说明。
    }
    if (!response.ok) {
      const message = typeof envelope.message === "string" ? envelope.message : "";
      if ((response.status < 500 || response.status === 503) && message) throw new CouncilValidationError(message);
      throw new CouncilValidationError(`团队服务返回错误（HTTP ${String(response.status)}），请查看本地服务日志。`);
    }
    return envelope.data;
  };

  const teamRoute = (taskId: string | undefined): string => {
    const team = withStores((teams) => resolveTeam(teams, taskId));
    return `/api/v1/tasks/${encodeURIComponent(team.workItemId)}/team`;
  };

  const readAfterWrite = (taskId: string | undefined, workerId: string, verb: string) =>
    withStores((teams, delegations) => {
      const team = resolveTeam(teams, taskId);
      const worker = snapshot(workerOf(teams, team, workerId), delegations);
      return success(`${verb}：${formatWorker(worker)}`, { worker });
    });

  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    "council_dispatch_worker",
    {
      title: "派发 Worker",
      description:
        "把一个可并行、边界清晰的子任务派给 Worker：Council 先把你工作区未提交的改动做成检查点提交，再从该提交分叉独立 worktree，"
        + "用与你相同的执行 Agent 执行；Worker 完成后由 Council 提交到它自己的分支，等你决定是否合并。超出并行上限会被拒绝。",
      inputSchema: {
        taskId: taskIdField,
        label: z.string().min(1).max(80).describe("简短可辨的名字，如 api-tests"),
        role: z.string().max(80).optional().describe("角色说明（可选）"),
        brief: z.string().min(1).max(4_000).describe("Worker 指令：目标、约束、验收标准"),
        scopePaths: z.array(z.string().min(1).max(500)).max(50).optional()
          .describe("Worker 应只改动的文件或目录（相对项目根），用来减少合并冲突"),
        requestedPermission: z.enum(["workspace_write", "danger_full_access"]).optional()
          .describe("Worker 权限档；最终取与 Lead 权限的交集，缺省同 Lead"),
      },
      annotations: writeAnnotations,
    },
    async ({ taskId, label, role, brief, scopePaths, requestedPermission }) =>
      await executeTool("council_dispatch_worker", async () => {
        const data = await forward(`${teamRoute(taskId)}/workers`, {
          label, brief,
          ...(role ? { role } : {}),
          ...(scopePaths ? { scopePaths } : {}),
          ...(requestedPermission ? { requestedPermission } : {}),
        }) as { id: string };
        return readAfterWrite(taskId, data.id, "已派发");
      }),
  );

  server.registerTool(
    "council_list_workers",
    {
      title: "列出 Worker",
      description: "列出团队全部 Worker 及其状态（idle / running / done / error / archived）、分支、合并提交与摘要。",
      inputSchema: { taskId: taskIdField },
      annotations: readAnnotations,
    },
    async ({ taskId }) =>
      await executeTool("council_list_workers", () => withStores((teams, delegations) => {
        const team = resolveTeam(teams, taskId);
        const workers = teams.listWorkers(team.id).map((worker) => snapshot(worker, delegations));
        const header = `团队 ${team.id}（${team.status}，并行上限 ${String(team.maxParallel)}），Worker ${String(workers.length)} 个`;
        return success([header, ...workers.map(formatWorker)].join("\n"), { team: { ...team, workers } });
      })),
  );

  server.registerTool(
    "council_wait_worker",
    {
      title: "等待 Worker",
      description: "阻塞等待某个 Worker 结束（done / error / archived）或超时，返回它当前的状态；单次最多 600 秒，可重复调用。",
      inputSchema: {
        taskId: taskIdField,
        workerId: workerIdField,
        timeoutMs: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe("最长等待毫秒数，缺省 600000"),
      },
      annotations: readAnnotations,
    },
    async ({ taskId, workerId, timeoutMs }, extra) =>
      await executeTool("council_wait_worker", async () => {
        const deadline = Date.now() + (timeoutMs ?? MAX_WAIT_MS);
        for (;;) {
          const worker = withStores((teams, delegations) =>
            snapshot(workerOf(teams, resolveTeam(teams, taskId), workerId), delegations));
          const settled = SETTLED.has(worker.status);
          if (settled || Date.now() >= deadline || extra.signal.aborted) {
            return success(`${settled ? "已结束" : "仍在运行（等待超时）"}：${formatWorker(worker)}`, { worker });
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, Math.max(deadline - Date.now(), 1))));
        }
      }),
  );

  const action = (name: string, title: string, description: string, verb: string, path: string): void => {
    server.registerTool(
      name,
      { title, description, inputSchema: { taskId: taskIdField, workerId: workerIdField }, annotations: writeAnnotations },
      async ({ taskId, workerId }) =>
        await executeTool(name, async () => {
          await forward(`${teamRoute(taskId)}/workers/${encodeURIComponent(workerId)}/actions/${path}`);
          return readAfterWrite(taskId, workerId, verb);
        }),
    );
  };

  action("council_interrupt_worker", "中断 Worker",
    "中断跑偏或不再需要的 Worker：取消它的执行，状态变为 error，之后不能再合并。", "已中断", "interrupt");
  action("council_merge_worker", "合并 Worker",
    "把 done 的 Worker 分支以 --no-ff 合并进你的工作区（先对你未提交的改动做检查点提交）。"
    + "出现冲突时 Council 会撤销本次合并并返回冲突文件，请你自己在工作区完成合并。", "已合并", "merge");
  action("council_archive_worker", "归档 Worker",
    "归档不再关注的 Worker；仍在运行的会先被取消。", "已归档", "archive");
}
