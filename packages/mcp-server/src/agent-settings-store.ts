/**
 * @input  依赖：SQLite 数据文件、内置 Agent 初始配置与用户设置更新
 * @output 导出：不含密钥的 AgentSetting 持久化仓储
 * @pos    模型、Provider 地址和启用状态的本地单一真源；API Key 不进入 SQLite
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { DatabaseSync } from "node:sqlite";

export type AgentProviderKind = "claude-cli" | "codex-cli" | "openai-compatible";

export interface AgentSettingSeed {
  id: string;
  label: string;
  kind: AgentProviderKind;
  model: string;
  baseUrl?: string;
  enabled: boolean;
  requiresApiKey: boolean;
}

export interface AgentSetting extends AgentSettingSeed {
  updatedAt: string;
}

interface AgentSettingRow {
  id: string;
  label: string;
  kind: AgentProviderKind;
  model: string;
  base_url: string | null;
  enabled: number;
  requires_api_key: number;
  updated_at: string;
}

function fromRow(row: AgentSettingRow): AgentSetting {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    model: row.model,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    enabled: row.enabled === 1,
    requiresApiKey: row.requires_api_key === 1,
    updatedAt: row.updated_at,
  };
}

export class AgentSettingsStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string, busyTimeoutMs: number, seeds: readonly AgentSettingSeed[]) {
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS agent_settings (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('claude-cli', 'codex-cli', 'openai-compatible')),
          model TEXT NOT NULL,
          base_url TEXT,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          requires_api_key INTEGER NOT NULL CHECK (requires_api_key IN (0, 1)),
          updated_at TEXT NOT NULL
        );
      `);
      const insert = this.#database.prepare(`
        INSERT OR IGNORE INTO agent_settings (
          id, label, kind, model, base_url, enabled, requires_api_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const seed of seeds) {
        insert.run(
          seed.id,
          seed.label,
          seed.kind,
          seed.model,
          seed.baseUrl ?? null,
          seed.enabled ? 1 : 0,
          seed.requiresApiKey ? 1 : 0,
          now,
        );
      }
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  list(): AgentSetting[] {
    const rows = this.#database
      .prepare("SELECT * FROM agent_settings ORDER BY rowid ASC")
      .all() as unknown as AgentSettingRow[];
    return rows.map(fromRow);
  }

  get(id: string): AgentSetting | undefined {
    const row = this.#database
      .prepare("SELECT * FROM agent_settings WHERE id = ?")
      .get(id) as unknown as AgentSettingRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  update(input: {
    id: string;
    model: string;
    baseUrl?: string;
    enabled: boolean;
  }): AgentSetting {
    const now = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE agent_settings
      SET model = ?, base_url = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.model,
      input.baseUrl ?? null,
      input.enabled ? 1 : 0,
      now,
      input.id,
    );
    if (result.changes !== 1) {
      throw new Error("Agent 设置不存在。");
    }
    return this.get(input.id) as AgentSetting;
  }

  close(): void {
    this.#database.close();
  }
}
