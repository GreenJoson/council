/**
 * @input  依赖：共享数据库上下文、议题存在性查找、行映射/父状态派生规则与安全错误语义
 * @output 导出：WorkItemRepository —— 叶子口径的完成度批量查询、议题全量行读取、
 *         批量建项（手工拆解须绑定 Accepted 决策、审核发现可无决策、子项继承父决策锚点）、
 *         乐观版本更新、认领、祖先状态派生与过滤列表
 * @pos    实施项领域仓储；父任务状态只由子任务派生，任何写入路径都不接受手动设置
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { serializeActorSnapshot, toActorSnapshot } from "../actor-identity.js";
import { CouncilConflictError, CouncilNotFoundError } from "../errors.js";
import type {
  WorkItem,
  WorkItemOrigin,
  WorkItemProgress,
  WorkItemSeverity,
  WorkItemStatus,
} from "../types.js";
import type { DatabaseContext, TopicLookup } from "./context.js";
import {
  deriveParentStatus,
  workItemFromRow,
  type DecisionReferenceRow,
  type WorkItemProgressRow,
  type WorkItemRow,
} from "./rows.js";

export class WorkItemRepository {
  readonly #context: DatabaseContext;
  readonly #topics: TopicLookup;

  constructor(context: DatabaseContext, topics: TopicLookup) {
    this.#context = context;
    this.#topics = topics;
  }

  /**
   * 只统计叶子节点：父任务的状态本来就是子任务汇总出来的，
   * 再把它计入分母等于同一件事数两次，界面上的「12 / 15」会凭空变大。
   */
  readProgress(topicIds: readonly string[]): Map<string, WorkItemProgress> {
    const progress = new Map<string, WorkItemProgress>();
    if (topicIds.length === 0) {
      return progress;
    }
    const placeholders = topicIds.map(() => "?").join(", ");
    const rows = this.#context.database.prepare(`
      SELECT
        topic_id,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(
          CASE
            WHEN origin = 'review_finding'
              AND severity = 'blocking'
              AND status <> 'completed'
            THEN 1 ELSE 0
          END
        ) AS open_blocking
      FROM work_items AS item
      WHERE topic_id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM work_items AS child WHERE child.parent_id = item.id
        )
      GROUP BY topic_id
    `).all(...topicIds) as unknown as WorkItemProgressRow[];
    for (const row of rows) {
      progress.set(row.topic_id, {
        total: row.total,
        completed: row.completed,
        blocked: row.blocked,
        openBlockingFindings: row.open_blocking,
      });
    }
    return progress;
  }

  /**
   * 议题详情用：按树序取全部实施项。返回行而不是领域对象，
   * 因为详情还要用同一批行就地汇总完成度（summarizeWorkItemProgress 只认行）。
   */
  listRowsByTopic(topicId: string): WorkItemRow[] {
    return this.#context.database
      .prepare(`
        SELECT * FROM work_items
        WHERE topic_id = ?
        ORDER BY parent_key ASC, sort_order ASC, created_at ASC, rowid ASC
      `)
      .all(topicId) as unknown as WorkItemRow[];
  }

  create(input: {
    topicId: string;
    decisionId?: string;
    parentId?: string;
    items: Array<{ title: string; details?: string }>;
    createdByAlias: string;
  }): WorkItem[] {
    const actor = this.#context.resolveActorAlias(input.createdByAlias);
    return this.createAsActor({
      topicId: input.topicId,
      ...(input.decisionId ? { decisionId: input.decisionId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      items: input.items,
      actorId: actor.actorId,
    });
  }

  createAsActor(input: {
    topicId: string;
    decisionId?: string;
    /** 给了就挂到这个父任务下；父任务的决策锚点会被继承。 */
    parentId?: string;
    origin?: WorkItemOrigin;
    sourceCycleId?: string;
    reviewRound?: number;
    items: Array<{
      title: string;
      details?: string;
      severity?: WorkItemSeverity;
      sourceMessageId?: string;
    }>;
    actorId: string;
  }): WorkItem[] {
    if (input.items.length === 0) {
      throw new CouncilConflictError("至少需要一个实施项。");
    }
    const origin: WorkItemOrigin = input.origin ?? "manual";
    const normalizedItems = input.items.map((item) => ({
      title: item.title.trim(),
      details: item.details?.trim() ?? "",
      severity: item.severity,
      sourceMessageId: item.sourceMessageId,
    }));
    if (normalizedItems.some((item) => !item.title)) {
      throw new CouncilConflictError("实施项标题不能为空。");
    }
    if (origin === "review_finding" && normalizedItems.some((item) => !item.severity)) {
      throw new CouncilConflictError("审核发现必须声明 blocking 或 non_blocking。");
    }
    const normalizedTitles = new Set(normalizedItems.map((item) => item.title.toLowerCase()));
    if (normalizedTitles.size !== normalizedItems.length) {
      throw new CouncilConflictError("同一批实施项不能包含重复标题。");
    }

    const now = new Date().toISOString();
    return this.#context.transaction(() => {
      this.#topics.get(input.topicId);
      const actor = this.#context.activeActorById(input.actorId);
      const actorSnapshot = toActorSnapshot(actor);
      const actorSnapshotJson = serializeActorSnapshot(actorSnapshot);

      const parent = input.parentId
        ? this.#requireWorkItem(input.parentId, input.topicId)
        : undefined;
      const decisionId = parent
        // 子任务不自己选决策：它属于父任务所属的那次决策，否则一棵树会横跨两个 ADR。
        ? parent.decision_id
        : this.#resolveDecisionId(input.topicId, input.decisionId, origin);

      const duplicateQuery = this.#context.database.prepare(`
        SELECT id FROM work_items
        WHERE topic_id = ? AND parent_key = ? AND title = ? COLLATE NOCASE
      `);
      const nextSortOrder = this.#context.database.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS value
        FROM work_items WHERE topic_id = ? AND parent_key = ?
      `).get(input.topicId, input.parentId ?? "") as unknown as { value: number };
      const insert = this.#context.database.prepare(`
        INSERT INTO work_items (
          id, topic_id, decision_id, parent_id, title, details,
          status, status_note, version, sort_order, origin, severity,
          source_message_id, source_cycle_id, review_round,
          created_by_actor_id, created_by_snapshot_json,
          updated_by_actor_id, updated_by_snapshot_json,
          created_at, updated_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          'pending', NULL, 1, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?, NULL
        )
      `);
      const createdIds: string[] = [];
      let sortOrder = nextSortOrder.value;
      for (const item of normalizedItems) {
        if (duplicateQuery.get(input.topicId, input.parentId ?? "", item.title)) {
          throw new CouncilConflictError(`实施项“${item.title}”已经存在。`);
        }
        const id = `work_item_${randomUUID()}`;
        insert.run(
          id,
          input.topicId,
          decisionId,
          input.parentId ?? null,
          item.title,
          item.details,
          sortOrder,
          origin,
          item.severity ?? null,
          item.sourceMessageId ?? null,
          input.sourceCycleId ?? null,
          input.reviewRound ?? null,
          actor.actorId,
          actorSnapshotJson,
          actor.actorId,
          actorSnapshotJson,
          now,
          now,
        );
        createdIds.push(id);
        sortOrder += 1;
      }
      if (input.parentId) {
        // 新子任务会把一个已完成的父任务重新拉回进行中，这一步不能省。
        this.#recomputeAncestors(input.parentId, actor.actorId, actorSnapshotJson, now);
      }
      this.#context.database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(
        now,
        input.topicId,
      );
      const read = this.#context.database.prepare("SELECT * FROM work_items WHERE id = ?");
      return createdIds.map((id) => workItemFromRow(read.get(id) as unknown as WorkItemRow));
    });
  }

  /**
   * 手工拆解仍然要求先有 Accepted 决策——那是「先定架构再执行」的闸门。
   * 审核发现例外：commit 互审可能发生在议题还没产出任何决策的时候，
   * 若强行要求决策，评审挑出的问题就无处落账，只能散在讨论消息里。
   */
  #resolveDecisionId(
    topicId: string,
    decisionId: string | undefined,
    origin: WorkItemOrigin,
  ): string | null {
    const decision = decisionId
      ? this.#context.database.prepare(`
          SELECT id, status FROM decisions WHERE id = ? AND topic_id = ?
        `).get(decisionId, topicId) as unknown as DecisionReferenceRow | undefined
      : this.#context.database.prepare(`
          SELECT id, status FROM decisions
          WHERE topic_id = ? AND status = 'accepted'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `).get(topicId) as unknown as DecisionReferenceRow | undefined;
    if (!decision) {
      if (origin === "review_finding") {
        return null;
      }
      throw new CouncilNotFoundError("当前议题没有可绑定的 Accepted 决策。");
    }
    if (decision.status !== "accepted") {
      throw new CouncilConflictError("实施项只能绑定 Accepted 决策。");
    }
    return decision.id;
  }

  #requireWorkItem(workItemId: string, topicId: string): WorkItemRow {
    const row = this.#context.database.prepare(`
      SELECT * FROM work_items WHERE id = ? AND topic_id = ?
    `).get(workItemId, topicId) as unknown as WorkItemRow | undefined;
    if (!row) {
      throw new CouncilNotFoundError(`实施项 ${workItemId} 不存在。`);
    }
    return row;
  }

  #hasChildren(workItemId: string): boolean {
    const row = this.#context.database.prepare(`
      SELECT EXISTS(SELECT 1 FROM work_items WHERE parent_id = ?) AS value
    `).get(workItemId) as unknown as { value: number };
    return row.value === 1;
  }

  /**
   * 父任务状态完全由子任务派生，任何一条写入路径都不接受手动设置。
   * 允许手动改父状态，就等于允许「父已完成、子未完成」这种自相矛盾的账本，
   * Agent 也会直接把父节点标完成来跳过实际交付。
   */
  #recomputeAncestors(
    fromWorkItemId: string,
    actorId: string,
    actorSnapshotJson: string,
    now: string,
  ): void {
    const readChildStatuses = this.#context.database.prepare(`
      SELECT status FROM work_items WHERE parent_id = ?
    `);
    const update = this.#context.database.prepare(`
      UPDATE work_items
      SET status = ?, version = version + 1,
          updated_by_actor_id = ?, updated_by_snapshot_json = ?,
          updated_at = ?, completed_at = ?
      WHERE id = ?
    `);
    let cursor: string | null = fromWorkItemId;
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(cursor)) {
        throw new CouncilConflictError("实施项父子关系存在环，已停止派生。");
      }
      visited.add(cursor);
      const current: WorkItemRow | undefined = this.#context.database.prepare(`
        SELECT * FROM work_items WHERE id = ?
      `).get(cursor) as unknown as WorkItemRow | undefined;
      if (!current) {
        return;
      }
      const childStatuses = (readChildStatuses.all(cursor) as unknown as Array<{
        status: WorkItemStatus;
      }>).map((row) => row.status);
      if (childStatuses.length > 0) {
        const derived = deriveParentStatus(childStatuses);
        if (derived !== current.status) {
          update.run(
            derived,
            actorId,
            actorSnapshotJson,
            now,
            derived === "completed" ? current.completed_at ?? now : null,
            cursor,
          );
        }
      }
      cursor = current.parent_id;
    }
  }

  update(input: {
    topicId: string;
    workItemId: string;
    status: WorkItemStatus;
    expectedVersion: number;
    statusNote?: string;
    fixCommit?: string;
    updatedByAlias: string;
  }): WorkItem {
    const actor = this.#context.resolveActorAlias(input.updatedByAlias);
    return this.updateAsActor({
      topicId: input.topicId,
      workItemId: input.workItemId,
      status: input.status,
      expectedVersion: input.expectedVersion,
      ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
      ...(input.fixCommit !== undefined ? { fixCommit: input.fixCommit } : {}),
      actorId: actor.actorId,
    });
  }

  updateAsActor(input: {
    topicId: string;
    workItemId: string;
    status: WorkItemStatus;
    expectedVersion: number;
    statusNote?: string;
    fixCommit?: string;
    actorId: string;
  }): WorkItem {
    const now = new Date().toISOString();
    return this.#context.transaction(() => {
      this.#topics.get(input.topicId);
      const current = this.#requireWorkItem(input.workItemId, input.topicId);
      if (current.version !== input.expectedVersion) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (this.#hasChildren(input.workItemId)) {
        throw new CouncilConflictError(
          "这是一个父任务，状态由子任务派生；请更新它的子任务。",
        );
      }
      const actor = this.#context.activeActorById(input.actorId);
      const latestDelegation = this.#context.database.prepare(`
        SELECT completion_policy FROM work_item_delegations WHERE work_item_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(input.workItemId) as { completion_policy: string } | undefined;
      if (input.status === "completed" && latestDelegation?.completion_policy === "human"
        && (actor.actorId !== "human" || !input.statusNote?.trim())) {
        throw new CouncilConflictError("实施项需要人工填写验收证据后才能完成。");
      }
      const actorSnapshotJson = serializeActorSnapshot(toActorSnapshot(actor));
      const statusNote = input.statusNote === undefined
        ? current.status_note
        : input.statusNote.trim() || null;
      const fixCommit = input.fixCommit === undefined
        ? current.fix_commit
        : input.fixCommit.trim() || null;
      const completedAt = input.status === "completed"
        ? current.completed_at ?? now
        : null;
      const result = this.#context.database.prepare(`
        UPDATE work_items
        SET status = ?, status_note = ?, fix_commit = ?, version = version + 1,
            updated_by_actor_id = ?, updated_by_snapshot_json = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND topic_id = ? AND version = ?
      `).run(
        input.status,
        statusNote,
        fixCommit,
        actor.actorId,
        actorSnapshotJson,
        now,
        completedAt,
        input.workItemId,
        input.topicId,
        input.expectedVersion,
      );
      if (result.changes !== 1) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (current.parent_id) {
        this.#recomputeAncestors(current.parent_id, actor.actorId, actorSnapshotJson, now);
      }
      this.#context.database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(
        now,
        input.topicId,
      );
      const updated = this.#context.database
        .prepare("SELECT * FROM work_items WHERE id = ?")
        .get(input.workItemId) as unknown as WorkItemRow;
      return workItemFromRow(updated);
    });
  }

  /**
   * 认领一条待办：写上执行者并置为进行中。
   * 这是「外部 Agent 在做什么」唯一可信的来源——它开工前必须先在账本上签名，
   * 界面才能显示是谁正在修哪一条，而不是只看到一个跑了很久的黑箱。
   */
  claimAsActor(input: {
    topicId: string;
    workItemId: string;
    expectedVersion: number;
    statusNote?: string;
    actorId: string;
  }): WorkItem {
    const now = new Date().toISOString();
    return this.#context.transaction(() => {
      this.#topics.get(input.topicId);
      const current = this.#requireWorkItem(input.workItemId, input.topicId);
      if (current.version !== input.expectedVersion) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (this.#hasChildren(input.workItemId)) {
        throw new CouncilConflictError("父任务不能被认领；请认领它的子任务。");
      }
      if (current.status === "completed") {
        throw new CouncilConflictError("这条实施项已经完成，无需认领。");
      }
      const actor = this.#context.activeActorById(input.actorId);
      const actorSnapshotJson = serializeActorSnapshot(toActorSnapshot(actor));
      const statusNote = input.statusNote === undefined
        ? current.status_note
        : input.statusNote.trim() || null;
      const result = this.#context.database.prepare(`
        UPDATE work_items
        SET status = 'in_progress', status_note = ?, version = version + 1,
            assignee_actor_id = ?, claimed_at = ?,
            updated_by_actor_id = ?, updated_by_snapshot_json = ?,
            updated_at = ?, completed_at = NULL
        WHERE id = ? AND topic_id = ? AND version = ?
      `).run(
        statusNote,
        actor.actorId,
        now,
        actor.actorId,
        actorSnapshotJson,
        now,
        input.workItemId,
        input.topicId,
        input.expectedVersion,
      );
      if (result.changes !== 1) {
        throw new CouncilConflictError("实施项已被其他参与者更新，请刷新后重试。");
      }
      if (current.parent_id) {
        this.#recomputeAncestors(current.parent_id, actor.actorId, actorSnapshotJson, now);
      }
      this.#context.database.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(
        now,
        input.topicId,
      );
      const updated = this.#context.database
        .prepare("SELECT * FROM work_items WHERE id = ?")
        .get(input.workItemId) as unknown as WorkItemRow;
      return workItemFromRow(updated);
    });
  }

  list(input: {
    topicId: string;
    status?: WorkItemStatus;
    assigneeActorId?: string;
    origin?: WorkItemOrigin;
  }): WorkItem[] {
    this.#topics.get(input.topicId);
    const conditions = ["topic_id = ?"];
    const parameters: Array<string | number> = [input.topicId];
    if (input.status) {
      conditions.push("status = ?");
      parameters.push(input.status);
    }
    if (input.assigneeActorId) {
      conditions.push("assignee_actor_id = ?");
      parameters.push(input.assigneeActorId);
    }
    if (input.origin) {
      conditions.push("origin = ?");
      parameters.push(input.origin);
    }
    const rows = this.#context.database.prepare(`
      SELECT * FROM work_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY parent_key ASC, sort_order ASC, created_at ASC, rowid ASC
    `).all(...parameters) as unknown as WorkItemRow[];
    return rows.map(workItemFromRow);
  }
}
