/**
 * @input  依赖：McpToolContext（回环 HTTP 基址与转发超时）、Zod、共享常量、模板枚举、tool-support 共享件与全局 fetch
 * @output 导出：registerPipelineTools，注册 council_start_pipeline / council_get_pipeline
 * @pos    P3 流水线的 MCP 入口：stdio MCP 进程不持有流水线驱动器与委派管理器，两个工具都转发到同机 HTTP 服务
 *         （/api/v1/pipelines），避免两个进程各自推进同一条流水线；brief 确认、选终稿等人工节点在 WebUI 完成
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import { z } from "zod/v4";
import { MAX_ID_CHARS, MAX_PATH_CHARS } from "../../constants.js";
import { CouncilValidationError } from "../../errors.js";
import { PIPELINE_DOCUMENT_LIMITS } from "../../pipelines/pipeline-document.js";
import type { PipelineDetail } from "../../pipelines/pipeline-service.js";
import { PIPELINE_TEMPLATE_IDS } from "../../pipelines/templates.js";
import type { McpCouncilConfig } from "../../types.js";
import type { McpToolContext } from "../tool-context.js";
import { executeTool, success } from "../tool-support.js";

type ForwardConfig = Pick<McpCouncilConfig, "httpServiceUrl" | "httpForwardTimeoutMs">;

interface Envelope {
  message?: unknown;
  data?: unknown;
}

const pipelineIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^work_item_[A-Za-z0-9-]+$/, "pipeline_id 格式无效")
  .describe("流水线 ID（即父任务 ID，work_item_<uuid>）");
const projectPathField = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((value) => path.isAbsolute(value), "project_path 必须是绝对路径")
  .describe("项目根目录的绝对路径");

/**
 * 转发到同机 HTTP 服务。4xx 文案是 HTTP 服务的公开错误，原样返回；5xx 不透传内部细节（503 例外：它本身就是可执行提示）。
 */
async function forward(config: ForwardConfig, method: "GET" | "POST", route: string, body?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${config.httpServiceUrl}${route}`, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(config.httpForwardTimeoutMs),
    });
  } catch {
    throw new CouncilValidationError(
      "流水线需要本机 Council HTTP 服务（桌面 app 或 start:http）在运行；当前无法连接，请启动后重试。",
    );
  }
  let envelope: Envelope = {};
  try {
    envelope = await response.json() as Envelope;
  } catch {
    // 非 JSON 响应按状态码给出通用说明。
  }
  if (!response.ok) {
    const message = typeof envelope.message === "string" ? envelope.message : "";
    if (response.status < 500 && message) throw new CouncilValidationError(message);
    throw new CouncilValidationError(
      response.status === 503 && message ? message : `流水线服务返回错误（HTTP ${String(response.status)}），请查看本地服务日志。`,
    );
  }
  return envelope.data;
}

function formatPipeline(detail: PipelineDetail): string {
  const { task, document } = detail;
  const stages = document.stages
    .map((stage) => `${stage.id}:${stage.status}${stage.error ? `(${stage.error.code})` : ""}`)
    .join(" → ");
  return [
    `流水线 ${task.id}（v${String(task.version)}）${task.title}`,
    `模板 ${document.template}，任务状态 ${task.status}${document.status === "cancelled" ? "，已取消" : ""}`,
    `当前阶段 ${document.currentStageId}；${stages}`,
    `子任务 ${String(detail.children.length)} 个，图像产物 ${String(detail.outputAssetIds.length)} 张`,
    ...(document.notice ? [`说明：${document.notice}`] : []),
  ].join("\n");
}

export function registerPipelineTools(context: McpToolContext): void {
  const { server, config } = context;

  server.registerTool(
    "council_start_pipeline",
    {
      title: "启动设计流水线",
      description:
        "按模板在指定项目下启动一条设计流水线：brief → 生图 → 复盘（自动修订）→ 人工选定终稿 →（app-mockup 还有）原型实现。"
        + "启动后后台立即撰写 brief，brief 确认与终稿选择在 WebUI 完成；需要本机 Council HTTP 服务在运行。",
      inputSchema: {
        project_path: projectPathField,
        template: z.enum(PIPELINE_TEMPLATE_IDS).describe("app-mockup / game-asset-pack / concept-sheet"),
        goal: z.string().min(1).max(PIPELINE_DOCUMENT_LIMITS.maxGoal).describe("要产出什么、给谁用"),
        constraints: z
          .array(z.string().min(1).max(PIPELINE_DOCUMENT_LIMITS.maxConstraint))
          .max(PIPELINE_DOCUMENT_LIMITS.maxConstraints)
          .optional(),
        reference_asset_ids: z
          .array(z.string().min(1).max(MAX_ID_CHARS))
          .max(PIPELINE_DOCUMENT_LIMITS.maxReferences)
          .optional()
          .describe("同项目资产库中的参考图"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_path, template, goal, constraints, reference_asset_ids }) =>
      await executeTool("council_start_pipeline", async () => {
        const data = await forward(config, "POST", "/api/v1/pipelines", {
          project: project_path,
          template,
          goal,
          ...(constraints ? { constraints } : {}),
          ...(reference_asset_ids ? { referenceAssetIds: reference_asset_ids } : {}),
        }) as { pipeline: PipelineDetail };
        return success(`已启动。\n${formatPipeline(data.pipeline)}`, data);
      }),
  );

  server.registerTool(
    "council_get_pipeline",
    {
      title: "查看设计流水线",
      description: "读取流水线详情：阶段进度、brief/复盘记录、子任务与图像产物 ID。",
      inputSchema: { pipeline_id: pipelineIdField },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pipeline_id }) =>
      await executeTool("council_get_pipeline", async () => {
        const detail = await forward(config, "GET", `/api/v1/pipelines/${encodeURIComponent(pipeline_id)}`) as PipelineDetail;
        return success(formatPipeline(detail), { pipeline: detail });
      }),
  );
}
