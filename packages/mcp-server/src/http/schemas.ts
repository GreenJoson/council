/**
 * @input  依赖：canonical 协议枚举与输入上限
 * @output 导出：REST path、query、body 的 Zod schema
 * @pos    HTTP 边界全部外部输入的集中校验层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import { z } from "zod/v4";
import {
  DECISION_STATUSES,
  MAX_ALTERNATIVE_COUNT,
  MAX_CONSTRAINT_CHARS,
  MAX_CONSTRAINT_COUNT,
  MAX_ID_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_LIST_LIMIT,
  MAX_MESSAGE_CHARS,
  MAX_ORCHESTRATION_PLAN_ROUNDS,
  MAX_PATH_CHARS,
  MAX_QUESTION_CHARS,
  MAX_TITLE_CHARS,
  MESSAGE_KINDS,
  TOPIC_STATUSES,
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

export const runIdSchema = z
  .string()
  .max(MAX_ID_CHARS, "runId 过长")
  .regex(/^run_[A-Za-z0-9-]+$/, "runId 格式无效");

export const runParamsSchema = z.object({ runId: runIdSchema }).strict();

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

export const listRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).default(0),
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
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ORCHESTRATION_PLAN_ROUNDS),
  })
  .strict();

export const emptyActionBodySchema = z.object({}).strict();

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
