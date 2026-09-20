/**
 * @input  依赖：议题、决策、实施项、委派和圆桌的真实当前状态
 * @output 导出：同项目按议题聚合的待处理摘要
 * @pos    无独立通知状态；源状态解决后条目自动消失，不把历史失败当作新待办
 */
import { DatabaseSync } from "node:sqlite";

export interface WorkAttention {
  topicId: string;
  title: string;
  decisions: number;
  acceptance: number;
  blocked: number;
  failures: number;
  questions: number;
}

export class WorkAttentionStore {
  readonly #database: DatabaseSync;
  constructor(databasePath: string, busyTimeoutMs: number) {
    this.#database = new DatabaseSync(databasePath, { readOnly: true });
    this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  }

  list(projectPath: string | undefined): WorkAttention[] {
    return this.#database.prepare(`
      WITH latest_delegations AS (
        SELECT d.* FROM work_item_delegations d WHERE d.rowid = (
          SELECT rowid FROM work_item_delegations WHERE work_item_id = d.work_item_id
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        )
      ), attention AS (
        SELECT t.id AS topicId, t.title,
          (SELECT count(*) FROM decisions d WHERE d.topic_id = t.id AND d.status = 'proposed' AND t.status = 'open') AS decisions,
          (SELECT count(*) FROM latest_delegations d JOIN work_items w ON w.id = d.work_item_id
            WHERE d.topic_id = t.id AND d.status = 'approved' AND d.completion_policy = 'human'
            AND w.status <> 'completed') AS acceptance,
          (SELECT count(*) FROM work_items w WHERE w.topic_id = t.id
            AND (w.status = 'blocked' OR (w.severity = 'blocking' AND w.status <> 'completed'))
            AND NOT EXISTS (SELECT 1 FROM work_items child WHERE child.parent_id = w.id))
          + (SELECT count(*) FROM discussion_cycles c WHERE c.topic_id = t.id AND t.status = 'open'
            AND c.status = 'abandoned' AND json_extract(c.outcome_json, '$.kind') = 'blocking_disagreements'
            AND c.rowid = (SELECT rowid FROM discussion_cycles WHERE topic_id = t.id ORDER BY created_at DESC, rowid DESC LIMIT 1)) AS blocked,
          (SELECT count(*) FROM latest_delegations d JOIN work_items w ON w.id = d.work_item_id
            WHERE d.topic_id = t.id AND d.status = 'failed' AND w.status <> 'completed')
          + (SELECT count(*) FROM orchestration_runs r WHERE r.topic_id = t.id AND r.status = 'failed'
            AND t.status = 'open' AND r.rowid = (SELECT rowid FROM orchestration_runs WHERE topic_id = t.id ORDER BY created_at DESC, rowid DESC LIMIT 1)) AS failures,
          (SELECT count(*) FROM discussion_cycles c WHERE c.topic_id = t.id AND c.status = 'active'
            AND c.stage IN ('awaiting_user', 'await_fix') AND t.status = 'open')
          + (SELECT count(*) FROM orchestration_runs r WHERE r.topic_id = t.id AND r.status = 'waiting_user' AND t.status = 'open') AS questions
        FROM topics t WHERE t.project_path IS ? AND t.status <> 'closed'
      ) SELECT * FROM attention WHERE decisions + acceptance + blocked + failures + questions > 0
      ORDER BY failures DESC, blocked DESC, questions DESC, acceptance DESC, topicId
    `).all(projectPath ?? null) as unknown as WorkAttention[];
  }
  close(): void { this.#database.close(); }
}
