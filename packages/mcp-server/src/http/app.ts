/**
 * @input  依赖：CouncilDatabase、HTTP 配置、Express 安全中间件、Zod、RevisionEventStream、项目文件预览服务与 routes/ 下各路由模块
 * @output 导出：含 schema ready、服务停止、SSE 事件流，并按顺序挂载设置/议题/实施项/任务/资产/流水线/Worker 团队/编排路由模块与脱敏错误处理的应用工厂
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
  AgentInvocationError,
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
import { ProjectFilePreviewService } from "../project-file-preview.js";
import type { CouncilOrchestrationService } from "../orchestration/service.js";
import { COUNCIL_SCHEMA_VERSION } from "../schema-migrator.js";
import type { CouncilHttpConfig } from "../types.js";
import { HttpError, sendError, sendSuccess } from "./responses.js";
import { RevisionEventStream } from "./revision-stream.js";
import { eventsQuerySchema } from "./schemas.js";
import { parse, type HttpRouteContext } from "./routes/context.js";
import { registerSettingsRoutes } from "./routes/settings-routes.js";
import { registerTopicRoutes } from "./routes/topic-routes.js";
import { registerWorkItemRoutes } from "./routes/work-item-routes.js";
import { registerTaskRoutes } from "./routes/task-routes.js";
import { registerAssetRoutes } from "./routes/asset-routes.js";
import { registerPipelineRoutes } from "./routes/pipeline-routes.js";
import { registerTeamRoutes } from "./routes/team-routes.js";
import { registerOrchestrationRoutes } from "./routes/orchestration-routes.js";

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
    if (error instanceof AgentInvocationError) {
      sendError(response, 502, error.publicMessage ?? error.message);
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
  worker?: { snapshot: () => object; canStop: () => boolean; stop: () => void },
): CouncilHttpAppBundle {
  const app = express();
  const projectFiles = new ProjectFilePreviewService(config.filePreview);
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

  app.post("/api/v1/service/actions/stop", (request, response) => {
    const input = parse(z.object({ databaseInstanceId: z.string().min(1).max(128) }).strict(), request.body);
    if (!worker) throw new HttpError(409, "当前服务不支持后台生命周期控制。");
    if (input.databaseInstanceId !== database.getDatabaseInstanceId()) throw new HttpError(409, "服务数据库身份不匹配，拒绝停止。");
    if (!worker.canStop()) throw new HttpError(409, "后台仍有活动任务或请求，请先完成或取消后再停止服务。");
    sendSuccess(response, { stopping: true });
    // 同步停止接受新任务，避免检查空闲后又派发写入任务。
    worker.stop();
  });

  app.get("/api/v1/status", (_request, response) => {
    const revisions = database.getRevisions();
    sendSuccess(response, {
      ready: true,
      schemaVersion: COUNCIL_SCHEMA_VERSION,
      databaseInstanceId: database.getDatabaseInstanceId(),
      ...(worker ? { worker: worker.snapshot() } : {}),
      ...database.getCounts(),
      revision: revisions.total,
      revisions: {
        content: revisions.content,
        orchestration: revisions.orchestration,
      },
    });
  });

  // 路由模块的注册顺序与拆分前的内联顺序一致，Express 按注册顺序匹配。
  const context: HttpRouteContext = { config, database, orchestration, projectFiles };
  registerSettingsRoutes(app, context);
  registerTopicRoutes(app, context);
  registerWorkItemRoutes(app, context);
  registerTaskRoutes(app, context);
  registerAssetRoutes(app, context);
  registerPipelineRoutes(app, context);
  registerTeamRoutes(app, context);
  registerOrchestrationRoutes(app, context);

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
