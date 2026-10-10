/**
 * @input  依赖：HttpRouteContext（HTTP 配置、CouncilDatabase、可选编排服务）、tasks 议题入口、AI 实施计划规划器、Zod schema 与统一响应
 * @output 导出：注册实施项创建/AI 生成/更新/认领、项目待处理、运行审计与跨 Agent 任务委派（单项、批量、接续、取消）REST 的 registerWorkItemRoutes
 * @pos    WebUI 推进决策落地：实施项生命周期与委派执行的 HTTP 路由模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Express } from "express";
import {
  formatWorkItemPlanningContext,
  parseWorkItemPlan,
  WORK_ITEM_PLANNING_INSTRUCTION,
} from "../../orchestration/work-item-planner.js";
import { createTopicTasks } from "../../tasks/task-intake.js";
import { HttpError, sendSuccess } from "../responses.js";
import {
  claimWorkItemBodySchema,
  createWorkItemsBodySchema,
  delegationParamsSchema,
  emptyActionBodySchema,
  generateWorkItemsBodySchema,
  resumeDelegationBodySchema,
  runtimeAuditQuerySchema,
  startWorkItemDelegationBatchBodySchema,
  startWorkItemDelegationBodySchema,
  topicParamsSchema,
  updateWorkItemBodySchema,
  workItemParamsSchema,
} from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

export function registerWorkItemRoutes(app: Express, context: HttpRouteContext): void {
  const { config, database, orchestration } = context;

  app.post("/api/v1/topics/:topicId/work-items", (request, response) => {
    const params = parse(topicParamsSchema, request.params);
    const input = parse(createWorkItemsBodySchema, request.body);
    const workItems = createTopicTasks(database, {
      topicId: params.topicId,
      ...(input.decisionId ? { decisionId: input.decisionId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      items: input.items,
      actorId: "human",
    });
    sendSuccess(response, workItems, "实施项已添加。", 201);
  });

  app.post("/api/v1/topics/:topicId/work-items/actions/generate", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "AI 任务规划服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const input = parse(generateWorkItemsBodySchema, request.body);
    const detail = database.getTopicDetail(params.topicId, config.defaultMessageLimit);
    const decision = input.decisionId
      ? detail.decisions.find((candidate) => candidate.id === input.decisionId)
      : [...detail.decisions]
        .reverse()
        .find((candidate) => candidate.status === "accepted");
    if (decision && decision.status !== "accepted") {
      throw new HttpError(409, "只有 Accepted 决策才能生成实施计划。");
    }
    if (!decision) {
      throw new HttpError(409, "只有 Accepted 决策才能生成实施计划。");
    }

    const controller = new AbortController();
    const abortOnDisconnect = (): void => {
      if (!response.writableEnded) {
        controller.abort(new Error("客户端已断开任务规划请求。"));
      }
    };
    response.once("close", abortOnDisconnect);
    try {
      const generated = await orchestration.generateWorkItemPlan({
        topicId: params.topicId,
        adapterId: input.adapterId,
        instruction: WORK_ITEM_PLANNING_INSTRUCTION,
        contextMessage: formatWorkItemPlanningContext(decision, detail.workItems),
        signal: controller.signal,
      });
      const latestDetail = database.getTopicDetail(
        params.topicId,
        config.defaultMessageLimit,
      );
      const latestDecision = latestDetail.decisions.find(
        (candidate) => candidate.id === decision.id,
      );
      if (latestDecision?.id !== decision.id) {
        throw new HttpError(409, "AI 规划期间 Accepted 决策已变化，请重新生成。");
      }
      let items;
      try {
        items = parseWorkItemPlan(
          generated.content,
          latestDetail.workItems.map((item) => item.title),
        );
      } catch (error) {
        throw new HttpError(
          502,
          error instanceof Error ? error.message : "AI 返回的任务草案无法解析。",
        );
      }
      if (items.length === 0) {
        sendSuccess(response, [], "AI 未发现需要补充的新任务。");
        return;
      }
      const workItems = database.createWorkItemsAsActor({
        topicId: params.topicId,
        decisionId: decision.id,
        items,
        actorId: generated.actorId,
      });
      sendSuccess(response, workItems, `AI 已生成 ${String(workItems.length)} 个实施任务。`, 201);
    } finally {
      response.off("close", abortOnDisconnect);
    }
  });

  app.put("/api/v1/topics/:topicId/work-items/:workItemId", (request, response) => {
    const params = parse(workItemParamsSchema, request.params);
    const input = parse(updateWorkItemBodySchema, request.body);
    const workItem = database.updateWorkItemAsActor({
      topicId: params.topicId,
      workItemId: params.workItemId,
      status: input.status,
      expectedVersion: input.expectedVersion,
      ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
      ...(input.fixCommit !== undefined ? { fixCommit: input.fixCommit } : {}),
      actorId: "human",
    });
    sendSuccess(response, workItem, "实施进度已更新。");
  });

  app.post("/api/v1/topics/:topicId/work-items/:workItemId/claim", (request, response) => {
    const params = parse(workItemParamsSchema, request.params);
    const input = parse(claimWorkItemBodySchema, request.body);
    const workItem = database.claimWorkItemAsActor({
      topicId: params.topicId,
      workItemId: params.workItemId,
      expectedVersion: input.expectedVersion,
      ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
      actorId: "human",
    });
    sendSuccess(response, workItem, "实施项已认领。");
  });

  app.get("/api/v1/topics/:topicId/work-attention", (request, response) => {
    if (!orchestration) throw new HttpError(503, "待处理服务未启用。");
    const { topicId } = parse(topicParamsSchema, request.params);
    sendSuccess(response, orchestration.attention.list(database.getTopic(topicId).projectPath));
  });

  app.get("/api/v1/topics/:topicId/runtime-audit", (request, response) => {
    if (!orchestration) throw new HttpError(503, "运行审计服务未启用。");
    const { topicId } = parse(topicParamsSchema, request.params);
    database.getTopic(topicId);
    const query = parse(runtimeAuditQuerySchema, request.query);
    sendSuccess(response, orchestration.audit.list(topicId, query.sourceKind, query.sourceId, query.after));
  });

  app.get("/api/v1/topics/:topicId/work-item-delegations", (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "任务委派服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    sendSuccess(response, orchestration.listWorkItemDelegations(params.topicId));
  });

  app.post("/api/v1/topics/:topicId/work-items/:workItemId/delegations", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "任务委派服务未启用。");
    }
    const params = parse(workItemParamsSchema, request.params);
    const input = parse(startWorkItemDelegationBodySchema, request.body);
    const delegation = await orchestration.startWorkItemDelegation({
      topicId: params.topicId,
      workItemId: params.workItemId,
      expectedVersion: input.expectedVersion,
      supervisorAgentId: input.supervisorAgentId,
      executorAgentId: input.executorAgentId,
      requestedPermission: input.requestedPermission,
      ...(input.completionPolicy ? { completionPolicy: input.completionPolicy } : {}),
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(input.createInitialBaseline !== undefined
        ? { createInitialBaseline: input.createInitialBaseline }
        : {}),
    });
    sendSuccess(response, delegation, "Agent 委派已进入后台执行。", 202);
  });

  app.post("/api/v1/topics/:topicId/work-item-delegations/actions/start-batch", (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "任务委派服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const input = parse(startWorkItemDelegationBatchBodySchema, request.body);
    const delegations = orchestration.startWorkItemDelegationBatch({
      topicId: params.topicId,
      workItems: input.workItems,
      supervisorAgentId: input.supervisorAgentId,
      executorAgentId: input.executorAgentId,
      requestedPermission: input.requestedPermission,
      ...(input.completionPolicy ? { completionPolicy: input.completionPolicy } : {}),
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(input.createInitialBaseline !== undefined
        ? { createInitialBaseline: input.createInitialBaseline }
        : {}),
    });
    sendSuccess(response, delegations, "一键委派已进入串行执行队列。", 202);
  });

  app.post("/api/v1/work-item-delegations/:delegationId/actions/resume", async (request, response) => {
    if (!orchestration) throw new HttpError(503, "任务委派服务未启用。");
    const params = parse(delegationParamsSchema, request.params);
    const input = parse(resumeDelegationBodySchema, request.body);
    sendSuccess(response, await orchestration.resumeWorkItemDelegation(params.delegationId, input.expectedVersion, input.requestedPermission), "已创建接续任务。", 202);
  });

  app.post("/api/v1/work-item-delegations/:delegationId/actions/cancel", (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "任务委派服务未启用。");
    }
    const params = parse(delegationParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    sendSuccess(
      response,
      orchestration.cancelWorkItemDelegation(params.delegationId),
      "Agent 委派已取消。",
    );
  });
}
