/**
 * @input  依赖：HttpRouteContext（CouncilDatabase、可选编排服务）、tasks/TaskService、Zod schema 与统一响应
 * @output 导出：注册任务入口 REST（创建直接任务、按项目列表、详情、乐观更新、委派列表与发起委派）的 registerTaskRoutes
 * @pos    /api/v1/tasks：不依赖议题的任务一等入口；议题派生任务同样可经此读取、更新与委派
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Express } from "express";
import { TaskService, type TaskDelegationPort } from "../../tasks/task-service.js";
import { HttpError, sendSuccess } from "../responses.js";
import {
  createTaskBodySchema,
  listTasksQuerySchema,
  startTaskDelegationBodySchema,
  taskParamsSchema,
  updateWorkItemBodySchema,
} from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

export function registerTaskRoutes(app: Express, context: HttpRouteContext): void {
  const { database, orchestration } = context;
  // HTTP 进程持有委派管理器：直接接到编排服务；未启用时委派相关路由返回 503。
  const port: TaskDelegationPort | undefined = orchestration
    ? {
      listForWorkItem: (workItemId) => orchestration.listTaskDelegations(workItemId),
      start: (workItemId, input) => orchestration.startWorkItemDelegation({ ...input, workItemId }),
    }
    : undefined;
  const tasks = new TaskService(database, port);
  const requireDelegation = (): void => {
    if (!orchestration) throw new HttpError(503, "任务委派服务未启用。");
  };

  app.post("/api/v1/tasks", (request, response) => {
    const input = parse(createTaskBodySchema, request.body);
    const task = tasks.createDirect({
      projectPath: input.projectPath,
      title: input.title,
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.brief ? { brief: input.brief } : {}),
      actorId: "human",
    });
    sendSuccess(response, task, "任务已创建。", 201);
  });

  app.get("/api/v1/tasks", (request, response) => {
    const query = parse(listTasksQuerySchema, request.query);
    sendSuccess(response, tasks.list({
      projectPath: query.project,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.source ? { source: query.source } : {}),
    }));
  });

  app.get("/api/v1/tasks/:taskId", async (request, response) => {
    requireDelegation();
    const { taskId } = parse(taskParamsSchema, request.params);
    sendSuccess(response, await tasks.get(taskId));
  });

  app.put("/api/v1/tasks/:taskId", (request, response) => {
    const { taskId } = parse(taskParamsSchema, request.params);
    const input = parse(updateWorkItemBodySchema, request.body);
    const task = tasks.update({
      taskId,
      status: input.status,
      expectedVersion: input.expectedVersion,
      ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
      ...(input.fixCommit !== undefined ? { fixCommit: input.fixCommit } : {}),
      actorId: "human",
    });
    sendSuccess(response, task, "任务已更新。");
  });

  app.get("/api/v1/tasks/:taskId/delegations", async (request, response) => {
    requireDelegation();
    const { taskId } = parse(taskParamsSchema, request.params);
    sendSuccess(response, await tasks.listDelegations(taskId));
  });

  app.post("/api/v1/tasks/:taskId/delegations", async (request, response) => {
    requireDelegation();
    const { taskId } = parse(taskParamsSchema, request.params);
    const input = parse(startTaskDelegationBodySchema, request.body);
    const delegation = await tasks.delegate(taskId, {
      expectedVersion: input.expectedVersion,
      supervisorAgentId: input.supervisorAgentId,
      executorAgentId: input.executorAgentId,
      requestedPermission: input.requestedPermission,
      kind: input.kind,
      inputAssetIds: input.inputAssetIds,
      ...(input.completionPolicy ? { completionPolicy: input.completionPolicy } : {}),
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(input.createInitialBaseline !== undefined
        ? { createInitialBaseline: input.createInitialBaseline }
        : {}),
    });
    sendSuccess(response, delegation, "Agent 委派已进入后台执行。", 202);
  });
}
