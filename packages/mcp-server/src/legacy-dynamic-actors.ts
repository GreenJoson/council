/**
 * @input  依赖：v1/v2 的 agent_settings、agent_sessions、运行快照与 Actor 表
 * @output 导出：仅在旧配置、会话或冻结运行真实引用时补齐 Kimi/DeepSeek 历史 seed Actor
 * @pos    旧迁移兼容层；当前 Agent 创建不得复用这些固定身份
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";

export const LEGACY_DYNAMIC_ACTOR_IDS = ["deepseek", "kimi"] as const;

const LEGACY_DYNAMIC_ACTORS = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    shortName: "DS",
  },
  {
    id: "kimi",
    displayName: "Kimi",
    shortName: "KI",
  },
] as const;

export function seedReferencedLegacyDynamicActors(
  database: DatabaseSync,
  now: string,
): void {
  const referenced = new Set<string>();
  for (const row of database.prepare(`
    SELECT lower(id) AS id
    FROM agent_settings
    WHERE lower(id) IN ('deepseek', 'kimi')
  `).all() as unknown as Array<{ id: string }>) {
    referenced.add(row.id);
  }
  for (const row of database.prepare(`
    SELECT lower(agent) AS id
    FROM agent_sessions
    WHERE lower(agent) IN ('deepseek', 'kimi')
  `).all() as unknown as Array<{ id: string }>) {
    referenced.add(row.id);
  }
  for (const row of database.prepare(`
    SELECT DISTINCT lower(
      COALESCE(
        json_extract(round.value, '$.actorId'),
        json_extract(round.value, '$.adapterId')
      )
    ) AS id
    FROM orchestration_runs AS runs,
         json_each(runs.snapshot_json, '$.plan') AS round
    WHERE json_valid(runs.snapshot_json)
      AND lower(
        COALESCE(
          json_extract(round.value, '$.actorId'),
          json_extract(round.value, '$.adapterId')
        )
      ) IN ('deepseek', 'kimi')
  `).all() as unknown as Array<{ id: string }>) {
    referenced.add(row.id);
  }
  const insertActor = database.prepare(`
    INSERT INTO actor_identities (
      id, slug, display_name, short_name, role,
      actor_type, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '模型顾问', 'agent', 'active', ?, ?)
  `);
  const insertAlias = database.prepare(`
    INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
    VALUES (?, ?, 'canonical', ?)
  `);
  for (const actor of LEGACY_DYNAMIC_ACTORS) {
    if (!referenced.has(actor.id)) continue;
    const existing = database.prepare(`
      SELECT id
      FROM actor_identities
      WHERE id = ?
    `).get(actor.id);
    if (!existing) {
      insertActor.run(
        actor.id,
        actor.id,
        actor.displayName,
        actor.shortName,
        now,
        now,
      );
    }
    const alias = database.prepare(`
      SELECT actor_id
      FROM actor_aliases
      WHERE alias = ? COLLATE NOCASE
    `).get(actor.id) as unknown as { actor_id?: unknown } | undefined;
    if (alias && alias.actor_id !== actor.id) {
      throw new Error(`历史 Agent alias ${actor.id} 已被其他 Actor 占用。`);
    }
    if (!alias) {
      insertAlias.run(actor.id, actor.id, now);
    }
  }
}
