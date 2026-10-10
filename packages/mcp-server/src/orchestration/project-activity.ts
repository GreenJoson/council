/**
 * @input  依赖：node:sqlite 连接；topics / work_items / orchestration_runs / work_item_delegations 的真实落库状态
 * @output 导出：ProjectActivity 与 computeProjectActivity —— 同项目「正在占用 Agent」的计数：
 *         running/waiting_agent 的 Run + executing/reviewing 的委派
 * @pos    图标栏「会话」徽标与状态条「N 个 Agent 运行中」的唯一口径；只数真的在跑的，
 *         queued / waiting_user / changes_requested 都在等别人，不算活动
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";

export interface ProjectActivity {
  activeAgents: number;
}

interface ActivityRow {
  activeAgents: number;
}

export function computeProjectActivity(
  database: DatabaseSync,
  projectPath: string | undefined,
): ProjectActivity {
  // 议题实施项的 project_path 可能为空（取自议题），直接任务则只有自己的 project_path，两边 COALESCE 成一个口径。
  const row = database
    .prepare(`
      SELECT
        (SELECT count(*) FROM orchestration_runs r JOIN topics t ON t.id = r.topic_id
          WHERE t.project_path IS ? AND r.status IN ('running', 'waiting_agent'))
        + (SELECT count(*) FROM work_item_delegations d
            JOIN work_items w ON w.id = d.work_item_id
            LEFT JOIN topics wt ON wt.id = w.topic_id
          WHERE COALESCE(w.project_path, wt.project_path) IS ?
            AND d.status IN ('executing', 'reviewing')) AS activeAgents
    `)
    .get(projectPath ?? null, projectPath ?? null) as unknown as ActivityRow;
  return { activeAgents: row.activeAgents };
}
