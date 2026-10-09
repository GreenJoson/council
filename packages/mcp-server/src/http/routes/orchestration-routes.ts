/**
 * @input  依赖：HttpRouteContext（HTTP 配置、CouncilDatabase、可选编排服务）、RuntimeBinding 脱敏辅助、Zod schema 与统一响应
 * @output 导出：注册 RuntimeBinding 列表/关闭/重开、编排运行创建/查询/启动/批准/取消/恢复、圆桌周期指标与开始/放弃/作答/提交修复 REST 的 registerOrchestrationRoutes
 * @pos    WebUI 驱动多 Agent 编排与圆桌讨论生命周期的 HTTP 路由模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Express } from "express";
import { HttpError, sendSuccess } from "../responses.js";
import {
  answerCycleQuestionBodySchema,
  approveRunBodySchema,
  createRunBodySchema,
  emptyActionBodySchema,
  listRunsQuerySchema,
  listRuntimeBindingsQuerySchema,
  runParamsSchema,
  runtimeBindingParamsSchema,
  startCycleBodySchema,
  submitFixesBodySchema,
  topicParamsSchema,
} from "../schemas.js";
import { parse, publicRuntimeBinding, type HttpRouteContext } from "./context.js";

export function registerOrchestrationRoutes(app: Express, context: HttpRouteContext): void {
  const { config, database, orchestration } = context;

  app.get("/api/v1/topics/:topicId/runtime-bindings", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const query = parse(listRuntimeBindingsQuerySchema, request.query);
    sendSuccess(
      response,
      (await orchestration.listRuntimeBindings(params.topicId, query.includeClosed))
        .map(publicRuntimeBinding),
    );
  });

  app.post("/api/v1/runtime-bindings/:bindingId/actions/close", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(runtimeBindingParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    sendSuccess(
      response,
      publicRuntimeBinding(await orchestration.closeRuntimeBinding(params.bindingId)),
      "持久会话已关闭。",
    );
  });

  app.post("/api/v1/runtime-bindings/:bindingId/actions/reopen", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(runtimeBindingParamsSchema, request.params);
    parse(emptyActionBodySchema, request.body ?? {});
    sendSuccess(
      response,
      publicRuntimeBinding(await orchestration.reopenRuntimeBinding(params.bindingId)),
      "持久会话已重新打开。",
      201,
    );
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

  app.get("/api/v1/orchestration/cycle-metrics", (_request, response) => {
    sendSuccess(response, database.getCycleMetrics());
  });

  app.get("/api/v1/topics/:topicId/cycle", (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const view = orchestration.readCycle(params.topicId);
    sendSuccess(response, view ?? null);
  });

  app.get("/api/v1/topics/:topicId/cycle/latest", (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const view = orchestration.readLatestCycle(params.topicId);
    sendSuccess(response, view ?? null);
  });

  app.post("/api/v1/topics/:topicId/cycle", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const input = parse(startCycleBodySchema, request.body);
    const view = await orchestration.startCycle({
      topicId: params.topicId,
      participants: input.participants,
      ...(input.roundBudget === undefined ? {} : { roundBudget: input.roundBudget }),
      kind: input.kind
        ?? (input.reviewScope === "commit" || input.requiresCommitRef
          ? "fix_review"
          : "discussion"),
      reviewScope: input.reviewScope
        ?? (input.kind === "fix_review" || input.requiresCommitRef
          ? "commit"
          : "discussion"),
      ...(input.taskRequirements === undefined
        ? {}
        : { taskRequirements: input.taskRequirements }),
    });
    const reusedProposal = view.cycle.turns.some((turn) => turn.stage === "proposal");
    sendSuccess(
      response,
      view,
      reusedProposal
        ? "圆桌讨论已复用现有提案，首位评审正在审核。"
        : "圆桌讨论已开始，提案人正在发言。",
      201,
    );
  });

  app.delete("/api/v1/topics/:topicId/cycle", (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const view = orchestration.abandonCycle(params.topicId);
    sendSuccess(response, view ?? null, "圆桌讨论已放弃。");
  });

  app.post("/api/v1/topics/:topicId/cycle/answers", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const input = parse(answerCycleQuestionBodySchema, request.body);
    const humanActorId = database.resolveActorAlias("human").actorId;
    // 回答必须以公开消息的形式留在讨论流里，否则后面没人能复查这个前提是谁给的。
    // 幂等靠 parent_message_id 认领：重试时先找回已发出的那条，不会重复发帖。
    const existing = database.findReplyBy(input.questionMessageId, humanActorId);
    const answer = existing ?? database.createMessageAsActor({
      topicId: params.topicId,
      actorId: "human",
      kind: "note",
      content: input.content,
      parentMessageId: input.questionMessageId,
    });
    const view = await orchestration.answerCycleQuestion({
      topicId: params.topicId,
      questionMessageId: input.questionMessageId,
      answerMessageId: answer.id,
    });
    sendSuccess(response, view ?? null, "回答已记录，讨论继续。", 202);
  });

  app.post("/api/v1/topics/:topicId/cycle/fixes", async (request, response) => {
    if (!orchestration) {
      throw new HttpError(503, "编排服务未启用。");
    }
    const params = parse(topicParamsSchema, request.params);
    const input = parse(submitFixesBodySchema, request.body ?? {});
    // 修复自述必须留在公开讨论里：复审者读的是这条消息里的 commit，
    // 只在服务端内存里传一次的话，下一轮谁也说不清审的是哪份 diff。
    if (input.targets && input.summary) {
      database.createMessageAsActor({
        topicId: params.topicId,
        actorId: "human",
        kind: "note",
        content: [
          "已提交一批修复，请复审。",
          "",
          "```council-fix",
          JSON.stringify({ targets: input.targets, summary: input.summary }),
          "```",
        ].join("\n"),
      });
    }
    const view = await orchestration.submitFixes({ topicId: params.topicId });
    sendSuccess(response, view ?? null, "修复已提交，复审开始。", 202);
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
}
