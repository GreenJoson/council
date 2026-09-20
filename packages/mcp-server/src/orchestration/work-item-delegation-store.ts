/**
 * @input  依赖：canonical v14 work_item_delegations 表与 SQLite busy timeout
 * @output 导出：WorkItemDelegationStore、公开委派快照与原子状态更新
 * @pos    跨 Agent 任务委派的唯一持久化层；worktree 路径只供本地执行，不进入公开 DTO
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { DatabaseSync } from "node:sqlite";
import type { AgentPermissionProfile } from "../agent-execution-policy.js";

export const WORK_ITEM_DELEGATION_STATUSES = [
  "queued",
  "executing",
  "reviewing",
  "changes_requested",
  "approved",
  "failed",
  "cancelled",
] as const;

export type WorkItemDelegationStatus = (typeof WORK_ITEM_DELEGATION_STATUSES)[number];
export type DelegationExecutionPermission = Exclude<AgentPermissionProfile, "read_only">;

export interface WorkItemDelegation {
  id: string;
  topicId: string;
  workItemId: string;
  supervisorAgentId: string;
  executorAgentId: string;
  permissionProfile: DelegationExecutionPermission;
  resumedFromId?: string;
  failureCode?: string;
  completionPolicy: "review" | "human";
  acceptanceCriteria: string;
  status: WorkItemDelegationStatus;
  attempt: number;
  maxAttempts: number;
  baseCommit?: string;
  headCommit?: string;
  branchName?: string;
  executorSessionId?: string;
  supervisorSessionId?: string;
  summary?: string;
  review?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface DelegationRow {
  id: string;
  topic_id: string;
  work_item_id: string;
  supervisor_agent_id: string;
  executor_agent_id: string;
  permission_profile: DelegationExecutionPermission;
  resumed_from_id: string | null;
  failure_code: string | null;
  completion_policy: "review" | "human";
  acceptance_criteria: string;
  status: WorkItemDelegationStatus;
  attempt: number;
  max_attempts: number;
  base_commit: string | null;
  head_commit: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  executor_session_id: string | null;
  supervisor_session_id: string | null;
  summary: string | null;
  review: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function publicDelegation(row: DelegationRow): WorkItemDelegation {
  return {
    id: row.id,
    topicId: row.topic_id,
    workItemId: row.work_item_id,
    supervisorAgentId: row.supervisor_agent_id,
    executorAgentId: row.executor_agent_id,
    permissionProfile: row.permission_profile,
    ...(row.resumed_from_id ? { resumedFromId: row.resumed_from_id } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    completionPolicy: row.completion_policy,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
    ...(row.head_commit ? { headCommit: row.head_commit } : {}),
    ...(row.branch_name ? { branchName: row.branch_name } : {}),
    ...(row.executor_session_id ? { executorSessionId: row.executor_session_id } : {}),
    ...(row.supervisor_session_id ? { supervisorSessionId: row.supervisor_session_id } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.review ? { review: row.review } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export interface DelegationPrivateState extends WorkItemDelegation {
  worktreePath?: string;
}

export interface CreateWorkItemDelegationInput {
  id: string;
  topicId: string;
  workItemId: string;
  supervisorAgentId: string;
  executorAgentId: string;
  permissionProfile: DelegationExecutionPermission;
  resumedFromId?: string;
  failureCode?: string;
  completionPolicy: "review" | "human";
  acceptanceCriteria: string;
  maxAttempts: number;
  branchName?: string;
  now: string;
}

function privateDelegation(row: DelegationRow): DelegationPrivateState {
  return {
    ...publicDelegation(row),
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
  };
}

export class WorkItemDelegationStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string, busyTimeoutMs: number) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
  }

  #insert(input: CreateWorkItemDelegationInput): void {
    this.#database.prepare(`
      INSERT INTO work_item_delegations (
        id, topic_id, work_item_id, supervisor_agent_id, executor_agent_id,
        permission_profile, status, attempt, max_attempts, branch_name,
        created_at, updated_at, completion_policy, acceptance_criteria, resumed_from_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.topicId,
      input.workItemId,
      input.supervisorAgentId,
      input.executorAgentId,
      input.permissionProfile,
      input.maxAttempts,
      input.branchName ?? null,
      input.now,
      input.now,
      input.completionPolicy,
      input.acceptanceCriteria,
      input.resumedFromId ?? null,
    );
  }

  create(input: CreateWorkItemDelegationInput): WorkItemDelegation {
    this.#insert(input);
    return this.get(input.id) as WorkItemDelegation;
  }

  /** 批量入口必须全有或全无，不能让半条队列在唯一约束冲突后留在任务页。 */
  createMany(inputs: readonly CreateWorkItemDelegationInput[]): WorkItemDelegation[] {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const input of inputs) {
        this.#insert(input);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return inputs.map((input) => this.get(input.id) as WorkItemDelegation);
  }

  get(id: string): WorkItemDelegation | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM work_item_delegations WHERE id = ?
    `).get(id) as unknown as DelegationRow | undefined;
    return row ? publicDelegation(row) : undefined;
  }

  getPrivate(id: string): DelegationPrivateState | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM work_item_delegations WHERE id = ?
    `).get(id) as unknown as DelegationRow | undefined;
    return row ? privateDelegation(row) : undefined;
  }

  list(topicId: string): WorkItemDelegation[] {
    return (this.#database.prepare(`
      SELECT * FROM work_item_delegations
      WHERE topic_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(topicId) as unknown as DelegationRow[]).map(publicDelegation);
  }

  update(id: string, patch: {
    status?: WorkItemDelegationStatus;
    attempt?: number;
    baseCommit?: string;
    headCommit?: string;
    branchName?: string;
    worktreePath?: string;
    executorSessionId?: string;
    supervisorSessionId?: string;
    summary?: string;
    review?: string;
    error?: string;
    completedAt?: string;
    failureCode?: string;
    now: string;
  }): WorkItemDelegation {
    const current = this.getPrivate(id);
    if (!current) {
      throw new Error("委派记录不存在。");
    }
    const status = patch.status ?? current.status;
    const terminal = status === "approved" || status === "failed" || status === "cancelled";
    const completedAt = terminal ? patch.completedAt ?? current.completedAt ?? patch.now : null;
    const result = this.#database.prepare(`
      UPDATE work_item_delegations
      SET status = ?, attempt = ?, base_commit = ?, head_commit = ?, branch_name = ?,
          worktree_path = ?, executor_session_id = ?, supervisor_session_id = ?,
          summary = ?, review = ?, error = ?, updated_at = ?, completed_at = ?, failure_code = ?
      WHERE id = ?
    `).run(
      status,
      patch.attempt ?? current.attempt,
      patch.baseCommit ?? current.baseCommit ?? null,
      patch.headCommit ?? current.headCommit ?? null,
      patch.branchName ?? current.branchName ?? null,
      patch.worktreePath ?? current.worktreePath ?? null,
      patch.executorSessionId ?? current.executorSessionId ?? null,
      patch.supervisorSessionId ?? current.supervisorSessionId ?? null,
      patch.summary ?? current.summary ?? null,
      patch.review ?? current.review ?? null,
      patch.error ?? current.error ?? null,
      patch.now,
      completedAt,
      patch.failureCode ?? current.failureCode ?? null,
      id,
    );
    if (result.changes !== 1) {
      throw new Error("委派记录更新失败。");
    }
    return this.get(id) as WorkItemDelegation;
  }

  markInterrupted(now: string): string[] {
    const rows = this.#database.prepare(`
      UPDATE work_item_delegations
      SET status = 'failed', error = '服务重启中断了执行，请检查后恢复已提交进度或重新委派。', failure_code = 'interrupted',
          updated_at = ?, completed_at = ?
      WHERE status IN ('queued', 'executing', 'reviewing', 'changes_requested')
      RETURNING id
    `).all(now, now) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  close(): void {
    this.#database.close();
  }
}
