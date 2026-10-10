/**
 * @input  依赖：HttpRouteContext（可选编排服务上挂载的 TeamService）、Zod schema 与统一响应
 * @output 导出：注册 P4 Worker 团队 REST（组队、读团队、派发/等待/中断/合并/归档/聚焦 Worker、结束团队）的 registerTeamRoutes
 * @pos    /api/v1/tasks/:taskId/team：团队的唯一 HTTP 入口；Web 与 Lead 的团队 MCP 工具（经回环转发）共用；
 *         只做协议适配，团队语义在 teams/TeamService
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 404 约定：GET /team 在任务从未组队时返回 404（Web 视为「没有团队」）。
 * 合并冲突：409，data 带 { files, hint }，hint 固定为「请 Lead 自行在工作区合并」。
 */

import type { Express } from "express";
import { MERGE_CONFLICT_HINT, TeamMergeConflictError } from "../../teams/team-git.js";
import type { TeamService } from "../../teams/team-service.js";
import { HttpError, sendSuccess } from "../responses.js";
import {
  dispatchWorkerBodySchema,
  focusWorkerBodySchema,
  startTeamBodySchema,
  taskParamsSchema,
  teamWorkerParamsSchema,
  waitWorkerQuerySchema,
} from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

const DEFAULT_WAIT_MS = 600_000;

export function registerTeamRoutes(app: Express, context: HttpRouteContext): void {
  const requireTeams = (): TeamService => {
    const teams = context.orchestration?.teams;
    if (!teams) throw new HttpError(503, "Worker 团队需要本地 Agent 服务，当前未启用。");
    return teams;
  };
  const base = "/api/v1/tasks/:taskId/team";

  app.post(base, async (request, response) => {
    const teams = requireTeams();
    const { taskId } = parse(taskParamsSchema, request.params);
    const input = parse(startTeamBodySchema, request.body);
    const result = await teams.startTeam({
      workItemId: taskId,
      expectedVersion: input.expectedVersion,
      executorAgentId: input.executorAgentId,
      requestedPermission: input.requestedPermission,
      ...(input.supervisorAgentId ? { supervisorAgentId: input.supervisorAgentId } : {}),
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(input.completionPolicy ? { completionPolicy: input.completionPolicy } : {}),
      ...(input.createInitialBaseline ? { createInitialBaseline: true } : {}),
      ...(input.maxParallel ? { maxParallel: input.maxParallel } : {}),
    });
    sendSuccess(response, result, "团队已组建，Lead 开始执行。", 202);
  });

  app.get(base, (request, response) => {
    const teams = requireTeams();
    const { taskId } = parse(taskParamsSchema, request.params);
    sendSuccess(response, teams.getTeam(taskId));
  });

  app.post(`${base}/workers`, async (request, response) => {
    const teams = requireTeams();
    const { taskId } = parse(taskParamsSchema, request.params);
    const input = parse(dispatchWorkerBodySchema, request.body);
    const worker = await teams.dispatchWorker(taskId, {
      label: input.label,
      brief: input.brief,
      ...(input.role ? { role: input.role } : {}),
      ...(input.scopePaths ? { scopePaths: input.scopePaths } : {}),
      ...(input.requestedPermission ? { requestedPermission: input.requestedPermission } : {}),
    });
    sendSuccess(response, worker, "Worker 已派发。", 202);
  });

  app.get(`${base}/workers/:workerId/wait`, async (request, response) => {
    const teams = requireTeams();
    const { taskId, workerId } = parse(teamWorkerParamsSchema, request.params);
    const { timeoutMs } = parse(waitWorkerQuerySchema, request.query);
    // 客户端断开即停止轮询，避免悬挂的等待占住连接。
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    sendSuccess(response, await teams.waitWorker(taskId, workerId, timeoutMs ?? DEFAULT_WAIT_MS, controller.signal));
  });

  app.post(`${base}/workers/:workerId/actions/interrupt`, async (request, response) => {
    const teams = requireTeams();
    const { taskId, workerId } = parse(teamWorkerParamsSchema, request.params);
    sendSuccess(response, await teams.interruptWorker(taskId, workerId), "Worker 已中断。");
  });

  app.post(`${base}/workers/:workerId/actions/merge`, async (request, response) => {
    const teams = requireTeams();
    const { taskId, workerId } = parse(teamWorkerParamsSchema, request.params);
    try {
      sendSuccess(response, await teams.mergeWorker(taskId, workerId), "Worker 已合并进 Lead 工作区。");
    } catch (error) {
      if (!(error instanceof TeamMergeConflictError)) throw error;
      response.status(409).json({
        code: 409,
        message: error.message,
        data: { files: error.files, hint: MERGE_CONFLICT_HINT },
        timestamp: Date.now(),
      });
    }
  });

  app.post(`${base}/workers/:workerId/actions/archive`, async (request, response) => {
    const teams = requireTeams();
    const { taskId, workerId } = parse(teamWorkerParamsSchema, request.params);
    sendSuccess(response, await teams.archiveWorker(taskId, workerId), "Worker 已归档。");
  });

  app.post(`${base}/workers/:workerId/actions/focus`, (request, response) => {
    const teams = requireTeams();
    const { taskId, workerId } = parse(teamWorkerParamsSchema, request.params);
    const { focused } = parse(focusWorkerBodySchema, request.body);
    teams.focusWorker(taskId, workerId, focused);
    sendSuccess(response, null, focused ? "已聚焦 Worker。" : "已取消聚焦。");
  });

  app.post(`${base}/actions/end`, async (request, response) => {
    const teams = requireTeams();
    const { taskId } = parse(taskParamsSchema, request.params);
    sendSuccess(response, await teams.endTeam(taskId), "团队已结束。");
  });
}
