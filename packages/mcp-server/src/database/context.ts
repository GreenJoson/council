/**
 * @input  依赖：node:sqlite 连接类型、Actor 身份类型、Topic 领域类型
 * @output 导出：DatabaseContext（连接、BEGIN IMMEDIATE 事务、可信 actorId/alias 解析）、
 *         TopicLookup（消息/决策/实施项仓储确认议题存在用的窄接口）
 * @pos    database.ts 与各仓储之间的契约；只声明接口，实现与接线都在 CouncilDatabase 构造期完成
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import type { ActorIdentity } from "../actor-identity.js";
import type { Topic } from "../types.js";

/** 仓储共享的基础设施：连接由 CouncilDatabase 打开并完成 PRAGMA 与 schema 校验。 */
export interface DatabaseContext {
  readonly database: DatabaseSync;
  /** BEGIN IMMEDIATE 事务；成功 COMMIT，抛错 ROLLBACK 后原样重抛。 */
  transaction<T>(operation: () => T): T;
  /** 可信 actorId → 活跃身份；未注册或已停用即失败关闭。 */
  activeActorById(actorId: string): ActorIdentity;
  /** 动态 alias → 活跃身份；alias 入口的写入都先经这里换成可信 actorId。 */
  resolveActorAlias(alias: string): ActorIdentity;
}

/**
 * 消息、决策、实施项写入前都要确认议题存在（不存在抛 CouncilNotFoundError）。
 * 用窄接口而不是整个 TopicRepository，避免议题仓储与其余仓储互相持有。
 */
export interface TopicLookup {
  get(topicId: string): Topic;
}
