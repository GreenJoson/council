/**
 * @input  依赖：HttpRouteContext（HTTP 配置中的 clientConfig）、client-config/ClientConfigService、Zod schema 与统一响应
 * @output 导出：注册客户端接入 REST（状态列表、写入、还原）的 registerClientConfigRoutes
 * @pos    /api/v1/settings/client-config：WebUI「客户端接入」面板访问配置分发的唯一 HTTP 入口；
 *         漂移未带 force、JSON 解析失败、手写冲突等经 CouncilConflictError 映射为 409
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Express } from "express";
import { ClientConfigService } from "../../client-config/client-config-service.js";
import { HttpError, sendSuccess } from "../responses.js";
import { applyClientConfigBodySchema, clientConfigParamsSchema } from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

export function registerClientConfigRoutes(app: Express, context: HttpRouteContext): void {
  const settings = context.config.clientConfig;
  // 测试夹具未注入时不回落到真实家目录，直接 503。
  const service = settings ? new ClientConfigService(settings) : undefined;
  const requireService = (): ClientConfigService => {
    if (!service) {
      throw new HttpError(503, "客户端接入服务未启用。");
    }
    return service;
  };

  app.get("/api/v1/settings/client-config", (_request, response) => {
    sendSuccess(response, { clients: requireService().status() });
  });

  app.post("/api/v1/settings/client-config/:client/actions/apply", (request, response) => {
    const { client } = parse(clientConfigParamsSchema, request.params);
    const body = parse(applyClientConfigBodySchema, request.body ?? {});
    sendSuccess(response, requireService().apply(client, { force: body.force }), "客户端配置已写入。");
  });

  app.post("/api/v1/settings/client-config/:client/actions/restore", (request, response) => {
    const { client } = parse(clientConfigParamsSchema, request.params);
    sendSuccess(response, requireService().restore(client), "客户端配置已还原。");
  });
}
