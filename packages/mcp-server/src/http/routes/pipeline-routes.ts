/**
 * @input  依赖：HttpRouteContext（可选编排服务上挂载的 PipelineService）、Zod schema 与统一响应
 * @output 导出：注册 P3 流水线 REST（创建、按项目列表、详情、确认 brief、选定终稿、恢复失败阶段、取消）的 registerPipelineRoutes
 * @pos    /api/v1/pipelines：流水线的唯一 HTTP 入口；只做协议适配，阶段语义与错误码在 pipelines/PipelineService
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Express } from "express";
import type { PipelineService } from "../../pipelines/pipeline-service.js";
import { HttpError, sendSuccess } from "../responses.js";
import {
  confirmPipelineBriefBodySchema,
  createPipelineBodySchema,
  listPipelinesQuerySchema,
  pipelineParamsSchema,
  pipelineVersionBodySchema,
  selectPipelineFinalBodySchema,
} from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

// 人工操作统一以 human 身份写入；Agent 写入由驱动器按执行者 actor 记录。
const HUMAN_ACTOR = "human";

export function registerPipelineRoutes(app: Express, context: HttpRouteContext): void {
  // 流水线依赖本地 Agent（brief/复盘的一次性调用与委派）；编排服务未启用时整组路由 503。
  const requirePipelines = (): PipelineService => {
    const pipelines = context.orchestration?.pipelines;
    if (!pipelines) throw new HttpError(503, "流水线需要本地 Agent 服务，当前未启用。");
    return pipelines;
  };

  app.post("/api/v1/pipelines", async (request, response) => {
    const pipelines = requirePipelines();
    const input = parse(createPipelineBodySchema, request.body);
    const pipeline = await pipelines.create({
      projectPath: input.project,
      template: input.template,
      goal: input.goal,
      ...(input.constraints ? { constraints: input.constraints } : {}),
      ...(input.referenceAssetIds ? { referenceAssetIds: input.referenceAssetIds } : {}),
      ...(input.agents ? { agents: input.agents } : {}),
      actorId: HUMAN_ACTOR,
    });
    sendSuccess(response, { pipeline }, "流水线已创建。", 201);
  });

  app.get("/api/v1/pipelines", (request, response) => {
    const pipelines = requirePipelines();
    const query = parse(listPipelinesQuerySchema, request.query);
    sendSuccess(response, { items: pipelines.list(query.project) });
  });

  app.get("/api/v1/pipelines/:pipelineId", (request, response) => {
    const pipelines = requirePipelines();
    const { pipelineId } = parse(pipelineParamsSchema, request.params);
    sendSuccess(response, pipelines.get(pipelineId));
  });

  app.post("/api/v1/pipelines/:pipelineId/brief", async (request, response) => {
    const pipelines = requirePipelines();
    const { pipelineId } = parse(pipelineParamsSchema, request.params);
    const input = parse(confirmPipelineBriefBodySchema, request.body);
    sendSuccess(response, await pipelines.confirmBrief({
      pipelineId,
      brief: input.brief,
      expectedVersion: input.expectedVersion,
      actorId: HUMAN_ACTOR,
    }), "brief 已确认，开始生图。");
  });

  app.post("/api/v1/pipelines/:pipelineId/final", async (request, response) => {
    const pipelines = requirePipelines();
    const { pipelineId } = parse(pipelineParamsSchema, request.params);
    const input = parse(selectPipelineFinalBodySchema, request.body);
    sendSuccess(response, await pipelines.selectFinal({
      pipelineId,
      assetIds: input.assetIds,
      expectedVersion: input.expectedVersion,
      actorId: HUMAN_ACTOR,
    }), "终稿已选定。");
  });

  app.post("/api/v1/pipelines/:pipelineId/resume", async (request, response) => {
    const pipelines = requirePipelines();
    const { pipelineId } = parse(pipelineParamsSchema, request.params);
    const input = parse(pipelineVersionBodySchema, request.body);
    sendSuccess(response, await pipelines.resume({
      pipelineId,
      expectedVersion: input.expectedVersion,
      actorId: HUMAN_ACTOR,
    }), "已重跑失败阶段。");
  });

  app.post("/api/v1/pipelines/:pipelineId/cancel", async (request, response) => {
    const pipelines = requirePipelines();
    const { pipelineId } = parse(pipelineParamsSchema, request.params);
    const input = parse(pipelineVersionBodySchema, request.body);
    sendSuccess(response, await pipelines.cancel({
      pipelineId,
      expectedVersion: input.expectedVersion,
      actorId: HUMAN_ACTOR,
    }), "流水线已取消。");
  });
}
