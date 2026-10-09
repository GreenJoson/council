/**
 * @input  依赖：HttpRouteContext（HTTP 配置、CouncilDatabase、可选编排服务、项目文件预览服务）、项目路径规范化、Zod schema 与统一响应
 * @output 导出：注册议题列表/详情/创建/更正/关闭、项目文件只读预览、消息发布与决策记录/接受 REST 的 registerTopicRoutes
 * @pos    WebUI 与桌面壳访问议题 canonical 内容数据的 HTTP 路由模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Express } from "express";
import { z } from "zod/v4";
import { normalizeProjectPath } from "../../project-path.js";
import { sendSuccess } from "../responses.js";
import {
  acceptDecisionsBodySchema,
  createDecisionBodySchema,
  createMessageBodySchema,
  createTopicBodySchema,
  emptyActionBodySchema,
  listTopicsQuerySchema,
  topicDetailQuerySchema,
  topicParamsSchema,
  updateTopicBodySchema,
} from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

export function registerTopicRoutes(app: Express, context: HttpRouteContext): void {
  const { config, database, orchestration, projectFiles } = context;

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

  app.post("/api/v1/topics/:topicId/files/preview", async (request, response) => {
    const { topicId } = parse(topicParamsSchema, request.params);
    const input = parse(z.object({
      href: z.string().trim().min(1).max(4096),
      basePath: z.string().trim().min(1).max(4096).optional(),
    }).strict(), request.body);
    response.set("Cache-Control", "no-store");
    sendSuccess(response, await projectFiles.preview(database.getTopic(topicId).projectPath, input.href, input.basePath));
  });

  app.put("/api/v1/topics/:topicId", (request, response) => {
    const params = parse(topicParamsSchema, request.params);
    const input = parse(updateTopicBodySchema, request.body);
    const topic = database.updateTopicAsActor({
      topicId: params.topicId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.question !== undefined ? { question: input.question } : {}),
      ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
      expectedUpdatedAt: input.expectedUpdatedAt,
      actorId: "human",
    });
    sendSuccess(response, topic, "议题已更新。");
  });

  app.post("/api/v1/topics/:topicId/actions/close", async (request, response) => {
    const params = parse(topicParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    if (orchestration) {
      orchestration.abandonCycle(params.topicId);
      await orchestration.closeTopicRuntimeBindings(params.topicId, "topic-closed");
    }
    const topic = database.closeTopicAsActor({
      topicId: params.topicId,
      actorId: "human",
    });
    sendSuccess(response, topic, "议题已关闭，讨论历史仍被保留。");
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

  app.post("/api/v1/topics/:topicId/decisions", async (request, response) => {
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
    if (decision.status === "accepted" && orchestration) {
      await orchestration.closeTopicRuntimeBindings(params.topicId);
    }
    sendSuccess(response, decision, "决策已记录。", 201);
  });

  app.post("/api/v1/topics/:topicId/decisions/accept", async (request, response) => {
    const params = parse(topicParamsSchema, request.params);
    const input = parse(acceptDecisionsBodySchema, request.body);
    const decisions = database.acceptDecisionsAsActor({
      topicId: params.topicId,
      decisionIds: input.decisionIds,
      actorId: "human",
    });
    if (database.getTopic(params.topicId).status === "decided" && orchestration) {
      await orchestration.closeTopicRuntimeBindings(params.topicId);
    }
    sendSuccess(response, decisions, "决策已接受。");
  });
}
