/**
 * @input  依赖：canonical v4 Actor/alias、Provider/Agent 与冻结内容快照
 * @output 导出：migrateVersionFive 与 v4 迁移源验证
 * @pos    将 Kimi/DeepSeek 固定 seed 解绑为动态 Actor 的 v4→v5 原子迁移
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LEGACY_DYNAMIC_ACTOR_IDS } from "./legacy-dynamic-actors.js";

interface LegacyActorRow {
  id: string;
  display_name: string;
  short_name: string;
  role: string;
}

interface CurrentAgentRow {
  id: string;
  slug: string;
  display_name: string;
  mention_alias: string;
}

const LOCKED_SYSTEM_AGENTS = [
  {
    actorId: "claude",
    displayName: "Claude",
    shortName: "CL",
    mentionAlias: "claude",
    allowedAliases: [
      { alias: "claude", kind: "canonical" },
      { alias: "claude-code", kind: "adapter" },
    ],
  },
  {
    actorId: "codex",
    displayName: "Codex",
    shortName: "CX",
    mentionAlias: "codex",
    allowedAliases: [
      { alias: "codex", kind: "canonical" },
      { alias: "codex-cli", kind: "adapter" },
    ],
  },
] as const;

export function assertVersionFourMigrationSource(database: DatabaseSync): void {
  const providerColumns = database.prepare("PRAGMA table_info(provider_profiles)")
    .all() as unknown as Array<{ name?: unknown }>;
  const agentColumns = database.prepare("PRAGMA table_info(agent_definitions)")
    .all() as unknown as Array<{ name?: unknown }>;
  if (
    !providerColumns.some((column) => column.name === "config_revision") ||
    !agentColumns.some((column) => column.name === "config_revision")
  ) {
    throw new Error("Council v4 模型路由表缺少配置版本字段。");
  }
}

function migrateLegacyActor(
  database: DatabaseSync,
  legacyActorId: string,
  now: string,
): void {
  const legacyActor = database.prepare(`
    SELECT id, display_name, short_name, role
    FROM actor_identities
    WHERE id = ?
  `).get(legacyActorId) as unknown as LegacyActorRow | undefined;
  if (!legacyActor) return;

  const currentAgent = database.prepare(`
    SELECT id, slug, display_name, mention_alias
    FROM agent_definitions
    WHERE actor_id = ? AND deleted_at IS NULL
  `).get(legacyActorId) as unknown as CurrentAgentRow | undefined;
  if (currentAgent) {
    const newActorId = `actor-${randomUUID()}`;
    database.prepare(`
      INSERT INTO actor_identities (
        id, slug, display_name, short_name, role,
        actor_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'agent', 'active', ?, ?)
    `).run(
      newActorId,
      newActorId,
      currentAgent.display_name || legacyActor.display_name,
      legacyActor.short_name,
      legacyActor.role,
      now,
      now,
    );
    const movedAlias = database.prepare(`
      UPDATE actor_aliases
      SET actor_id = ?, alias_kind = 'adapter'
      WHERE alias = ? COLLATE NOCASE AND actor_id = ?
    `).run(newActorId, currentAgent.mention_alias, legacyActorId);
    if (movedAlias.changes !== 1) {
      throw new Error(`Council v4 Agent ${currentAgent.id} 的活动 alias 不兼容。`);
    }
    const rebound = database.prepare(`
      UPDATE agent_definitions
      SET actor_id = ?, config_revision = config_revision + 1, updated_at = ?
      WHERE id = ? AND actor_id = ? AND deleted_at IS NULL
    `).run(newActorId, now, currentAgent.id, legacyActorId);
    if (rebound.changes !== 1) {
      throw new Error(`Council v4 Agent ${currentAgent.id} 的 Actor 重绑发生并发冲突。`);
    }
  }
  database.prepare(`
    DELETE FROM actor_aliases
    WHERE actor_id = ?
  `).run(legacyActorId);
  database.prepare(`
    UPDATE actor_identities
    SET status = 'inactive', updated_at = ?
    WHERE id = ? AND actor_type = 'agent'
  `).run(now, legacyActorId);
}

function normalizeLockedSystemAgents(database: DatabaseSync, now: string): void {
  for (const identity of LOCKED_SYSTEM_AGENTS) {
    const normalizedActor = database.prepare(`
      UPDATE actor_identities
      SET slug = ?, display_name = ?, short_name = ?, status = 'active', updated_at = ?
      WHERE id = ? AND actor_type = 'agent'
    `).run(
      identity.actorId,
      identity.displayName,
      identity.shortName,
      now,
      identity.actorId,
    );
    if (normalizedActor.changes !== 1) {
      throw new Error(`Council v4 系统 Actor ${identity.actorId} 不存在。`);
    }
    for (const expectedAlias of identity.allowedAliases) {
      const aliasOwner = database.prepare(`
        SELECT actor_id
        FROM actor_aliases
        WHERE alias = ? COLLATE NOCASE
      `).get(expectedAlias.alias) as unknown as { actor_id?: unknown } | undefined;
      if (aliasOwner && aliasOwner.actor_id !== identity.actorId) {
        throw new Error(`Council v4 系统 alias ${expectedAlias.alias} 已被其他 Actor 占用。`);
      }
      if (!aliasOwner) {
        database.prepare(`
          INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
          VALUES (?, ?, ?, ?)
        `).run(expectedAlias.alias, identity.actorId, expectedAlias.kind, now);
      } else {
        database.prepare(`
          UPDATE actor_aliases
          SET alias_kind = ?
          WHERE alias = ? COLLATE NOCASE AND actor_id = ?
        `).run(expectedAlias.kind, expectedAlias.alias, identity.actorId);
      }
    }
    const allowedAliases = identity.allowedAliases.map((entry) => entry.alias);
    const placeholders = allowedAliases.map(() => "?").join(", ");
    database.prepare(`
      DELETE FROM actor_aliases
      WHERE actor_id = ?
        AND alias NOT IN (${placeholders})
    `).run(identity.actorId, ...allowedAliases);
    const current = database.prepare(`
      SELECT id, display_name, mention_alias
      FROM agent_definitions
      WHERE actor_id = ? AND deleted_at IS NULL
    `).get(identity.actorId) as unknown as Pick<
      CurrentAgentRow,
      "id" | "display_name" | "mention_alias"
    > | undefined;
    if (
      current &&
      (
        current.display_name !== identity.displayName ||
        current.mention_alias !== identity.mentionAlias
      )
    ) {
      const normalized = database.prepare(`
        UPDATE agent_definitions
        SET display_name = ?, mention_alias = ?,
            config_revision = config_revision + 1, updated_at = ?
        WHERE id = ? AND actor_id = ? AND deleted_at IS NULL
      `).run(
        identity.displayName,
        identity.mentionAlias,
        now,
        current.id,
        identity.actorId,
      );
      if (normalized.changes !== 1) {
        throw new Error(`Council v4 系统 Agent ${identity.actorId} 规范化发生并发冲突。`);
      }
    }
  }
}

export function migrateVersionFive(
  database: DatabaseSync,
  recordVersion = true,
): void {
  assertVersionFourMigrationSource(database);
  const now = new Date().toISOString();
  normalizeLockedSystemAgents(database, now);
  for (const actorId of LEGACY_DYNAMIC_ACTOR_IDS) {
    migrateLegacyActor(database, actorId, now);
  }
  if (recordVersion) {
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(5, "dynamic-provider-actors", now);
    database.exec("PRAGMA user_version = 5;");
  }
}
