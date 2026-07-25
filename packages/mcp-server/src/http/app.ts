/**
 * @input  依赖：CouncilDatabase、Model Router、HTTP 配置、Express 安全中间件与 Zod schema
 * @output 导出：含 schema ready、模型路由、内容/编排 REST 与 SSE 的应用工厂
 * @pos    WebUI 与桌面壳访问 canonical 数据、Provider/Agent 路由和运行状态的 HTTP 入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import {
  LeaseConflictError,
  LeaseLostError,
  OrchestrationConfigError,
  RunNotFoundError,
  RunStateConflictError,
  RunBusyError,
  StoreConflictError,
} from "council-orchestrator";
import { z } from "zod/v4";
import { CouncilDatabase } from "../database.js";
import {
  CouncilConflictError,
  CouncilNotFoundError,
  CouncilValidationError,
} from "../errors.js";
import { logger } from "../logger.js";
import { ModelRouterPublicError } from "../model-router-service.js";
import { normalizeProjectPath } from "../project-path.js";
import type { CouncilOrchestrationService } from "../orchestration/service.js";
import { COUNCIL_SCHEMA_VERSION } from "../schema-migrator.js";
import type { CouncilHttpConfig } from "../types.js";
import { HttpError, sendError, sendSuccess, validationIssues } from "./responses.js";
import { RevisionEventStream } from "./revision-stream.js";
import {
  agentParamsSchema,
  createAgentBodySchema,
  createDecisionBodySchema,
  createMessageBodySchema,
  createProviderBodySchema,
  createTopicBodySchema,
  approveRunBodySchema,
  createRunBodySchema,
  emptyActionBodySchema,
  eventsQuerySchema,
  listRunsQuerySchema,
  listTopicsQuerySchema,
  providerParamsSchema,
  runParamsSchema,
  topicDetailQuerySchema,
  topicParamsSchema,
  updateAgentBodySchema,
  updateProviderBodySchema,
} from "./schemas.js";

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, "请求参数校验失败。", validationIssues(result.error.issues));
  }
  return result.data;
}

function rethrowModelRouterError(error: unknown): never {
  if (error instanceof ModelRouterPublicError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

function createCorsMiddleware(
  allowedOrigins: ReadonlySet<string>,
  maxAgeSeconds: number,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.header("origin");
    if (!origin) {
      next();
      return;
    }
    const parsedOrigin = z.string().url().safeParse(origin);
    if (!parsedOrigin.success || !allowedOrigins.has(parsedOrigin.data)) {
      next(new HttpError(403, "请求来源不在 CORS 白名单中。"));
      return;
    }

    response.vary("Origin");
    response.set({
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": parsedOrigin.data,
      "Access-Control-Max-Age": String(maxAgeSeconds),
    });
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  };
}

function isBodyParserError(error: unknown): error is { status: number; type?: string } {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { status?: unknown; type?: unknown };
  return typeof candidate.status === "number";
}

function createErrorMiddleware(): ErrorRequestHandler {
  return (error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof HttpError) {
      sendError(response, error.status, error.publicMessage, error.issues);
      return;
    }
    if (error instanceof CouncilNotFoundError) {
      sendError(response, 404, error.message);
      return;
    }
    if (error instanceof CouncilConflictError) {
      sendError(response, 409, error.message);
      return;
    }
    if (error instanceof CouncilValidationError) {
      sendError(response, 400, error.message);
      return;
    }
    if (error instanceof OrchestrationConfigError) {
      sendError(response, 400, error.message);
      return;
    }
    if (error instanceof RunNotFoundError) {
      sendError(response, 404, "请求的编排资源不存在。");
      return;
    }
    if (error instanceof RunStateConflictError) {
      sendError(response, 409, error.message);
      return;
    }
    if (
      error instanceof RunBusyError ||
      error instanceof StoreConflictError ||
      error instanceof LeaseConflictError ||
      error instanceof LeaseLostError
    ) {
      sendError(response, 409, "运行状态或并发版本已变化，请刷新后重试。");
      return;
    }
    if (isBodyParserError(error)) {
      const status = error.status === 413 || error.type === "entity.too.large" ? 413 : 400;
      sendError(
        response,
        status,
        status === 413 ? "请求体超过允许大小。" : "请求体不是合法 JSON。",
      );
      return;
    }
    logger.error("http-api", "未处理的 HTTP 请求错误", error);
    sendError(response, 500, "服务器内部错误。");
  };
}

export interface CouncilHttpAppBundle {
  app: express.Express;
  events: RevisionEventStream;
}

export function createCouncilHttpApp(
  config: CouncilHttpConfig,
  database: CouncilDatabase,
  orchestration?: CouncilOrchestrationService,
): CouncilHttpAppBundle {
  const app = express();
  const events = new RevisionEventStream(
    database,
    config.eventPollMs,
    config.eventRetryMs,
    config.eventHeartbeatMs,
    orchestration?.progressHub,
  );

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(createCorsMiddleware(new Set(config.allowedOrigins), config.corsMaxAgeSeconds));
  app.use(
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: (request) => request.method === "OPTIONS",
      handler: (_request, response) => {
        sendError(response, 429, "请求过于频繁，请稍后再试。");
      },
    }),
  );
  app.use(express.json({ limit: config.bodyLimitBytes, strict: true }));

  app.get("/api/v1/status", (_request, response) => {
    const revisions = database.getRevisions();
    sendSuccess(response, {
      ready: true,
      schemaVersion: COUNCIL_SCHEMA_VERSION,
      databaseInstanceId: database.getDatabaseInstanceId(),
      ...database.getCounts(),
      revision: revisions.total,
      revisions: {
        content: revisions.content,
        orchestration: revisions.orchestration,
      },
    });
  });

  app.get("/api/v1/orchestration/capabilities", async (_request, response) => {
    sendSuccess(
      response,
      (await orchestration?.capabilitiesFresh()) ?? {
        adapters: [],
        defaultPolicy: {
          maxRounds: config.orchestrationDefaultMaxRounds,
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

  app.post("/api/v1/settings/agents/:agentId/actions/test", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "模型路由服务未启用。");
    }
    const params = parse(agentParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    try {
      sendSuccess(response, await orchestration.testAgent(params.agentId), "连接测试通过。");
    } catch {
      throw new HttpError(502, "连接测试失败，请检查模型、额度、API 地址或凭据。");
    }
  });

  app.get("/api/v1/topics", (request, response) => {
    const query = parse(listTopicsQuerySchema, request.query);
    const result = database.listTopics({
      ...(query.projectPath
        ? { projectPath: normalizeProjectPath(query.projectPath) }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      limit: query.limit ?? config.defaultMessageLimit,
      offset: query.offset,
    });
    sendSuccess(response, result);
  });

  app.get("/api/v1/topics/:topicId", (request, response) => {
    const params = parse(topicParamsSchema, request.params);
    const query = parse(topicDetailQuerySchema, request.query);
    const detail = database.getTopicDetail(
      params.topicId,
      query.messageLimit ?? config.defaultMessageLimit,
      query.messageOffset,
    );
    sendSuccess(response, detail);
  });

  app.post("/api/v1/topics", (request, response) => {
    const body: unknown = request.body;
    const input = parse(createTopicBodySchema, body);
    const projectPath = normalizeProjectPath(input.projectPath);
    const topic = database.createTopicAsActor({
      title: input.title,
      question: input.question,
      constraints: input.constraints,
      ...(projectPath ? { projectPath } : {}),
      actorId: "human",
    });
    sendSuccess(response, topic, "议题已创建。", 201);
  });

  app.post("/api/v1/topics/:topicId/messages", (request, response) => {
    const params = parse(topicParamsSchema, request.params);
    const body: unknown = request.body;
    const input = parse(createMessageBodySchema, body);
    const message = database.createMessageAsActor({
      topicId: params.topicId,
      actorId: "human",
      kind: input.kind,
      content: input.content,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    });
    sendSuccess(response, message, "消息已发布。", 201);
  });

  app.post("/api/v1/topics/:topicId/decisions", (request, response) => {
    const params = parse(topicParamsSchema, request.params);
    const body: unknown = request.body;
    const input = parse(createDecisionBodySchema, body);
    const decision = database.createDecisionAsActor({
      topicId: params.topicId,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale,
      alternatives: input.alternatives,
      status: input.status,
      actorId: "human",
    });
    sendSuccess(response, decision, "决策已记录。", 201);
  });

  app.get("/api/v1/topics/:topicId/runs", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const query = parse(listRunsQuerySchema, request.query);
    const page = await orchestration.listRuns(
      params.topicId,
      query.limit ?? config.orchestrationRunPageLimit,
      query.offset,
    );
    sendSuccess(response, page);
  });

  app.get("/api/v1/runs/:runId", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(runParamsSchema, request.params);
    sendSuccess(response, await orchestration.getRun(params.runId));
  });

  app.post("/api/v1/topics/:topicId/runs", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const body: unknown = request.body;
    const input = parse(createRunBodySchema, body);
    const run = await orchestration.createRun(params.topicId, input.plan, {
      confirmationBeforeCompletion: input.confirmationBeforeCompletion,
    });
    sendSuccess(response, run, "编排运行已创建。", 201);
  });

  app.post("/api/v1/runs/:runId/actions/start", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(runParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    const run = await orchestration.start(params.runId);
    sendSuccess(response, run, "编排运行已进入后台执行。", 202);
  });

  app.post("/api/v1/runs/:runId/approvals", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(runParamsSchema, request.params);
    const body: unknown = request.body;
    const input = parse(approveRunBodySchema, body);
    const result = await orchestration.approve(params.runId, input);
    sendSuccess(
      response,
      result,
      result.applied ? "批准已应用，运行进入后台执行。" : "批准请求已处理过。",
      result.applied ? 202 : 200,
    );
  });

  app.post("/api/v1/runs/:runId/actions/cancel", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(runParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    const run = await orchestration.cancel(params.runId);
    sendSuccess(response, run, "编排运行已取消。", 200);
  });

  app.post("/api/v1/runs/:runId/actions/recover", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(runParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    const run = await orchestration.recover(params.runId);
    sendSuccess(response, run, "编排恢复已进入后台执行。", 202);
  });

  app.get("/api/v1/events", (request, response) => {
    parse(eventsQuerySchema, request.query);
    events.handle(request, response);
  });

  app.use((_request, response) => {
    sendError(response, 404, "接口不存在。");
  });
  app.use(createErrorMiddleware());

  return { app, events };
}
