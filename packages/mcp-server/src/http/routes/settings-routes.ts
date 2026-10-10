/**
 * @input  依赖：HttpRouteContext（HTTP 配置、可选编排服务）、Model Router 公开错误、Zod schema 与统一响应
 * @output 导出：注册编排能力探测与 Provider/Agent 设置（增删改、模型列表、连接诊断）REST 的 registerSettingsRoutes
 * @pos    WebUI 设置页访问 Model Router 配置与编排能力的 HTTP 路由模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Express } from "express";
import { ModelRouterPublicError } from "../../model-router-service.js";
import { HttpError, sendSuccess } from "../responses.js";
import {
  agentParamsSchema,
  createAgentBodySchema,
  createProviderBodySchema,
  emptyActionBodySchema,
  providerParamsSchema,
  updateAgentBodySchema,
  updateProviderBodySchema,
} from "../schemas.js";
import { parse, rethrowModelRouterError, type HttpRouteContext } from "./context.js";

export function registerSettingsRoutes(app: Express, context: HttpRouteContext): void {
  const { config, orchestration } = context;

  app.get("/api/v1/orchestration/capabilities", async (_request, response) => {
    sendSuccess(
      response,
      (await orchestration?.capabilitiesFresh()) ?? {
        adapters: [],
        defaultPolicy: {
          maxRounds: config.orchestrationDefaultMaxRounds,
          agentIdleTimeoutMs: config.orchestrationDefaultAgentIdleTimeoutMs,
          agentTimeoutMs: config.orchestrationDefaultAgentTimeoutMs,
          maxAttemptsPerRound: config.orchestrationDefaultMaxAttempts,
          maxManualRecoveries: config.orchestrationDefaultMaxRecoveries,
          confirmation: {
            beforeRounds: [],
            beforeCompletion: config.orchestrationConfirmCompletion,
          },
        },
        limitations: ["编排服务未启用。"],
      },
    );
  });

  app.get("/api/v1/settings/model-router", async (_request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    sendSuccess(response, await orchestration.getModelRouter());
  });

  app.post("/api/v1/settings/providers", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const input = parse(createProviderBodySchema, request.body);
    try {
      sendSuccess(response, await orchestration.createProvider(input), "Provider 已添加。", 201);
    } catch (error) {
      rethrowModelRouterError(error);
    }
  });

  app.put("/api/v1/settings/providers/:providerId", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const params = parse(providerParamsSchema, request.params);
    const input = parse(updateProviderBodySchema, request.body);
    try {
      sendSuccess(response, await orchestration.updateProvider(params.providerId, input), "Provider 已保存。");
    } catch (error) {
      rethrowModelRouterError(error);
    }
  });

  app.delete("/api/v1/settings/providers/:providerId", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const params = parse(providerParamsSchema, request.params);
    try {
      sendSuccess(response, await orchestration.removeProvider(params.providerId), "Provider 已移除。");
    } catch (error) {
      rethrowModelRouterError(error);
    }
  });

  app.post("/api/v1/settings/agents", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const input = parse(createAgentBodySchema, request.body);
    try {
      sendSuccess(response, await orchestration.createAgent(input), "Agent 已添加。", 201);
    } catch (error) {
      rethrowModelRouterError(error);
    }
  });

  app.put("/api/v1/settings/agents/:agentId", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const params = parse(agentParamsSchema, request.params);
    const input = parse(updateAgentBodySchema, request.body);
    try {
      sendSuccess(response, await orchestration.updateAgent(params.agentId, input), "Agent 已保存。");
    } catch (error) {
      rethrowModelRouterError(error);
    }
  });

  app.delete("/api/v1/settings/agents/:agentId", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const params = parse(agentParamsSchema, request.params);
    try {
      sendSuccess(response, await orchestration.removeAgent(params.agentId), "Agent 已移除。");
    } catch (error) {
      rethrowModelRouterError(error);
    }
  });

  app.post("/api/v1/settings/providers/:providerId/actions/models", async (request, response) => {
    if (!orchestration) throw new HttpError(503, "模型路由服务未启用。");
    const params = parse(providerParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    try { sendSuccess(response, await orchestration.listProviderModels(params.providerId)); }
    catch (error) { rethrowModelRouterError(error); }
  });

  app.post("/api/v1/settings/agents/:agentId/actions/test", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const params = parse(agentParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    try {
      sendSuccess(response, await orchestration.testAgent(params.agentId), "连接诊断已完成。");
    } catch (error) {
      if (error instanceof ModelRouterPublicError) rethrowModelRouterError(error);
      throw new HttpError(502, "连接诊断失败，请检查运行时配置。");
    }
  });
}
