/**
 * @input  依赖：Zod、council-orchestrator RuntimeBinding、CouncilDatabase、编排服务、HTTP 配置、项目文件预览服务、HTML 页面视图端口与 Model Router 公开错误
 * @output 导出：路由模块共享的 HttpRouteContext 依赖包，以及 parse / publicRuntimeBinding / rethrowModelRouterError 共享辅助
 * @pos    http/app.ts 与各路由模块之间的依赖注入契约，共享校验与脱敏辅助的单一真源
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { RuntimeBinding } from "council-orchestrator";
import type { z } from "zod/v4";
import type { CouncilDatabase } from "../../database.js";
import { ModelRouterPublicError } from "../../model-router-service.js";
import type { CouncilOrchestrationService } from "../../orchestration/service.js";
import type { ProjectFilePreviewService } from "../../project-file-preview.js";
import type { ProjectFileViewServer } from "../../project-file-view.js";
import type { CouncilHttpConfig } from "../../types.js";
import { HttpError, validationIssues } from "../responses.js";

// 路由模块只拿这一个依赖包，不各自从 app.ts 的闭包里捞变量。
// orchestration 为可选：各路由对缺失的处理方式（503 文案或静默跳过）由路由自身决定。
export interface HttpRouteContext {
  config: CouncilHttpConfig;
  database: CouncilDatabase;
  orchestration?: CouncilOrchestrationService;
  projectFiles: ProjectFilePreviewService;
  fileView: ProjectFileViewServer;
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, "请求参数校验失败。", validationIssues(result.error.issues));
  }
  return result.data;
}

export function publicRuntimeBinding(binding: RuntimeBinding): object {
  return {
    id: binding.id,
    topicId: binding.topicId,
    agentId: binding.agentId,
    actorId: binding.actorId,
    providerId: binding.providerId,
    transportKind: binding.transportKind,
    status: binding.status,
    hasSession: Boolean(binding.sessionId),
    stateVersion: binding.stateVersion,
    lastActivityAt: binding.lastActivityAt,
    ...(binding.closeReason ? { closeReason: binding.closeReason } : {}),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    ...(binding.closedAt ? { closedAt: binding.closedAt } : {}),
  };
}

export function rethrowModelRouterError(error: unknown): never {
  if (error instanceof ModelRouterPublicError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}
