/**
 * @input  依赖：node:sqlite（v20 task_teams / task_workers / actor_aliases）、委派公开快照
 * @output 导出：TeamStore（团队与 Worker 行的读写、Lead 执行者别名查询）、TaskTeamRecord / TaskWorkerRecord、
 *         TaskWorkerStatus 与 deriveWorkerStatus（委派状态 → Worker 状态的唯一映射）
 * @pos    Worker 团队的持久层；HTTP 进程（TeamService）读写，stdio MCP 进程（团队工具）只读
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { DatabaseSync } from "node:sqlite";
import { CouncilConflictError } from "../errors.js";
import type { WorkItemDelegation } from "../orchestration/work-item-delegation-store.js";

export type TaskTeamStatus = "active" | "ended";
export type TaskWorkerStatus = "idle" | "running" | "done" | "error" | "archived";

export interface TaskTeamRecord {
  id: string;
  workItemId: string;
  leadDelegationId: string;
  status: TaskTeamStatus;
  maxParallel: number;
  createdAt: string;
  endedAt?: string;
}

export interface TaskWorkerRecord {
  id: string;
  teamId: string;
  delegationId: string;
  label: string;
  role?: string;
  status: TaskWorkerStatus;
  focused: boolean;
  mergedCommit?: string;
  scopePaths: string[];
  createdAt: string;
  updatedAt: string;
}

interface TeamRow {
  id: string;
  work_item_id: string;
  lead_delegation_id: string;
  status: TaskTeamStatus;
  max_parallel: number;
  created_at: string;
  ended_at: string | null;
}

interface WorkerRow {
  id: string;
  team_id: string;
  delegation_id: string;
  label: string;
  role: string | null;
  status: TaskWorkerStatus;
  focused: number;
  merged_commit: string | null;
  scope_paths_json: string;
  created_at: string;
  updated_at: string;
}

function team(row: TeamRow): TaskTeamRecord {
  return {
    id: row.id, workItemId: row.work_item_id, leadDelegationId: row.lead_delegation_id,
    status: row.status, maxParallel: row.max_parallel, createdAt: row.created_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

function worker(row: WorkerRow): TaskWorkerRecord {
  return {
    id: row.id, teamId: row.team_id, delegationId: row.delegation_id, label: row.label,
    ...(row.role ? { role: row.role } : {}),
    status: row.status, focused: row.focused === 1,
    ...(row.merged_commit ? { mergedCommit: row.merged_commit } : {}),
    scopePaths: JSON.parse(row.scope_paths_json) as string[],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * Worker 状态以委派状态为准，只有 archived 是人工/Lead 操作写入的粘性状态：
 * queued→idle；executing/reviewing/changes_requested→running；approved→done；failed/cancelled→error。
 */
export function deriveWorkerStatus(stored: TaskWorkerStatus, delegation: WorkItemDelegation | undefined): TaskWorkerStatus {
  if (stored === "archived") return "archived";
  if (!delegation) return stored;
  switch (delegation.status) {
    case "queued": return "idle";
    case "approved": return "done";
    case "failed":
    case "cancelled": return "error";
    default: return "running";
  }
}

export class TeamStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string, busyTimeoutMs: number) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
  }

  createTeam(input: { id: string; workItemId: string; leadDelegationId: string; maxParallel: number; now: string }): TaskTeamRecord {
    try {
      this.#database.prepare(`
        INSERT INTO task_teams (id, work_item_id, lead_delegation_id, status, max_parallel, created_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(input.id, input.workItemId, input.leadDelegationId, input.maxParallel, input.now);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/iu.test(error.message)) {
        throw new CouncilConflictError("这条任务已有进行中的 Worker 团队。");
      }
      throw error;
    }
    return this.getTeam(input.id)!;
  }

  getTeam(id: string): TaskTeamRecord | undefined {
    const row = this.#database.prepare(`SELECT * FROM task_teams WHERE id = ?`).get(id) as unknown as TeamRow | undefined;
    return row ? team(row) : undefined;
  }

  /** 最近一个团队（含已结束）；GET /team 用。 */
  latestForWorkItem(workItemId: string): TaskTeamRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM task_teams WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(workItemId) as unknown as TeamRow | undefined;
    return row ? team(row) : undefined;
  }

  activeForWorkItem(workItemId: string): TaskTeamRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM task_teams WHERE work_item_id = ? AND status = 'active'
    `).get(workItemId) as unknown as TeamRow | undefined;
    return row ? team(row) : undefined;
  }

  activeForLead(leadDelegationId: string): TaskTeamRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM task_teams WHERE lead_delegation_id = ? AND status = 'active'
    `).get(leadDelegationId) as unknown as TeamRow | undefined;
    return row ? team(row) : undefined;
  }

  listActiveTeams(): TaskTeamRecord[] {
    return (this.#database.prepare(`SELECT * FROM task_teams WHERE status = 'active' ORDER BY created_at`)
      .all() as unknown as TeamRow[]).map(team);
  }

  endTeam(id: string, now: string): TaskTeamRecord | undefined {
    this.#database.prepare(`UPDATE task_teams SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'`)
      .run(now, id);
    return this.getTeam(id);
  }

  createWorker(input: {
    id: string; teamId: string; delegationId: string; label: string; role?: string;
    scopePaths: readonly string[]; now: string;
  }): TaskWorkerRecord {
    this.#database.prepare(`
      INSERT INTO task_workers (id, team_id, delegation_id, label, role, status, focused, scope_paths_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?, ?)
    `).run(input.id, input.teamId, input.delegationId, input.label, input.role ?? null,
      JSON.stringify(input.scopePaths), input.now, input.now);
    return this.getWorker(input.id)!;
  }

  getWorker(id: string): TaskWorkerRecord | undefined {
    const row = this.#database.prepare(`SELECT * FROM task_workers WHERE id = ?`).get(id) as unknown as WorkerRow | undefined;
    return row ? worker(row) : undefined;
  }

  workerByDelegation(delegationId: string): TaskWorkerRecord | undefined {
    const row = this.#database.prepare(`SELECT * FROM task_workers WHERE delegation_id = ?`)
      .get(delegationId) as unknown as WorkerRow | undefined;
    return row ? worker(row) : undefined;
  }

  listWorkers(teamId: string): TaskWorkerRecord[] {
    return (this.#database.prepare(`SELECT * FROM task_workers WHERE team_id = ? ORDER BY created_at, rowid`)
      .all(teamId) as unknown as WorkerRow[]).map(worker);
  }

  /** 只在值真正变化时写入，避免无谓推进 revision（每次写都会触发 council.changed 推送）。 */
  updateWorker(id: string, patch: { status?: TaskWorkerStatus; mergedCommit?: string; now: string }): TaskWorkerRecord {
    const current = this.getWorker(id);
    if (!current) throw new Error("Worker 记录不存在。");
    const status = patch.status ?? current.status;
    const mergedCommit = patch.mergedCommit ?? current.mergedCommit;
    if (status !== current.status || mergedCommit !== current.mergedCommit) {
      this.#database.prepare(`UPDATE task_workers SET status = ?, merged_commit = ?, updated_at = ? WHERE id = ?`)
        .run(status, mergedCommit ?? null, patch.now, id);
    }
    return this.getWorker(id)!;
  }

  /** 每个团队最多一个聚焦 Worker；focused=false 只取消该 Worker 的聚焦。 */
  setFocus(teamId: string, workerId: string, focused: boolean, now: string): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (focused) {
        this.#database.prepare(`UPDATE task_workers SET focused = 0, updated_at = ? WHERE team_id = ? AND focused = 1 AND id <> ?`)
          .run(now, teamId, workerId);
      }
      this.#database.prepare(`UPDATE task_workers SET focused = ?, updated_at = ? WHERE id = ? AND focused <> ?`)
        .run(focused ? 1 : 0, now, workerId, focused ? 1 : 0);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Lead 执行者对应 Actor 的 @别名；团队 MCP 以它作为调用者身份，没有别名就不能组队。 */
  aliasOfActor(actorId: string): string | undefined {
    const row = this.#database.prepare(`
      SELECT alias FROM actor_aliases WHERE actor_id = ? ORDER BY alias LIMIT 1
    `).get(actorId) as unknown as { alias: string } | undefined;
    return row?.alias;
  }

  close(): void {
    this.#database.close();
  }
}
