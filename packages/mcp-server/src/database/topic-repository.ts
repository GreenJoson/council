/**
 * @input  依赖：共享数据库上下文、消息/决策/实施项仓储、行映射与安全错误语义
 * @output 导出：TopicRepository —— 动态 alias/可信 actorId 建题、显式并发令牌的议题更正、
 *         安全关闭（仍有活动圆桌/Agent 会话/委派即拒绝）、单题读取、详情聚合与带完成度的分页列表
 * @pos    议题领域仓储；详情就地汇总实施项完成度，列表按叶子口径批量查询，两处口径一致
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { serializeActorSnapshot, toActorSnapshot } from "../actor-identity.js";
import { CouncilConflictError, CouncilNotFoundError } from "../errors.js";
import type { PaginatedTopics, Topic, TopicDetail, TopicStatus } from "../types.js";
import type { DatabaseContext } from "./context.js";
import type { DecisionRepository } from "./decision-repository.js";
import type { MessageRepository } from "./message-repository.js";
import {
  summarizeWorkItemProgress,
  topicFromRow,
  withWorkItemProgress,
  workItemFromRow,
  type CountRow,
  type TopicRow,
} from "./rows.js";
import type { WorkItemRepository } from "./work-item-repository.js";

export class TopicRepository {
  readonly #context: DatabaseContext;
  readonly #messages: MessageRepository;
  readonly #decisions: DecisionRepository;
  readonly #workItems: WorkItemRepository;

  constructor(
    context: DatabaseContext,
    repositories: {
      messages: MessageRepository;
      decisions: DecisionRepository;
      workItems: WorkItemRepository;
    },
  ) {
    this.#context = context;
    this.#messages = repositories.messages;
    this.#decisions = repositories.decisions;
    this.#workItems = repositories.workItems;
  }

  create(input: {
    title: string;
    question: string;
    constraints: string[];
    projectPath?: string;
    createdByAlias: string;
  }): Topic {
    const actor = this.#context.resolveActorAlias(input.createdByAlias);
    return this.createAsActor({
      title: input.title,
      question: input.question,
      constraints: input.constraints,
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      actorId: actor.actorId,
    });
  }

  createAsActor(input: {
    title: string;
    question: string;
    constraints: string[];
    projectPath?: string;
    actorId: string;
  }): Topic {
    const id = `topic_${randomUUID()}`;
    const now = new Date().toISOString();
    return this.#context.transaction(() => {
      const actor = this.#context.activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      this.#context.database
        .prepare(`
          INSERT INTO topics (
            id, title, question, constraints_json, project_path,
            status, created_by_actor_id, created_by_snapshot_json,
            created_by_legacy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?, ?)
        `)
        .run(
          id,
          input.title,
          input.question,
          JSON.stringify(input.constraints),
          input.projectPath ?? null,
          actor.actorId,
          serializeActorSnapshot(actorSnapshot),
          now,
          now,
        );
      return this.get(id);
    });
  }

  /**
   * 更正仍在讨论中的议题框架。expectedUpdatedAt 是显式并发令牌：Agent 必须先读取最新
   * 议题再修改，不能用旧上下文覆盖另一位参与者刚刚补过的标题、问题或约束。
   */
  updateAsActor(input: {
    topicId: string;
    title?: string;
    question?: string;
    constraints?: string[];
    expectedUpdatedAt: string;
    actorId: string;
  }): Topic {
    return this.#context.transaction(() => {
      this.#context.activeActorById(input.actorId);
      const current = this.get(input.topicId);
      if (current.status !== "open") {
        throw new CouncilConflictError("议题已结束，不能再修改议题框架。");
      }
      if (current.updatedAt !== input.expectedUpdatedAt) {
        throw new CouncilConflictError("议题已被其他参与者更新，请重新读取后再修改。");
      }
      const title = input.title ?? current.title;
      const question = input.question ?? current.question;
      const constraints = input.constraints ?? current.constraints;
      if (
        title === current.title
        && question === current.question
        && JSON.stringify(constraints) === JSON.stringify(current.constraints)
      ) {
        return current;
      }
      const nowCandidate = new Date().toISOString();
      const now = nowCandidate === current.updatedAt
        ? new Date(Date.parse(current.updatedAt) + 1).toISOString()
        : nowCandidate;
      const result = this.#context.database.prepare(`
        UPDATE topics
        SET title = ?, question = ?, constraints_json = ?, updated_at = ?
        WHERE id = ? AND status = 'open' AND updated_at = ?
      `).run(
        title,
        question,
        JSON.stringify(constraints),
        now,
        input.topicId,
        input.expectedUpdatedAt,
      );
      if (result.changes !== 1) {
        throw new CouncilConflictError("议题状态已变化，请重新读取后再修改。");
      }
      return this.get(input.topicId);
    });
  }

  /**
   * 关闭是可审计的归档动作，不物理删除讨论历史。活动圆桌或持久会话必须先由编排服务
   * 正常停止；MCP 直连只允许关闭已经静止的议题，避免留下仍在写入的孤儿进程。
   */
  closeAsActor(input: { topicId: string; actorId: string }): Topic {
    return this.#context.transaction(() => {
      this.#context.activeActorById(input.actorId);
      const current = this.get(input.topicId);
      if (current.status === "closed") {
        return current;
      }
      const activeBindings = this.#context.database.prepare(`
        SELECT COUNT(*) AS count FROM runtime_bindings
        WHERE topic_id = ? AND status <> 'closed'
      `).get(input.topicId) as unknown as CountRow;
      const activeCycles = this.#context.database.prepare(`
        SELECT COUNT(*) AS count FROM discussion_cycles
        WHERE topic_id = ? AND status = 'active'
      `).get(input.topicId) as unknown as CountRow;
      const activeDelegations = this.#context.database.prepare(`
        SELECT COUNT(*) AS count FROM work_item_delegations WHERE topic_id = ?
          AND status IN ('queued', 'executing', 'reviewing', 'changes_requested')
      `).get(input.topicId) as unknown as CountRow;
      if (activeBindings.count > 0 || activeCycles.count > 0 || activeDelegations.count > 0) {
        throw new CouncilConflictError(
          "议题仍有活动圆桌、Agent 会话或任务委派，请先在桌面端停止运行再关闭。",
        );
      }
      const now = new Date().toISOString();
      this.#context.database.prepare(`
        UPDATE agent_sessions SET is_current = 0, updated_at = ?
        WHERE topic_id = ? AND is_current = 1
      `).run(now, input.topicId);
      this.#context.database.prepare(`
        UPDATE topics SET status = 'closed', updated_at = ? WHERE id = ?
      `).run(now, input.topicId);
      return this.get(input.topicId);
    });
  }

  get(topicId: string): Topic {
    const row = this.#context.database
      .prepare("SELECT * FROM topics WHERE id = ?")
      .get(topicId) as unknown as TopicRow | undefined;
    if (!row) {
      throw new CouncilNotFoundError(
        `议题 ${topicId} 不存在。请先调用 council_list_topics 或创建新议题。`,
      );
    }
    return topicFromRow(row);
  }

  getDetail(topicId: string, messageLimit: number, messageOffset = 0): TopicDetail {
    const topic = this.get(topicId);
    const messagePage = this.#messages.readPage(topicId, messageLimit, messageOffset);
    const decisions = this.#decisions.listByTopic(topicId);
    const workItemRows = this.#workItems.listRowsByTopic(topicId);
    const nextMessageOffset = messageOffset + messagePage.messages.length;
    const hasMoreMessages = nextMessageOffset < messagePage.total;
    return {
      // 详情已经手握全量实施项，就地汇总即可，不必为同一个数字再查一次库。
      topic: withWorkItemProgress(
        topic,
        summarizeWorkItemProgress(topicId, workItemRows),
      ),
      messages: messagePage.messages,
      decisions,
      workItems: workItemRows.map(workItemFromRow),
      messageTotal: messagePage.total,
      messageLimit,
      messageOffset,
      hasMoreMessages,
      ...(hasMoreMessages ? { nextMessageOffset } : {}),
    };
  }

  list(input: {
    projectPath?: string;
    status?: TopicStatus;
    limit: number;
    offset: number;
  }): PaginatedTopics {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.projectPath) {
      conditions.push("project_path = ?");
      parameters.push(input.projectPath);
    }
    if (input.status) {
      conditions.push("status = ?");
      parameters.push(input.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countRow = this.#context.database
      .prepare(`SELECT COUNT(*) AS count FROM topics ${where}`)
      .get(...parameters) as unknown as CountRow;
    const rows = this.#context.database
      .prepare(`SELECT * FROM topics ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...parameters, input.limit, input.offset) as unknown as TopicRow[];
    const nextOffset = input.offset + rows.length;
    const hasMore = nextOffset < countRow.count;
    const progress = this.#workItems.readProgress(rows.map((row) => row.id));
    return {
      total: countRow.count,
      count: rows.length,
      offset: input.offset,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      topics: rows.map((row) => withWorkItemProgress(topicFromRow(row), progress)),
    };
  }
}
