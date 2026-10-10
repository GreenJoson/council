/**
 * @input  依赖：McpToolContext、Zod、共享常量、tasks/TaskService、MCP 委派端口（本地账本只读 + HTTP 转发）与 tool-support 共享件
 * @output 导出：registerTaskTools，注册 council_create_task / council_list_tasks / council_get_task / council_submit_brief /
 *         council_delegate_task
 * @pos    任务一等入口的 MCP 工具模块：不依赖议题创建、按项目列出、读取详情、为 image 任务提交 council-brief（本进程直连数据库）
 *         与发起代码/图像委派（经 HTTP 转发）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import { z } from "zod/v4";
import {
  MAX_ID_CHARS,
  MAX_IMAGE_INPUT_ASSETS,
  MAX_PATH_CHARS,
  MAX_TITLE_CHARS,
  MAX_WORK_ITEM_DETAILS_CHARS,
  WORK_ITEM_KINDS,
  WORK_ITEM_SOURCES,
} from "../../constants.js";
import { TaskService } from "../../tasks/task-service.js";
import { createMcpTaskDelegationPort } from "../task-delegation-forwarder.js";
import type { McpToolContext } from "../tool-context.js";
import {
  delegationOutput,
  executeTool,
  formatDelegation,
  formatTask,
  success,
  topicStatusField,
  workItemOutput,
  workItemStatusField,
} from "../tool-support.js";

const taskIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^work_item_[A-Za-z0-9-]+$/, "task_id 格式无效")
  .describe("任务 ID（与实施项共用 work_item_<uuid>）");
const projectPathField = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((value) => path.isAbsolute(value), "project_path 必须是绝对路径")
  .describe("项目根目录的绝对路径");
const agentIdField = z.string().min(1).max(MAX_ID_CHARS);

export function registerTaskTools(context: McpToolContext): void {
  const { server, database, caller, config } = context;
  const tasks = new TaskService(database, createMcpTaskDelegationPort(config));

  server.registerTool(
    "council_create_task",
    {
      title: "创建直接任务",
      description:
        "不经过议题，直接在指定项目下创建一条任务。适合目标明确、无需圆桌讨论的工作；"
        + "需要多方论证的事项仍应先建议题再拆实施项。kind 默认 code，priority 默认 0（越大越靠前）。",
      inputSchema: {
        project_path: projectPathField,
        title: z.string().min(1).max(MAX_TITLE_CHARS),
        details: z.string().max(MAX_WORK_ITEM_DETAILS_CHARS).optional(),
        kind: z.enum(WORK_ITEM_KINDS).optional(),
        priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
        brief: z.record(z.string(), z.unknown()).optional().describe("可选的结构化任务简报（JSON 对象）"),
      },
      outputSchema: { task: workItemOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_path, title, details, kind, priority, brief }) =>
      await executeTool("council_create_task", () => {
        const task = tasks.createDirect({
          projectPath: project_path,
          title,
          ...(details !== undefined ? { details } : {}),
          ...(kind ? { kind } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(brief ? { brief } : {}),
          actorId: caller.actorId,
        });
        return success(["已创建任务。", formatTask(task)].join("\n"), { task });
      }),
  );

  server.registerTool(
    "council_list_tasks",
    {
      title: "按项目查看任务",
      description:
        "列出某个项目下的全部任务（直接任务与议题拆解出的实施项），按优先级与更新时间排序，可按状态、类型、来源过滤。",
      inputSchema: {
        project_path: projectPathField,
        status: workItemStatusField.optional(),
        kind: z.enum(WORK_ITEM_KINDS).optional(),
        source: z.enum(WORK_ITEM_SOURCES).optional(),
      },
      outputSchema: { tasks: z.array(workItemOutput) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path, status, kind, source }) =>
      await executeTool("council_list_tasks", () => {
        const list = tasks.list({
          projectPath: project_path,
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
          ...(source ? { source } : {}),
        });
        return success(
          list.length > 0 ? list.map(formatTask).join("\n") : "该项目没有匹配的任务。",
          { tasks: list },
        );
      }),
  );

  server.registerTool(
    "council_get_task",
    {
      title: "查看任务详情",
      description: "读取一条任务、它的委派记录（新到旧）以及所属议题摘要（直接任务没有议题）。",
      inputSchema: { task_id: taskIdField },
      outputSchema: {
        task: workItemOutput,
        topic: z.object({ id: z.string(), title: z.string(), status: topicStatusField }).optional(),
        delegations: z.array(delegationOutput),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ task_id }) =>
      await executeTool("council_get_task", async () => {
        const detail = await tasks.get(task_id);
        return success([
          formatTask(detail.task),
          detail.topic ? `所属议题：${detail.topic.title}（${detail.topic.status}）` : "所属议题：无（直接任务）",
          "",
          "## 委派记录",
          detail.delegations.length > 0 ? detail.delegations.map(formatDelegation).join("\n") : "暂无委派。",
        ].join("\n"), detail);
      }),
  );

  server.registerTool(
    "council_submit_brief",
    {
      title: "提交图像任务简报",
      description:
        "为 kind=image 的任务写入 council-brief（结构化生图简报），按协议严格校验后整体替换，任务状态不变。"
        + "图像委派前必须先提交。expected_version 取自 council_get_task 返回的任务版本。",
      inputSchema: {
        task_id: taskIdField,
        expected_version: z.number().int().positive(),
        brief: z.record(z.string(), z.unknown()).describe("council-brief JSON 对象（goal、deliverables 等）"),
      },
      outputSchema: { task: workItemOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ task_id, expected_version, brief }) =>
      await executeTool("council_submit_brief", () => {
        const task = tasks.submitBrief({
          taskId: task_id,
          expectedVersion: expected_version,
          brief,
          actorId: caller.actorId,
        });
        return success(["已提交 council-brief。", formatTask(task)].join("\n"), { task });
      }),
  );

  server.registerTool(
    "council_delegate_task",
    {
      title: "委派任务给执行 Agent",
      description:
        "把一条未完成的叶子任务交给 executor Agent 在隔离 worktree 中执行。需要本机 Council HTTP 服务在运行（委派由它在后台执行）。"
        + "kind=code：由 supervisor Agent 审核，supervisor_agent_id 必填，input_asset_ids 必须为空。"
        + "kind=image：任务须已用 council_submit_brief 提交简报，executor 必须是本机 ChatGPT 登录的 Codex；"
        + "supervisor_agent_id 可省略（默认启用的 Claude）；input_asset_ids 为同项目图像资产（最多 8 个）；"
        + "产物入资产库并关联任务，等待人工验收。kind 须与任务一致。expected_version 取自 council_get_task 返回的任务版本。",
      inputSchema: {
        task_id: taskIdField,
        expected_version: z.number().int().positive(),
        supervisor_agent_id: agentIdField.optional().describe("负责审核/监督的 Agent ID；kind=code 必填，kind=image 可省略"),
        executor_agent_id: agentIdField.describe("负责执行的 Agent ID"),
        requested_permission: z.enum(["workspace_write", "danger_full_access"]),
        completion_policy: z.enum(["review", "human"]).optional().describe("缺省 human：审核通过后等待人工验收"),
        acceptance_criteria: z.string().min(1).max(4_000).optional(),
        create_initial_baseline: z.boolean().optional(),
        kind: z.enum(WORK_ITEM_KINDS).default("code"),
        input_asset_ids: z.array(z.string().min(1).max(MAX_ID_CHARS)).max(MAX_IMAGE_INPUT_ASSETS).default([])
          .describe("仅 kind=image：参考图资产 ID"),
      },
      outputSchema: { delegation: delegationOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      await executeTool("council_delegate_task", async () => {
        const delegation = await tasks.delegate(input.task_id, {
          expectedVersion: input.expected_version,
          ...(input.supervisor_agent_id ? { supervisorAgentId: input.supervisor_agent_id } : {}),
          executorAgentId: input.executor_agent_id,
          requestedPermission: input.requested_permission,
          kind: input.kind,
          inputAssetIds: input.input_asset_ids,
          ...(input.completion_policy ? { completionPolicy: input.completion_policy } : {}),
          ...(input.acceptance_criteria ? { acceptanceCriteria: input.acceptance_criteria } : {}),
          ...(input.create_initial_baseline !== undefined
            ? { createInitialBaseline: input.create_initial_baseline }
            : {}),
        });
        return success(["Agent 委派已进入后台执行。", formatDelegation(delegation)].join("\n"), { delegation });
      }),
  );
}
