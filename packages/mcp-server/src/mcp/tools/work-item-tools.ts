/**
 * @input  依赖：McpToolContext、Zod、council-orchestrator 修复提交上限、共享常量、tasks 议题入口与 tool-support 共享件
 * @output 导出：registerWorkItemTools，注册 council_add_work_items / council_update_work_item / council_list_work_items / council_claim_work_item / council_submit_fixes
 * @pos    实施项拆分、进度更新、清单、认领与修复提交复审的 MCP 工具模块
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  MAX_FIX_REPOSITORY_CHARS,
  MAX_FIX_SUMMARY_CHARS,
  MAX_FIX_TARGETS,
} from "council-orchestrator";
import { z } from "zod/v4";
import {
  MAX_ID_CHARS,
  MAX_TITLE_CHARS,
  MAX_WORK_ITEM_BATCH,
  MAX_WORK_ITEM_DETAILS_CHARS,
  MAX_WORK_ITEM_STATUS_NOTE_CHARS,
  WORK_ITEM_ORIGINS,
} from "../../constants.js";
import { createTopicTasks } from "../../tasks/task-intake.js";
import type { McpToolContext } from "../tool-context.js";
import {
  executeTool,
  formatMessage,
  formatWorkItem,
  messageOutput,
  success,
  topicIdField,
  workItemOutput,
  workItemStatusField,
} from "../tool-support.js";

export function registerWorkItemTools(context: McpToolContext): void {
  const { server, database, caller } = context;

  server.registerTool(
    "council_add_work_items",
    {
      title: "拆分决策实施项",
      description:
        "为议题最新的 Accepted 决策添加可追踪实施项。仅记录真实计划，不得把尚未实现的功能标成已完成；同一决策内标题不允许重复。",
      inputSchema: {
        topic_id: topicIdField,
        decision_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^decision_[A-Za-z0-9-]+$/, "decision_id 格式无效")
          .optional()
          .describe("省略时绑定该议题最新的 Accepted 决策"),
        parent_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^work_item_[A-Za-z0-9-]+$/, "parent_id 格式无效")
          .optional()
          .describe(
            "挂到这个父任务下形成子任务；父任务状态由子任务派生，不能手动更新",
          ),
        items: z
          .array(z.object({
            title: z.string().min(1).max(MAX_TITLE_CHARS),
            details: z.string().max(MAX_WORK_ITEM_DETAILS_CHARS).default(""),
          }))
          .min(1)
          .max(MAX_WORK_ITEM_BATCH),
      },
      outputSchema: { workItems: z.array(workItemOutput) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, decision_id, parent_id, items }) =>
      await executeTool("council_add_work_items", () => {
        const workItems = createTopicTasks(database, {
          topicId: topic_id,
          ...(decision_id ? { decisionId: decision_id } : {}),
          ...(parent_id ? { parentId: parent_id } : {}),
          items,
          actorId: caller.actorId,
        });
        return success(
          [`已添加 ${String(workItems.length)} 个实施项。`, ...workItems.map(formatWorkItem)].join("\n"),
          { workItems },
        );
      }),
  );

  server.registerTool(
    "council_update_work_item",
    {
      title: "更新实施进度",
      description:
        "更新一个实施项的待开始、进行中、阻塞或完成状态。只有在代码、验证或交付结果确实完成后才能标记 completed；status_note 应简述证据或阻塞原因。expected_version 用于拒绝并发覆盖。",
      inputSchema: {
        topic_id: topicIdField,
        work_item_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^work_item_[A-Za-z0-9-]+$/, "work_item_id 格式无效"),
        status: workItemStatusField,
        expected_version: z.number().int().positive(),
        status_note: z.string().max(MAX_WORK_ITEM_STATUS_NOTE_CHARS).optional(),
        fix_commit: z
          .string()
          .max(MAX_ID_CHARS)
          .optional()
          .describe("标记完成时附上修复所在的 commit，作为复审的证据入口"),
      },
      outputSchema: { workItem: workItemOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, work_item_id, status, expected_version, status_note, fix_commit }) =>
      await executeTool("council_update_work_item", () => {
        const workItem = database.updateWorkItemAsActor({
          topicId: topic_id,
          workItemId: work_item_id,
          status,
          expectedVersion: expected_version,
          ...(status_note !== undefined ? { statusNote: status_note } : {}),
          ...(fix_commit !== undefined ? { fixCommit: fix_commit } : {}),
          actorId: caller.actorId,
        });
        return success(formatWorkItem(workItem), { workItem });
      }),
  );

  server.registerTool(
    "council_list_work_items",
    {
      title: "查看实施项清单",
      description:
        "列出议题的实施项待办，可按状态、来源或「只看我认领的」过滤。开工前先读这里，"
        + "认领一条再动手，不要凭记忆猜自己在做哪一项。",
      inputSchema: {
        topic_id: topicIdField,
        status: workItemStatusField.optional(),
        origin: z
          .enum(WORK_ITEM_ORIGINS)
          .optional()
          .describe("review_finding 只看审核发现，manual 只看手工拆解的交付项"),
        mine: z
          .boolean()
          .optional()
          .describe("只返回自己已认领的条目"),
      },
      outputSchema: { workItems: z.array(workItemOutput) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic_id, status, origin, mine }) =>
      await executeTool("council_list_work_items", () => {
        const workItems = database.listWorkItems({
          topicId: topic_id,
          ...(status ? { status } : {}),
          ...(origin ? { origin } : {}),
          ...(mine ? { assigneeActorId: caller.actorId } : {}),
        });
        return success(
          workItems.length > 0
            ? workItems.map(formatWorkItem).join("\n")
            : "没有匹配的实施项。",
          { workItems },
        );
      }),
  );

  server.registerTool(
    "council_claim_work_item",
    {
      title: "认领实施项",
      description:
        "在开始修复之前认领一条实施项：写上执行者并置为进行中。这是界面上「谁正在做哪一条」"
        + "的唯一来源——不认领就动手，用户只会看到一个跑了很久却不知道在干什么的 Agent。"
        + "父任务不能被认领，只能认领叶子任务。",
      inputSchema: {
        topic_id: topicIdField,
        work_item_id: z
          .string()
          .max(MAX_ID_CHARS)
          .regex(/^work_item_[A-Za-z0-9-]+$/, "work_item_id 格式无效"),
        expected_version: z.number().int().positive(),
        status_note: z
          .string()
          .max(MAX_WORK_ITEM_STATUS_NOTE_CHARS)
          .optional()
          .describe("打算怎么修，一句话即可"),
      },
      outputSchema: { workItem: workItemOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, work_item_id, expected_version, status_note }) =>
      await executeTool("council_claim_work_item", () => {
        const workItem = database.claimWorkItemAsActor({
          topicId: topic_id,
          workItemId: work_item_id,
          expectedVersion: expected_version,
          ...(status_note !== undefined ? { statusNote: status_note } : {}),
          actorId: caller.actorId,
        });
        return success(formatWorkItem(workItem), { workItem });
      }),
  );

  server.registerTool(
    "council_submit_fixes",
    {
      title: "提交修复并请求复审",
      description:
        "改完代码、提交之后调用：把这一批修复的仓库与 commit 公开自述出来，交回圆桌复审。"
        + "不要自己宣布问题已解决——条目是否关闭由复审者读真实 diff 判定，"
        + "你只负责把改动摆到台面上。commit 必须是已经存在的对象名（7 位以上十六进制），"
        + "不能填分支名或 tag，否则复审者过几分钟读到的就不是你改的那份 diff。"
        + "调用后请在界面上开始复审，或等待用户触发。",
      inputSchema: {
        topic_id: topicIdField,
        summary: z
          .string()
          .min(1)
          .max(MAX_FIX_SUMMARY_CHARS)
          .describe("这批改动解决了哪些条目，一句话"),
        targets: z
          .array(
            z.object({
              repository: z
                .string()
                .min(1)
                .max(MAX_FIX_REPOSITORY_CHARS)
                .describe("相对议题项目目录的仓库路径；当前仓库写 ."),
              commit: z
                .string()
                .regex(/^[0-9a-f]{7,40}$/u, "commit 必须是 7 位以上的十六进制对象名"),
            }),
          )
          .min(1)
          .max(MAX_FIX_TARGETS),
      },
      outputSchema: { message: messageOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id, summary, targets }) =>
      await executeTool("council_submit_fixes", () => {
        const message = database.createMessageAsActor({
          topicId: topic_id,
          actorId: caller.actorId,
          kind: "note",
          content: [
            "已提交一批修复，请复审。",
            "",
            `修复摘要：${summary}`,
            "",
            "```council-fix",
            JSON.stringify({ targets, summary }),
            "```",
          ].join("\n"),
        });
        return success(formatMessage(message), { message });
      }),
  );
}
