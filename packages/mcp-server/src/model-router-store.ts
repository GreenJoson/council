/**
 * @input  依赖：已迁移 Council v14 SQLite、Provider/Agent/Brand 写入命令与 Agent 执行策略
 * @output 导出：ModelRouterStore、带权限/职责和单调 configRevision 的 Provider/Agent、BrandAsset 与原子 alias 生命周期
 * @pos    Provider 连接、Agent 身份、alias 激活/释放和受控品牌资产的唯一数据访问层；不拥有 DDL 或密钥
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { DatabaseSync } from "node:sqlite";
import type {
  BrandSourceKind,
  ProviderProtocol,
} from "./provider-catalog.js";
import type {
  AgentExecutionRole,
  AgentPermissionProfile,
} from "./agent-execution-policy.js";

const NON_TRANSFERABLE_CANONICAL_ACTOR_IDS = new Set([
  "human",
  "council",
  "claude",
  "codex",
  "legacy-unknown",
]);

const LOCKED_SYSTEM_AGENT_IDENTITIES = {
  claude: { displayName: "Claude", mentionAlias: "claude" },
  codex: { displayName: "Codex", mentionAlias: "codex" },
} as const;

export type ProviderStatus = "active" | "inactive" | "deleted";
export type BrandStatus = "active" | "inactive";

export interface BrandAsset {
  id: string;
  slug: string;
  displayName: string;
  glyphId: string;
  colorToken: string;
  sourceKind: BrandSourceKind;
  sourceLabel: string;
  status: BrandStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfile {
  id: string;
  slug: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  requiresApiKey: boolean;
  credentialRef?: string;
  brandAssetId: string;
  runtimeDefinitionId?: string;
  status: ProviderStatus;
  configRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinition {
  id: string;
  actorId: string;
  providerId: string;
  slug: string;
  displayName: string;
  model: string;
  mentionAlias: string;
  enabled: boolean;
  permissionProfile: AgentPermissionProfile;
  executionRole: AgentExecutionRole;
  configRevision: number;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface BrandRow {
  id: string;
  slug: string;
  display_name: string;
  glyph_id: string;
  color_token: string;
  source_kind: BrandSourceKind;
  source_label: string;
  status: BrandStatus;
  created_at: string;
  updated_at: string;
}

interface ProviderRow {
  id: string;
  slug: string;
  display_name: string;
  protocol: ProviderProtocol;
  base_url: string | null;
  requires_api_key: number;
  credential_ref: string | null;
  brand_asset_id: string;
  runtime_definition_id: string | null;
  status: ProviderStatus;
  config_revision: number;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  actor_id: string;
  provider_id: string;
  slug: string;
  display_name: string;
  model: string;
  mention_alias: string;
  enabled: number;
  permission_profile: AgentPermissionProfile;
  execution_role: AgentExecutionRole;
  config_revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

function brandFromRow(row: BrandRow): BrandAsset {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    glyphId: row.glyph_id,
    colorToken: row.color_token,
    sourceKind: row.source_kind,
    sourceLabel: row.source_label,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerFromRow(row: ProviderRow): ProviderProfile {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    protocol: row.protocol,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    requiresApiKey: row.requires_api_key === 1,
    ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}),
    brandAssetId: row.brand_asset_id,
    ...(row.runtime_definition_id
      ? { runtimeDefinitionId: row.runtime_definition_id }
      : {}),
    status: row.status,
    configRevision: row.config_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentFromRow(row: AgentRow): AgentDefinition {
  return {
    id: row.id,
    actorId: row.actor_id,
    providerId: row.provider_id,
    slug: row.slug,
    displayName: row.display_name,
    model: row.model,
    mentionAlias: row.mention_alias,
    enabled: row.enabled === 1,
    permissionProfile: row.permission_profile,
    executionRole: row.execution_role,
    configRevision: row.config_revision,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ModelRouterStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string, busyTimeoutMs: number) {
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
      const tables = this.#database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('brand_assets', 'provider_profiles', 'agent_definitions')
        ORDER BY name
      `).all() as unknown as Array<{ name?: unknown }>;
      if (tables.length !== 3) {
        throw new Error("Council SQLite 尚未由 Node 迁移器创建模型路由表。");
      }
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  listBrands(): BrandAsset[] {
    return (this.#database.prepare(`
      SELECT * FROM brand_assets
      WHERE status = 'active'
      ORDER BY rowid
    `).all() as unknown as BrandRow[]).map(brandFromRow);
  }

  getBrand(id: string): BrandAsset | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM brand_assets WHERE id = ?
    `).get(id) as unknown as BrandRow | undefined;
    return row ? brandFromRow(row) : undefined;
  }

  listProviders(includeDeleted = false): ProviderProfile[] {
    const rows = this.#database.prepare(`
      SELECT * FROM provider_profiles
      WHERE (? = 1 OR status != 'deleted')
      ORDER BY rowid
    `).all(includeDeleted ? 1 : 0) as unknown as ProviderRow[];
    return rows.map(providerFromRow);
  }

  getProvider(id: string): ProviderProfile | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM provider_profiles WHERE id = ?
    `).get(id) as unknown as ProviderRow | undefined;
    return row ? providerFromRow(row) : undefined;
  }

  getProviderBySlug(slug: string): ProviderProfile | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM provider_profiles
      WHERE slug = ? COLLATE NOCASE
    `).get(slug) as unknown as ProviderRow | undefined;
    return row ? providerFromRow(row) : undefined;
  }

  createProvider(input: {
    id: string;
    slug: string;
    displayName: string;
    protocol: ProviderProtocol;
    baseUrl?: string;
    requiresApiKey: boolean;
    credentialRef?: string;
    brandAssetId: string;
    runtimeDefinitionId?: string;
    status: Exclude<ProviderStatus, "deleted">;
    now: string;
  }): ProviderProfile {
    this.#database.prepare(`
      INSERT INTO provider_profiles (
        id, slug, display_name, protocol, base_url, requires_api_key,
        credential_ref, brand_asset_id, runtime_definition_id, status,
        config_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.id,
      input.slug,
      input.displayName,
      input.protocol,
      input.baseUrl ?? null,
      input.requiresApiKey ? 1 : 0,
      input.credentialRef ?? null,
      input.brandAssetId,
      input.runtimeDefinitionId ?? null,
      input.status,
      input.now,
      input.now,
    );
    return this.getProvider(input.id) as ProviderProfile;
  }

  reviveProvider(input: {
    id: string;
    slug: string;
    displayName: string;
    protocol: ProviderProtocol;
    baseUrl?: string;
    requiresApiKey: boolean;
    credentialRef?: string;
    brandAssetId: string;
    runtimeDefinitionId?: string;
    status: Exclude<ProviderStatus, "deleted">;
    now: string;
  }): ProviderProfile {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getProvider(input.id);
      if (
        !current ||
        current.status !== "deleted" ||
        current.slug.toLocaleLowerCase("en-US") !== input.slug.toLocaleLowerCase("en-US")
      ) {
        throw new Error("Provider 不存在、未删除或 slug 不匹配。");
      }
      const remaining = this.#database.prepare(`
        SELECT COUNT(*) AS value
        FROM agent_definitions
        WHERE provider_id = ? AND deleted_at IS NULL
      `).get(input.id) as unknown as { value: number };
      if (remaining.value !== 0) {
        throw new Error("已删除 Provider 仍有关联的当前 Agent。");
      }
      const result = this.#database.prepare(`
        UPDATE provider_profiles
        SET display_name = ?, protocol = ?, base_url = ?, requires_api_key = ?,
            credential_ref = ?, brand_asset_id = ?, runtime_definition_id = ?, status = ?,
            config_revision = config_revision + 1, updated_at = ?
        WHERE id = ? AND status = 'deleted'
      `).run(
        input.displayName,
        input.protocol,
        input.baseUrl ?? null,
        input.requiresApiKey ? 1 : 0,
        input.credentialRef ?? null,
        input.brandAssetId,
        input.runtimeDefinitionId ?? null,
        input.status,
        input.now,
        input.id,
      );
      if (result.changes !== 1) {
        throw new Error("Provider 恢复发生并发冲突。");
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.getProvider(input.id) as ProviderProfile;
  }

  updateProvider(input: {
    id: string;
    displayName: string;
    baseUrl?: string;
    brandAssetId: string;
    status: Exclude<ProviderStatus, "deleted">;
    now: string;
  }): ProviderProfile {
    const result = this.#database.prepare(`
      UPDATE provider_profiles
      SET display_name = ?, base_url = ?, brand_asset_id = ?, status = ?,
          config_revision = config_revision + 1, updated_at = ?
      WHERE id = ? AND status != 'deleted'
    `).run(
      input.displayName,
      input.baseUrl ?? null,
      input.brandAssetId,
      input.status,
      input.now,
      input.id,
    );
    if (result.changes !== 1) {
      throw new Error("Provider 不存在或已删除。");
    }
    return this.getProvider(input.id) as ProviderProfile;
  }

  softDeleteProvider(id: string, now: string): ProviderProfile {
    const remaining = this.#database.prepare(`
      SELECT COUNT(*) AS value
      FROM agent_definitions
      WHERE provider_id = ? AND deleted_at IS NULL
    `).get(id) as unknown as { value: number };
    if (remaining.value > 0) {
      throw new Error("Provider 仍有 Agent；请先移除这些 Agent。");
    }
    const result = this.#database.prepare(`
      UPDATE provider_profiles
      SET status = 'deleted', config_revision = config_revision + 1, updated_at = ?
      WHERE id = ? AND status != 'deleted'
    `).run(now, id);
    if (result.changes !== 1) {
      throw new Error("Provider 不存在或已删除。");
    }
    return this.getProvider(id) as ProviderProfile;
  }

  listAgents(includeDeleted = false): AgentDefinition[] {
    const rows = this.#database.prepare(`
      SELECT * FROM agent_definitions
      WHERE (? = 1 OR deleted_at IS NULL)
      ORDER BY rowid
    `).all(includeDeleted ? 1 : 0) as unknown as AgentRow[];
    return rows.map(agentFromRow);
  }

  getAgent(id: string): AgentDefinition | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_definitions WHERE id = ?
    `).get(id) as unknown as AgentRow | undefined;
    return row ? agentFromRow(row) : undefined;
  }

  createAgent(input: {
    id: string;
    actorId: string;
    actorSlug: string;
    providerId: string;
    slug: string;
    displayName: string;
    shortName: string;
    model: string;
    mentionAlias: string;
    enabled: boolean;
    permissionProfile: AgentPermissionProfile;
    executionRole: AgentExecutionRole;
    now: string;
  }): AgentDefinition {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare(`
        INSERT INTO actor_identities (
          id, slug, display_name, short_name, role,
          actor_type, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '模型顾问', 'agent', 'active', ?, ?)
      `).run(
        input.actorId,
        input.actorSlug,
        input.displayName,
        input.shortName,
        input.now,
        input.now,
      );
      const aliasOwner = this.#database.prepare(`
        SELECT actor_id FROM actor_aliases WHERE alias = ? COLLATE NOCASE
      `).get(input.mentionAlias) as unknown as { actor_id?: unknown } | undefined;
      if (aliasOwner && aliasOwner.actor_id !== input.actorId) {
        throw new Error("Agent @alias 已被其他 Actor 使用。");
      }
      if (!aliasOwner) {
        this.#database.prepare(`
          INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
          VALUES (?, ?, 'adapter', ?)
        `).run(input.mentionAlias, input.actorId, input.now);
      }
      this.#database.prepare(`
        INSERT INTO agent_definitions (
          id, actor_id, provider_id, slug, display_name, model,
          mention_alias, enabled, config_revision, deleted_at, created_at, updated_at,
          permission_profile, execution_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)
      `).run(
        input.id,
        input.actorId,
        input.providerId,
        input.slug,
        input.displayName,
        input.model,
        input.mentionAlias,
        input.enabled ? 1 : 0,
        input.now,
        input.now,
        input.permissionProfile,
        input.executionRole,
      );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.getAgent(input.id) as AgentDefinition;
  }

  updateAgent(input: {
    id: string;
    displayName: string;
    shortName: string;
    model: string;
    mentionAlias: string;
    enabled: boolean;
    permissionProfile: AgentPermissionProfile;
    executionRole: AgentExecutionRole;
    now: string;
  }): AgentDefinition {
    const current = this.getAgent(input.id);
    if (!current || current.deletedAt) {
      throw new Error("Agent 不存在或已删除。");
    }
    const lockedIdentity = LOCKED_SYSTEM_AGENT_IDENTITIES[
      current.actorId as keyof typeof LOCKED_SYSTEM_AGENT_IDENTITIES
    ];
    if (
      lockedIdentity &&
      (
        input.displayName !== lockedIdentity.displayName ||
        input.mentionAlias !== lockedIdentity.mentionAlias
      )
    ) {
      throw new Error("Claude/Codex 系统 Agent 的名称与 @alias 不能修改。");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (lockedIdentity) {
        this.#database.prepare(`
          UPDATE agent_definitions
          SET model = ?, enabled = ?, permission_profile = ?, execution_role = ?,
              config_revision = config_revision + 1, updated_at = ?
          WHERE id = ? AND actor_id = ? AND deleted_at IS NULL
        `).run(
          input.model,
          input.enabled ? 1 : 0,
          input.permissionProfile,
          input.executionRole,
          input.now,
          input.id,
          current.actorId,
        );
        this.#database.exec("COMMIT;");
        return this.getAgent(input.id) as AgentDefinition;
      }
      const aliasOwner = this.#database.prepare(`
        SELECT actor_id FROM actor_aliases WHERE alias = ? COLLATE NOCASE
      `).get(input.mentionAlias) as unknown as { actor_id?: unknown } | undefined;
      if (aliasOwner && aliasOwner.actor_id !== current.actorId) {
        throw new Error("Agent @alias 已被其他 Actor 使用。");
      }
      if (!aliasOwner) {
        this.#database.prepare(`
          INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
          VALUES (?, ?, 'adapter', ?)
        `).run(input.mentionAlias, current.actorId, input.now);
      } else {
        this.#database.prepare(`
          UPDATE actor_aliases SET alias_kind = 'adapter'
          WHERE alias = ? COLLATE NOCASE AND actor_id = ?
        `).run(input.mentionAlias, current.actorId);
      }
      this.#database.prepare(`
        DELETE FROM actor_aliases
        WHERE actor_id = ? AND alias != ? COLLATE NOCASE
      `).run(current.actorId, input.mentionAlias);
      this.#database.prepare(`
        UPDATE actor_identities
        SET display_name = ?, short_name = ?, updated_at = ?
        WHERE id = ? AND actor_type = 'agent' AND status = 'active'
      `).run(input.displayName, input.shortName, input.now, current.actorId);
      this.#database.prepare(`
        UPDATE agent_definitions
        SET display_name = ?, model = ?, mention_alias = ?, enabled = ?,
            permission_profile = ?, execution_role = ?,
            config_revision = config_revision + 1, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        input.displayName,
        input.model,
        input.mentionAlias,
        input.enabled ? 1 : 0,
        input.permissionProfile,
        input.executionRole,
        input.now,
        input.id,
      );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.getAgent(input.id) as AgentDefinition;
  }

  softDeleteAgent(id: string, now: string): AgentDefinition {
    const current = this.getAgent(id);
    if (!current || current.deletedAt) {
      throw new Error("Agent 不存在或已删除。");
    }
    if (current.actorId in LOCKED_SYSTEM_AGENT_IDENTITIES) {
      throw new Error("Claude/Codex 系统 Agent 不能删除。");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const tombstoneAlias = `deleted-${current.id}`;
      const result = this.#database.prepare(`
        UPDATE agent_definitions
        SET enabled = 0, mention_alias = ?, config_revision = config_revision + 1,
            deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(tombstoneAlias, now, now, id);
      if (result.changes !== 1) {
        throw new Error("Agent 不存在或已删除。");
      }
      if (!NON_TRANSFERABLE_CANONICAL_ACTOR_IDS.has(current.actorId)) {
        this.#database.prepare(`
          DELETE FROM actor_aliases
          WHERE actor_id = ? AND alias = ? COLLATE NOCASE
        `).run(current.actorId, current.mentionAlias);
      }
      const actor = this.#database.prepare(`
        UPDATE actor_identities
        SET status = 'inactive', updated_at = ?
        WHERE id = ? AND actor_type = 'agent' AND status = 'active'
      `).run(now, current.actorId);
      if (actor.changes !== 1) {
        throw new Error("Agent Actor 不存在或状态无效。");
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.getAgent(id) as AgentDefinition;
  }

  hasActiveRunForAgent(agentId: string): boolean {
    const delegation = this.#database.prepare(`
      SELECT id FROM work_item_delegations
      WHERE status IN ('queued', 'executing', 'reviewing', 'changes_requested')
        AND (supervisor_agent_id = ? OR executor_agent_id = ?)
      LIMIT 1
    `).get(agentId, agentId);
    if (delegation) return true;
    const row = this.#database.prepare(`
      SELECT runs.id
      FROM orchestration_runs AS runs,
           json_each(runs.snapshot_json, '$.plan') AS round
      WHERE runs.status IN ('idle', 'running', 'waiting_agent', 'waiting_user')
        AND json_extract(round.value, '$.adapterId') = ?
      LIMIT 1
    `).get(agentId);
    return row !== undefined;
  }

  hasActiveRunForProvider(providerId: string): boolean {
    return this.listAgents(true).some(
      (agent) => agent.providerId === providerId && this.hasActiveRunForAgent(agent.id),
    );
  }

  close(): void {
    this.#database.close();
  }
}
