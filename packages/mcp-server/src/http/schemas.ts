/**
 * @input  依赖：canonical 协议枚举与输入上限
 * @output 导出：REST path、query、body（含议题更正、Agent 权限/职责、接续权限、决策包接受、AI 实施计划、实施项、任务入口、资产库、P3 流水线、P4 Worker 团队与客户端接入）的 Zod schema
 * @pos    HTTP 边界全部外部输入的集中校验层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import {
  CYCLE_REVIEW_SCOPES,
  DISCUSSION_CYCLE_KINDS,
  MAX_FIX_REPOSITORY_CHARS,
  MAX_FIX_SUMMARY_CHARS,
  MAX_FIX_TARGETS,
  RUNTIME_CAPABILITY_KEYS,
} from "council-orchestrator";
import { z } from "zod/v4";
import {
  ASSET_KINDS,
  ASSET_LINK_ROLES,
  ASSET_LINK_TARGET_KINDS,
  DECISION_STATUSES,
  DEFAULT_ASSET_PAGE_LIMIT,
  MAX_ASSET_PAGE_LIMIT,
  MAX_ALTERNATIVE_COUNT,
  MAX_CONSTRAINT_CHARS,
  MAX_CONSTRAINT_COUNT,
  MAX_DECISION_BATCH,
  MAX_CYCLE_ROUND_BUDGET,
  MAX_ID_CHARS,
  MAX_IMAGE_INPUT_ASSETS,
  MAX_INSTRUCTION_CHARS,
  MAX_LIST_LIMIT,
  MAX_MESSAGE_CHARS,
  MAX_ORCHESTRATION_PLAN_ROUNDS,
  MAX_PATH_CHARS,
  MAX_QUESTION_CHARS,
  MAX_TITLE_CHARS,
  MAX_WORK_ITEM_BATCH,
  MAX_WORK_ITEM_DETAILS_CHARS,
  MAX_WORK_ITEM_STATUS_NOTE_CHARS,
  MESSAGE_KINDS,
  TOPIC_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
} from "../constants.js";
import {
  AGENT_EXECUTION_ROLES,
  AGENT_PERMISSION_PROFILES,
} from "../agent-execution-policy.js";
import { PIPELINE_DOCUMENT_LIMITS } from "../pipelines/pipeline-document.js";
import { PIPELINE_TEMPLATE_IDS } from "../pipelines/templates.js";

const nonBlankString = (maximum: number) =>
  z.string().min(1).max(maximum).refine((value) => value.trim().length > 0, {
    message: "不能只包含空白字符",
  });

export const topicIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "topicId 过长")
  .regex(/^topic_[A-Za-z0-9-]+$/, "topicId 格式无效");

export const topicParamsSchema = z.object({ topicId: topicIdSchema }).strict();

const messageIdSchema = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^message_[A-Za-z0-9-]+$/, "messageId 格式无效");

export const workItemIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "workItemId 过长")
  .regex(/^work_item_[A-Za-z0-9-]+$/, "workItemId 格式无效");

export const workItemParamsSchema = z
  .object({ topicId: topicIdSchema, workItemId: workItemIdSchema })
  .strict();

export const delegationIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "delegationId 过长")
  .regex(/^delegation-[A-Za-z0-9-]+$/, "delegationId 格式无效");

export const resumeDelegationBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  requestedPermission: z.enum(["workspace_write", "danger_full_access"]).optional(),
}).strict();

export const runtimeAuditQuerySchema = z.object({
  sourceKind: z.enum(["run", "delegation"]),
  sourceId: z.string().trim().min(1).max(MAX_ID_CHARS),
  after: z.coerce.number().int().nonnegative().default(0),
}).strict();

export const delegationParamsSchema = z.object({ delegationId: delegationIdSchema }).strict();

export const runIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "runId 过长")
  .regex(/^run_[A-Za-z0-9-]+$/, "runId 格式无效");

export const runParamsSchema = z.object({ runId: runIdSchema }).strict();

export const runtimeBindingIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "bindingId 过长")
  .regex(/^binding_[A-Za-z0-9-]+$/, "bindingId 格式无效");

export const runtimeBindingParamsSchema = z
  .object({ bindingId: runtimeBindingIdSchema })
  .strict();

const routerIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9-]*$/, "标识格式无效");
const routerSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "slug 格式无效");

export const agentParamsSchema = z
  .object({
    agentId: routerIdSchema,
  })
  .strict();

export const providerParamsSchema = z
  .object({
    providerId: routerIdSchema,
  })
  .strict();

export const createProviderBodySchema = z
  .object({
    templateId: routerSlugSchema,
    slug: routerSlugSchema,
    displayName: nonBlankString(120),
    baseUrl: z.string().max(2_048).optional(),
    brandAssetId: routerIdSchema.optional(),
    apiKey: z.string().min(1).max(4_096).optional(),
    active: z.boolean(),
  })
  .strict();

export const updateProviderBodySchema = z
  .object({
    displayName: nonBlankString(120),
    baseUrl: z.string().max(2_048).optional(),
    brandAssetId: routerIdSchema,
    active: z.boolean(),
    apiKey: z.string().min(1).max(4_096).optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict();

export const createAgentBodySchema = z
  .object({
    providerId: routerIdSchema,
    slug: routerSlugSchema,
    displayName: nonBlankString(120),
    model: z.string().max(200),
    mentionAlias: routerSlugSchema,
    enabled: z.boolean(),
    permissionProfile: z.enum(AGENT_PERMISSION_PROFILES).default("read_only"),
    executionRole: z.enum(AGENT_EXECUTION_ROLES).default("advisor"),
  })
  .strict();

export const updateAgentBodySchema = z
  .object({
    displayName: nonBlankString(120),
    model: z.string().max(200),
    mentionAlias: routerSlugSchema,
    enabled: z.boolean(),
    permissionProfile: z.enum(AGENT_PERMISSION_PROFILES).optional(),
    executionRole: z.enum(AGENT_EXECUTION_ROLES).optional(),
  })
  .strict();

export const listTopicsQuerySchema = z
  .object({
    projectPath: z
      .string()
      .min(1)
      .max(MAX_PATH_CHARS)
      .refine((value) => path.isAbsolute(value), "projectPath 必须是绝对路径")
      .optional(),
    status: z.enum(TOPIC_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const topicDetailQuerySchema = z
  .object({
    messageLimit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    messageOffset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const eventsQuerySchema = z
  .object({
    projectPath: z
      .string()
      .min(1)
      .max(MAX_PATH_CHARS)
      .refine((value) => path.isAbsolute(value), "projectPath 必须是绝对路径")
      .optional(),
  })
  .strict();

export const createTopicBodySchema = z
  .object({
    title: nonBlankString(MAX_TITLE_CHARS),
    question: nonBlankString(MAX_QUESTION_CHARS),
    constraints: z
      .array(nonBlankString(MAX_CONSTRAINT_CHARS))
      .max(MAX_CONSTRAINT_COUNT)
      .default([]),
    projectPath: z
      .string()
      .min(1)
      .max(MAX_PATH_CHARS)
      .refine((value) => path.isAbsolute(value), "projectPath 必须是绝对路径")
      .optional(),
  })
  .strict();

export const updateTopicBodySchema = z
  .object({
    title: nonBlankString(MAX_TITLE_CHARS).optional(),
    question: nonBlankString(MAX_QUESTION_CHARS).optional(),
    constraints: z
      .array(nonBlankString(MAX_CONSTRAINT_CHARS))
      .max(MAX_CONSTRAINT_COUNT)
      .optional(),
    expectedUpdatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined
      || value.question !== undefined
      || value.constraints !== undefined,
    { message: "至少提供 title、question 或 constraints 中的一项" },
  );

export const createMessageBodySchema = z
  .object({
    kind: z.enum(MESSAGE_KINDS),
    content: nonBlankString(MAX_MESSAGE_CHARS),
    parentMessageId: z
      .string()
      .max(MAX_ID_CHARS, "parentMessageId 过长")
      .regex(/^message_[A-Za-z0-9-]+$/, "parentMessageId 格式无效")
      .optional(),
  })
  .strict();

export const createDecisionBodySchema = z
  .object({
    title: nonBlankString(MAX_TITLE_CHARS),
    decision: nonBlankString(MAX_MESSAGE_CHARS),
    rationale: nonBlankString(MAX_MESSAGE_CHARS),
    alternatives: z
      .array(nonBlankString(MAX_CONSTRAINT_CHARS))
      .max(MAX_ALTERNATIVE_COUNT)
      .default([]),
    status: z.enum(DECISION_STATUSES).default("proposed"),
  })
  .strict();

const decisionIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "decisionId 过长")
  .regex(/^decision_[A-Za-z0-9-]+$/, "decisionId 格式无效");

export const acceptDecisionsBodySchema = z
  .object({
    decisionIds: z.array(decisionIdSchema).min(1).max(MAX_DECISION_BATCH),
  })
  .strict()
  .refine(
    (value) => new Set(value.decisionIds).size === value.decisionIds.length,
    "decisionIds 不能重复",
  );

export const createWorkItemsBodySchema = z
  .object({
    decisionId: decisionIdSchema.optional(),
    parentId: workItemIdSchema.optional(),
    items: z
      .array(
        z.object({
          title: nonBlankString(MAX_TITLE_CHARS),
          details: z.string().max(MAX_WORK_ITEM_DETAILS_CHARS).default(""),
        }).strict(),
      )
      .min(1)
      .max(MAX_WORK_ITEM_BATCH),
  })
  .strict();

export const generateWorkItemsBodySchema = z
  .object({
    adapterId: routerIdSchema,
    decisionId: decisionIdSchema.optional(),
  })
  .strict();

export const updateWorkItemBodySchema = z
  .object({
    status: z.enum(WORK_ITEM_STATUSES),
    expectedVersion: z.number().int().positive(),
    statusNote: z.string().max(MAX_WORK_ITEM_STATUS_NOTE_CHARS).optional(),
    fixCommit: z.string().max(MAX_ID_CHARS, "fixCommit 过长").optional(),
  })
  .strict();

export const claimWorkItemBodySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    statusNote: z.string().max(MAX_WORK_ITEM_STATUS_NOTE_CHARS).optional(),
  })
  .strict();

export const startWorkItemDelegationBodySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    supervisorAgentId: routerIdSchema,
    executorAgentId: routerIdSchema,
    requestedPermission: z.enum(["workspace_write", "danger_full_access"]),
    completionPolicy: z.enum(["review", "human"]).optional(),
    acceptanceCriteria: nonBlankString(4_000).optional(),
    createInitialBaseline: z.boolean().optional(),
  })
  .strict();

export const startWorkItemDelegationBatchBodySchema = z
  .object({
    workItems: z.array(z.object({
      workItemId: workItemIdSchema,
      expectedVersion: z.number().int().positive(),
    }).strict()).min(1).max(MAX_WORK_ITEM_BATCH),
    supervisorAgentId: routerIdSchema,
    executorAgentId: routerIdSchema,
    requestedPermission: z.enum(["workspace_write", "danger_full_access"]),
    completionPolicy: z.enum(["review", "human"]).optional(),
    acceptanceCriteria: nonBlankString(4_000).optional(),
    createInitialBaseline: z.boolean().optional(),
  })
  .strict();

// ---- 任务入口（/api/v1/tasks）：语义归一化在 tasks/task-intake.ts，这里只校验形状 ----

const taskProjectPathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((value) => path.isAbsolute(value), "projectPath 必须是绝对路径");

export const taskParamsSchema = z.object({ taskId: workItemIdSchema }).strict();

export const createTaskBodySchema = z
  .object({
    projectPath: taskProjectPathSchema,
    title: nonBlankString(MAX_TITLE_CHARS),
    details: z.string().max(MAX_WORK_ITEM_DETAILS_CHARS).optional(),
    kind: z.enum(WORK_ITEM_KINDS).optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    brief: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const listTasksQuerySchema = z
  .object({
    project: taskProjectPathSchema,
    status: z.enum(WORK_ITEM_STATUSES).optional(),
    kind: z.enum(WORK_ITEM_KINDS).optional(),
    source: z.enum(WORK_ITEM_SOURCES).optional(),
  })
  .strict();

/**
 * 任务入口单项委派：在议题内委派形状上增加 kind 与 inputAssetIds。
 * image 允许省略 supervisorAgentId（服务层选默认 Claude），code 仍必填；参考图最多 MAX_IMAGE_INPUT_ASSETS 个，
 * code 只接受空数组的规则与资产归属校验在服务层。
 */
export const startTaskDelegationBodySchema = startWorkItemDelegationBodySchema.extend({
  supervisorAgentId: routerIdSchema.optional(),
  kind: z.enum(WORK_ITEM_KINDS).default("code"),
  inputAssetIds: z.array(z.string().min(1).max(MAX_ID_CHARS)).max(MAX_IMAGE_INPUT_ASSETS).default([]),
}).strict().superRefine((value, context) => {
  if (value.kind === "code" && !value.supervisorAgentId) {
    context.addIssue({ code: "custom", path: ["supervisorAgentId"], message: "代码委派必须指定监督 Agent" });
  }
});

/** 任务入口的乐观更新：在议题内更新形状上增加可选 brief（仅 image 任务，服务层按 council-brief 严格校验）。 */
export const updateTaskBodySchema = updateWorkItemBodySchema.extend({
  brief: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ---- P3 流水线（/api/v1/pipelines）：阶段语义、brief 模板约束与 Agent 选择在 pipelines/，这里只校验形状 ----

const pipelineAgentIdSchema = routerIdSchema.min(1);

export const pipelineParamsSchema = z.object({ pipelineId: workItemIdSchema }).strict();

export const listPipelinesQuerySchema = z.object({ project: taskProjectPathSchema }).strict();

export const createPipelineBodySchema = z
  .object({
    project: taskProjectPathSchema,
    template: z.enum(PIPELINE_TEMPLATE_IDS),
    goal: nonBlankString(PIPELINE_DOCUMENT_LIMITS.maxGoal),
    constraints: z
      .array(nonBlankString(PIPELINE_DOCUMENT_LIMITS.maxConstraint))
      .max(PIPELINE_DOCUMENT_LIMITS.maxConstraints)
      .optional(),
    referenceAssetIds: z
      .array(z.string().min(1).max(MAX_ID_CHARS))
      .max(PIPELINE_DOCUMENT_LIMITS.maxReferences)
      .optional(),
    agents: z
      .object({
        brief: pipelineAgentIdSchema.optional(),
        image: pipelineAgentIdSchema.optional(),
        prototype: z
          .object({
            executor: pipelineAgentIdSchema.optional(),
            supervisor: pipelineAgentIdSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** brief 只校验为对象；council-brief 结构与模板约束（kind、数量、透明背景）由服务层严格校验并返回 400。 */
export const confirmPipelineBriefBodySchema = z
  .object({
    brief: z.record(z.string(), z.unknown()),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const selectPipelineFinalBodySchema = z
  .object({
    assetIds: z.array(z.string().min(1).max(MAX_ID_CHARS)).min(1).max(64),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const pipelineVersionBodySchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

/** 删除流水线：DELETE 不带 body，版本放查询参数。 */
export const pipelineDeleteQuerySchema = z
  .object({ expectedVersion: z.coerce.number().int().positive() })
  .strict();

/** 讨论消息一键派活：只传出处，派活内容由服务层从已存消息的 council-dispatch 尾块重新解析。 */
export const dispatchPipelineBodySchema = z
  .object({ topicId: topicIdSchema, messageId: messageIdSchema })
  .strict();

// ---- 资产库（/api/v1/assets）：入库规则在 assets/，这里只校验形状 ----

export const assetIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "assetId 过长")
  .regex(/^asset_[A-Za-z0-9-]+$/, "assetId 格式无效");

const assetTargetIdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/, "targetId 格式无效");

export const assetParamsSchema = z.object({ assetId: assetIdSchema }).strict();

export const assetLinkParamsSchema = z
  .object({
    assetId: assetIdSchema,
    targetKind: z.enum(ASSET_LINK_TARGET_KINDS),
    targetId: assetTargetIdSchema,
    role: z.enum(ASSET_LINK_ROLES),
  })
  .strict();

/** target 形如 work_item:<id>；拆成结构化字段后再交给仓储。unlinked=true 只看未挂任何目标的资产。 */
export const listAssetsQuerySchema = z
  .object({
    project: taskProjectPathSchema,
    kind: z.enum(ASSET_KINDS).optional(),
    unlinked: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    target: z
      .string()
      .max(MAX_ID_CHARS + 16)
      .transform((value, context) => {
        const separator = value.indexOf(":");
        const kind = ASSET_LINK_TARGET_KINDS.find((item) => item === value.slice(0, separator));
        const id = value.slice(separator + 1);
        if (separator <= 0 || !kind || !/^[A-Za-z0-9_-]+$/.test(id) || id.length > MAX_ID_CHARS) {
          context.addIssue({ code: "custom", message: "target 必须形如 work_item|message|decision:<id>" });
          return z.NEVER;
        }
        return { kind, id };
      })
      .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_ASSET_PAGE_LIMIT).default(DEFAULT_ASSET_PAGE_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const importAssetBodySchema = z
  .object({
    projectPath: taskProjectPathSchema,
    relativePath: nonBlankString(MAX_PATH_CHARS),
  })
  .strict();

/** 浏览器上传图片字节：项目路径走查询串，请求正文是原始文件内容（路由级 raw 解析）。 */
export const uploadAssetQuerySchema = z.object({ project: taskProjectPathSchema }).strict();

/** 桌面壳把用户在原生文件选择器里选中的本机绝对路径交给服务入库，原文件不复制不移动。 */
export const ingestAssetBodySchema = z
  .object({
    projectPath: taskProjectPathSchema,
    sourcePath: nonBlankString(MAX_PATH_CHARS),
  })
  .strict();

// ---- 项目文件引用（议题预览 body 与图片出站 query 共用） ----

export const projectFileReferenceSchema = z
  .object({
    href: z.string().trim().min(1).max(4096),
    basePath: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();

export const addAssetLinkBodySchema = z
  .object({
    targetKind: z.enum(ASSET_LINK_TARGET_KINDS),
    targetId: assetTargetIdSchema,
    role: z.enum(ASSET_LINK_ROLES),
  })
  .strict();

export const listRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const listRuntimeBindingsQuerySchema = z
  .object({
    includeClosed: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default(false),
  })
  .strict();

export const createRunBodySchema = z
  .object({
    confirmationBeforeCompletion: z.boolean().optional(),
    plan: z
      .array(
        z
          .object({
            adapterId: z.string().trim().min(1).max(100),
            messageKind: z.enum(MESSAGE_KINDS),
            instruction: nonBlankString(MAX_INSTRUCTION_CHARS),
            requestMessageId: z
              .string()
              .max(MAX_ID_CHARS)
              .regex(/^message_[A-Za-z0-9-]+$/, "requestMessageId 格式无效")
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ORCHESTRATION_PLAN_ROUNDS),
  })
  .strict();

export const emptyActionBodySchema = z.object({}).strict();

export const startCycleBodySchema = z
  .object({
    // 名册由用户开局时勾选并就此冻结；首位是提案人，顺序有意义。
    participants: z
      .array(z.string().trim().min(1).max(100))
      .min(2, "圆桌至少要两位参与者，一个人不构成互审")
      .max(MAX_ORCHESTRATION_PLAN_ROUNDS)
      .refine(
        (value) => new Set(value).size === value.length,
        { message: "参与名册不能重复" },
      ),
    roundBudget: z.number().int().positive().max(MAX_CYCLE_ROUND_BUDGET).optional(),
    kind: z.enum(DISCUSSION_CYCLE_KINDS).optional(),
    reviewScope: z.enum(CYCLE_REVIEW_SCOPES).optional(),
    taskRequirements: z
      .object({
        all: z.array(z.enum(RUNTIME_CAPABILITY_KEYS)).max(20).optional(),
        proposer: z.array(z.enum(RUNTIME_CAPABILITY_KEYS)).max(20).optional(),
        reviewers: z.array(z.enum(RUNTIME_CAPABILITY_KEYS)).max(20).optional(),
      })
      .strict()
      .optional(),
    /** v7 Web 兼容字段；服务端只用它转换成持久化 kind，不再用于后续推断。 */
    requiresCommitRef: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.kind === undefined
      || value.requiresCommitRef === undefined
      || value.kind === (value.requiresCommitRef ? "fix_review" : "discussion"),
    { message: "kind 与 requiresCommitRef 冲突" },
  )
  .refine(
    (value) =>
      value.kind === undefined
      || value.reviewScope === undefined
      || value.kind === (value.reviewScope === "commit" ? "fix_review" : "discussion"),
    { message: "kind 与 reviewScope 冲突" },
  )
  .refine(
    (value) =>
      value.requiresCommitRef === undefined
      || value.reviewScope === undefined
      || value.reviewScope === (value.requiresCommitRef ? "commit" : "discussion"),
    { message: "reviewScope 与 requiresCommitRef 冲突" },
  );

export const answerCycleQuestionBodySchema = z
  .object({
    questionMessageId: messageIdSchema,
    content: nonBlankString(MAX_MESSAGE_CHARS),
  })
  .strict();

/**
 * 提交一批修复并开一轮复审。
 *
 * `targets` 给了就顺带公开一条修复自述，复审据此读新 diff；
 * 外部 Agent 已经通过 MCP 自己发过自述时可以省略，只触发复审。
 */
export const submitFixesBodySchema = z
  .object({
    summary: nonBlankString(MAX_FIX_SUMMARY_CHARS).optional(),
    targets: z
      .array(
        z
          .object({
            repository: nonBlankString(MAX_FIX_REPOSITORY_CHARS),
            commit: z
              .string()
              .regex(/^[0-9a-f]{7,40}$/u, "commit 必须是 7 位以上的十六进制对象名"),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_FIX_TARGETS)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.targets === undefined) === (value.summary === undefined),
    { message: "targets 与 summary 必须同时给出或同时省略" },
  );

export const approveRunBodySchema = z
  .object({
    expectedGateId: z
      .string()
      .max(MAX_ID_CHARS)
      .regex(/^before_(?:completion|round:[1-9][0-9]*)$/, "expectedGateId 格式无效"),
    expectedVersion: z.number().int().positive(),
    approvalId: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "approvalId 格式无效"),
  })
  .strict();

export const lastEventIdSchema = z
  .string()
  .regex(/^\d+$/, "Last-Event-ID 格式无效")
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value), "Last-Event-ID 超出安全范围")
  .optional();

// ---- P4 Worker 团队（/api/v1/tasks/:taskId/team）：并行上限、检查点与合并规则在 teams/，这里只校验形状 ----

const teamEntityIdSchema = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/, "id 格式无效");

export const teamWorkerParamsSchema = z.object({ taskId: workItemIdSchema, workerId: teamEntityIdSchema }).strict();

/** 组队即发起 Lead 代码委派：形状同任务入口代码委派，审核者可省略（服务层取默认 Claude），另加并行上限。 */
export const startTeamBodySchema = startWorkItemDelegationBodySchema.extend({
  supervisorAgentId: routerIdSchema.optional(),
  maxParallel: z.number().int().min(1).max(16).optional(),
}).strict();

export const dispatchWorkerBodySchema = z
  .object({
    label: nonBlankString(80),
    role: z.string().max(80).optional(),
    brief: nonBlankString(4_000),
    scopePaths: z.array(nonBlankString(500)).max(50).optional(),
    requestedPermission: z.enum(["workspace_write", "danger_full_access"]).optional(),
  })
  .strict();

export const waitWorkerQuerySchema = z
  .object({ timeoutMs: z.coerce.number().int().min(0).max(600_000).optional() })
  .strict();

export const focusWorkerBodySchema = z.object({ focused: z.boolean() }).strict();
/** 客户端接入（P4 配置分发）：client 只允许 claude|codex；apply 可带 force 覆盖漂移。 */
export const clientConfigParamsSchema = z
  .object({ client: z.enum(["claude", "codex"]) })
  .strict();

export const applyClientConfigBodySchema = z
  .object({ force: z.boolean().optional() })
  .strict();
