/**
 * @input  依赖：canonical v2 agent_settings、Actor schema、Provider catalog 与 Model Router DDL
 * @output 导出：migrateVersionThree 原子迁移步骤
 * @pos    schema-migrator 调用的 v2→v3 专用模块，隔离供应商/Agent 迁移规则
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import { MODEL_ROUTER_SCHEMA_SQL } from "./schema-definitions.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";

interface LegacyAgentSettingRow extends Record<string, unknown> {
  id: unknown;
  label: unknown;
  kind: unknown;
  model: unknown;
  base_url: unknown;
  enabled: unknown;
  requires_api_key: unknown;
  updated_at: unknown;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`agent_settings.${key} 不是字符串。`);
  }
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`agent_settings.${key} 不是可空字符串。`);
  }
  return value;
}

function requiredInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`agent_settings.${key} 不是安全整数。`);
  }
  return value;
}

function normalizedSlug(value: string, label: string): string {
  const slug = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(slug)) {
    throw new Error(`${label} 不是可迁移的 slug。`);
  }
  return slug;
}

function shortName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").slice(0, 3).toLocaleUpperCase("en-US") || "AI";
}

function ensureAgentActor(
  database: DatabaseSync,
  input: {
    actorId: string;
    slug: string;
    displayName: string;
    mentionAlias: string;
    now: string;
  },
): void {
  const existing = database.prepare(`
    SELECT id, slug, actor_type FROM actor_identities WHERE id = ?
  `).get(input.actorId) as unknown as {
    id?: unknown;
    slug?: unknown;
    actor_type?: unknown;
  } | undefined;
  if (existing) {
    if (
      existing.id !== input.actorId
      || existing.slug !== input.slug
      || existing.actor_type !== "agent"
    ) {
      throw new Error(`Agent Actor ${input.actorId} 已被不兼容身份占用。`);
    }
  } else {
    database.prepare(`
      INSERT INTO actor_identities (
        id, slug, display_name, short_name, role,
        actor_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '模型顾问', 'agent', 'active', ?, ?)
    `).run(
      input.actorId,
      input.slug,
      input.displayName,
      shortName(input.displayName),
      input.now,
      input.now,
    );
  }
  const existingAlias = database.prepare(`
    SELECT actor_id FROM actor_aliases WHERE alias = ? COLLATE NOCASE
  `).get(input.mentionAlias) as unknown as { actor_id?: unknown } | undefined;
  if (existingAlias && existingAlias.actor_id !== input.actorId) {
    throw new Error(`Agent mention alias ${input.mentionAlias} 已被其他 Actor 占用。`);
  }
  if (!existingAlias) {
    database.prepare(`
      INSERT INTO actor_aliases (alias, actor_id, alias_kind, created_at)
      VALUES (?, ?, 'adapter', ?)
    `).run(input.mentionAlias, input.actorId, input.now);
  }
}

function seedBrandAssets(database: DatabaseSync, now: string): void {
  const insert = database.prepare(`
    INSERT INTO brand_assets (
      id, slug, display_name, glyph_id, color_token,
      source_kind, source_label, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  for (const brand of PROVIDER_CATALOG.brands) {
    insert.run(
      brand.id,
      brand.slug,
      brand.displayName,
      brand.glyphId,
      brand.colorToken,
      brand.sourceKind,
      brand.sourceLabel,
      now,
      now,
    );
  }
}

export function migrateVersionThree(database: DatabaseSync, recordVersion = true): void {
  const now = new Date().toISOString();
  const legacyRows = database.prepare(`
    SELECT id, label, kind, model, base_url, enabled, requires_api_key, updated_at
    FROM agent_settings
    ORDER BY rowid
  `).all() as unknown as LegacyAgentSettingRow[];

  database.exec(MODEL_ROUTER_SCHEMA_SQL);
  seedBrandAssets(database, now);
  const catalogByTemplate = new Map(
    PROVIDER_CATALOG.providers.map((entry) => [entry.templateId, entry]),
  );
  const insertProvider = database.prepare(`
    INSERT INTO provider_profiles (
      id, slug, display_name, protocol, base_url, requires_api_key,
      credential_ref, brand_asset_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  const insertAgent = database.prepare(`
    INSERT INTO agent_definitions (
      id, actor_id, provider_id, slug, display_name, model,
      mention_alias, enabled, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const migrateSetting = (row: LegacyAgentSettingRow, required: boolean): void => {
    const id = normalizedSlug(requiredString(row, "id"), "Agent ID");
    const label = requiredString(row, "label").trim();
    const kind = requiredString(row, "kind");
    const model = requiredString(row, "model").trim();
    const baseUrl = nullableString(row, "base_url")?.trim() || null;
    const enabled = requiredInteger(row, "enabled");
    const requiresApiKey = requiredInteger(row, "requires_api_key");
    if (!required && enabled !== 1 && !model && !baseUrl) return;
    const templateKey = id === "claude"
      ? "claude-cli"
      : id === "codex"
        ? "codex-cli"
        : id;
    const template = catalogByTemplate.get(templateKey);
    const protocol = kind === "claude-cli" || kind === "codex-cli"
      ? kind
      : "openai-compatible";
    const providerId = `provider-${id}`;
    const actorId = ["claude", "codex", "deepseek", "kimi"].includes(id)
      ? id
      : `agent-${id}`;
    const displayName = label || template?.displayName || id;
    ensureAgentActor(database, {
      actorId,
      slug: actorId,
      displayName,
      mentionAlias: id,
      now,
    });
    const updatedAt = requiredString(row, "updated_at") || now;
    insertProvider.run(
      providerId,
      template?.slug ?? id,
      template?.displayName ?? displayName,
      protocol,
      baseUrl ?? template?.baseUrl ?? null,
      requiresApiKey,
      protocol === "openai-compatible" ? id : null,
      template?.brandAssetId ?? "brand-custom",
      now,
      updatedAt,
    );
    insertAgent.run(
      id,
      actorId,
      providerId,
      id,
      displayName,
      model,
      id,
      enabled,
      now,
      updatedAt,
    );
  };

  const rowsById = new Map<string, LegacyAgentSettingRow>();
  for (const row of legacyRows) {
    rowsById.set(requiredString(row, "id").toLocaleLowerCase("en-US"), row);
  }
  for (const localId of ["claude", "codex"] as const) {
    const existing = rowsById.get(localId);
    if (existing) {
      migrateSetting(existing, true);
      continue;
    }
    const template = catalogByTemplate.get(localId === "claude" ? "claude-cli" : "codex-cli");
    if (!template) throw new Error(`缺少内置 ${localId} Provider 模板。`);
    migrateSetting({
      id: localId,
      label: localId === "claude" ? "Claude Code" : "Codex CLI",
      kind: template.protocol,
      model: "",
      base_url: null,
      enabled: 1,
      requires_api_key: 0,
      updated_at: now,
    }, true);
  }
  for (const row of legacyRows) {
    const id = requiredString(row, "id").toLocaleLowerCase("en-US");
    if (id !== "claude" && id !== "codex") migrateSetting(row, false);
  }

  database.exec("DROP TABLE agent_settings;");
  if (recordVersion) {
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(3, "provider-agent-model-router", now);
    database.exec("PRAGMA user_version = 3;");
  }
}
