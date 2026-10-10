/**
 * @input  依赖：共享数据库上下文、议题存在性查找、行映射与安全错误语义
 * @output 导出：DecisionRepository —— 议题决策列表、动态 alias/可信 actorId 记录决策
 *         （人工直接 Accepted 会取代全部 proposed）、决策包逐项原地接受并同步议题状态
 * @pos    决策领域仓储；Accepted 只能由 human 写入，议题 decided/open 的切换与决策写入同一事务
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { serializeActorSnapshot, toActorSnapshot } from "../actor-identity.js";
import { CouncilConflictError, CouncilNotFoundError } from "../errors.js";
import type { Decision, DecisionStatus, TopicStatus } from "../types.js";
import type { DatabaseContext, TopicLookup } from "./context.js";
import { decisionFromRow, type CountRow, type DecisionRow } from "./rows.js";

export class DecisionRepository {
  readonly #context: DatabaseContext;
  readonly #topics: TopicLookup;

  constructor(context: DatabaseContext, topics: TopicLookup) {
    this.#context = context;
    this.#topics = topics;
  }

  /** 议题详情用：按创建顺序取全部决策，不分页。 */
  listByTopic(topicId: string): Decision[] {
    const decisionRows = this.#context.database
      .prepare("SELECT * FROM decisions WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(topicId) as unknown as DecisionRow[];
    return decisionRows.map(decisionFromRow);
  }

  create(input: {
    topicId: string;
    title: string;
    decision: string;
    rationale: string;
    alternatives: string[];
    status: DecisionStatus;
    createdByAlias: string;
  }): Decision {
    const actor = this.#context.resolveActorAlias(input.createdByAlias);
    return this.createAsActor({
      topicId: input.topicId,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale,
      alternatives: input.alternatives,
      status: input.status,
      actorId: actor.actorId,
    });
  }

  createAsActor(input: {
    topicId: string;
    title: string;
    decision: string;
    rationale: string;
    alternatives: string[];
    status: DecisionStatus;
    actorId: string;
  }): Decision {
    const id = `decision_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#context.transaction(() => {
      this.#topics.get(input.topicId);
      const actor = this.#context.activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      if (input.status === "accepted" && actor.actorId !== "human") {
        throw new CouncilConflictError("Accepted 决策必须由用户确认。");
      }
      // 人工直接记录 Accepted 表示用一条外部结论结束当前决策包；历史提案保留但退出待办。
      // 普通“接受提案”必须走 acceptDecisionsAsActor，原地更新稳定 decisionId。
      if (input.status === "accepted") {
        this.#context.database.prepare(`
          UPDATE decisions
          SET status = 'superseded', updated_at = ?
          WHERE topic_id = ? AND status = 'proposed'
        `).run(now, input.topicId);
      }
      this.#context.database
        .prepare(`
          INSERT INTO decisions (
            id, topic_id, title, decision, rationale, alternatives_json,
            status, created_by_actor_id, created_by_snapshot_json,
            created_by_legacy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `)
        .run(
          id,
          input.topicId,
          input.title,
          input.decision,
          input.rationale,
          JSON.stringify(input.alternatives),
          input.status,
          actor.actorId,
          serializeActorSnapshot(actorSnapshot),
          now,
          now,
        );
      const topicStatus: TopicStatus = input.status === "accepted" ? "decided" : "open";
      this.#context.database
        .prepare("UPDATE topics SET status = ?, updated_at = ? WHERE id = ?")
        .run(topicStatus, now, input.topicId);
      const row = this.#context.database
        .prepare("SELECT * FROM decisions WHERE id = ?")
        .get(id) as unknown as DecisionRow;
      return decisionFromRow(row);
    });
  }

  /**
   * 原地接受一个或多个拟议决策。accepted 重放是幂等的；rejected/superseded 不允许复活。
   * 只要仍有 proposed，议题保持 open；最后一条完成后才进入 decided，v13 触发器也在
   * 同一个边界关闭 RuntimeBinding 与 DiscussionCycle。
   */
  acceptAsActor(input: {
    topicId: string;
    decisionIds: string[];
    actorId: string;
  }): Decision[] {
    const decisionIds = [...new Set(input.decisionIds)];
    if (decisionIds.length === 0 || decisionIds.length !== input.decisionIds.length) {
      throw new CouncilConflictError("接受决策必须提供非空且不重复的 decisionIds。");
    }
    return this.#context.transaction(() => {
      this.#topics.get(input.topicId);
      const actor = this.#context.activeActorById(input.actorId);
      if (actor.actorId !== "human") {
        throw new CouncilConflictError("Accepted 决策必须由用户确认。");
      }
      const placeholders = decisionIds.map(() => "?").join(", ");
      const rows = this.#context.database.prepare(`
        SELECT * FROM decisions
        WHERE topic_id = ? AND id IN (${placeholders})
      `).all(input.topicId, ...decisionIds) as unknown as DecisionRow[];
      if (rows.length !== decisionIds.length) {
        throw new CouncilNotFoundError("部分决策不存在或不属于当前议题。");
      }
      const invalid = rows.find(
        (row) => row.status !== "proposed" && row.status !== "accepted",
      );
      if (invalid) {
        throw new CouncilConflictError("已拒绝或已被取代的决策不能重新接受。");
      }

      const now = new Date().toISOString();
      const update = this.#context.database.prepare(`
        UPDATE decisions
        SET status = 'accepted', updated_at = ?
        WHERE id = ? AND topic_id = ? AND status = 'proposed'
      `);
      for (const decisionId of decisionIds) {
        update.run(now, decisionId, input.topicId);
      }
      const remaining = this.#context.database.prepare(`
        SELECT COUNT(*) AS count
        FROM decisions
        WHERE topic_id = ? AND status = 'proposed'
      `).get(input.topicId) as unknown as CountRow;
      const topicStatus: TopicStatus = remaining.count === 0 ? "decided" : "open";
      this.#context.database.prepare("UPDATE topics SET status = ?, updated_at = ? WHERE id = ?")
        .run(topicStatus, now, input.topicId);

      const updatedRows = this.#context.database.prepare(`
        SELECT * FROM decisions
        WHERE topic_id = ? AND id IN (${placeholders})
      `).all(input.topicId, ...decisionIds) as unknown as DecisionRow[];
      const byId = new Map(updatedRows.map((row) => [row.id, decisionFromRow(row)]));
      return decisionIds.map((decisionId) => {
        const decision = byId.get(decisionId);
        if (!decision) {
          throw new CouncilNotFoundError("接受后的决策记录缺失。");
        }
        return decision;
      });
    });
  }
}
