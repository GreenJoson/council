/**
 * @input  依赖：canonical 协议枚举与输入上限
 * @output 导出：REST path、query、body（含 AI 实施计划与实施项）的 Zod schema
 * @pos    HTTP 边界全部外部输入的集中校验层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import {
  CYCLE_REVIEW_SCOPES,
  DISCUSSION_CYCLE_KINDS,
  RUNTIME_CAPABILITY_KEYS,
} from "council-orchestrator";
import { z } from "zod/v4";
import {
  DECISION_STATUSES,
  MAX_ALTERNATIVE_COUNT,
  MAX_CONSTRAINT_CHARS,
  MAX_CONSTRAINT_COUNT,
  MAX_CYCLE_ROUND_BUDGET,
  MAX_ID_CHARS,
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
  WORK_ITEM_STATUSES,
} from "../constants.js";

const nonBlankString = (maximum: number) =>
  z.string().min(1).max(maximum).refine((value) => value.trim().length > 0, {
    message: "不能只包含空白字符",
  });

export const topicIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "topicId 过长")
  .regex(/^topic_[A-Za-z0-9-]+$/, "topicId 格式无效");

export const topicParamsSchema = z.object({ topicId: topicIdSchema }).strict();

export const workItemIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "workItemId 过长")
  .regex(/^work_item_[A-Za-z0-9-]+$/, "workItemId 格式无效");

export const workItemParamsSchema = z
  .object({ topicId: topicIdSchema, workItemId: workItemIdSchema })
  .strict();

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
  })
  .strict();

export const updateAgentBodySchema = z
  .object({
    displayName: nonBlankString(120),
    model: z.string().max(200),
    mentionAlias: routerSlugSchema,
    enabled: z.boolean(),
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

export const createWorkItemsBodySchema = z
  .object({
    decisionId: z
      .string()
      .max(MAX_ID_CHARS, "decisionId 过长")
      .regex(/^decision_[A-Za-z0-9-]+$/, "decisionId 格式无效")
      .optional(),
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
  })
  .strict();

export const updateWorkItemBodySchema = z
  .object({
    status: z.enum(WORK_ITEM_STATUSES),
    expectedVersion: z.number().int().positive(),
    statusNote: z.string().max(MAX_WORK_ITEM_STATUS_NOTE_CHARS).optional(),
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

const messageIdSchema = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^message_[A-Za-z0-9-]+$/, "messageId 格式无效");

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
