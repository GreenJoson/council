/**
 * @input  依赖：临时 v5 SQLite、ModelRouterService/Store 与内存 SecretStore
 * @output 验证：Provider/Agent 分层、权限/职责、五类 ACP 模板、多 Agent、品牌、Keychain 强补偿、
 *               Provider 复活、alias/重启生命周期、系统身份保护与活动 Run fail-closed
 * @pos    动态模型路由控制面的核心安全回归测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SecretStore } from "../src/keychain-secret-store.js";
import { ModelRouterService } from "../src/model-router-service.js";
import { ModelRouterStore } from "../src/model-router-store.js";
import {
  COUNCIL_SCHEMA_VERSION,
  migrateCouncilSchema,
} from "../src/schema-migrator.js";

async function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "council-model-router-"));
  const databasePath = path.join(directory, "council.sqlite3");
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const secrets = new MemorySecretStore();
  const store = new ModelRouterStore(databasePath, 5_000);
  const service = new ModelRouterService(
    store,
    secrets,
  );
  return {
    databasePath,
    secrets,
    service,
    store,
    cleanup: () => {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
  }

  async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

class RejectingSecretStore extends MemorySecretStore {
  override async set(): Promise<void> {
    throw new Error("simulated keychain failure");
  }
}

class DeleteFalseSecretStore extends MemorySecretStore {
  override async delete(): Promise<boolean> {
    return false;
  }
}

test("Agent 写入权限必须绑定执行职责且只开放给 Claude/Codex CLI", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = await fixture.service.snapshot();
    const claude = snapshot.agents.find((agent) => agent.actorId === "claude");
    assert(claude);
    assert.equal(claude.permissionProfile, "read_only");
    assert.equal(claude.executionRole, "hybrid");
    const model = claude.model || "test-model";
    const writable = fixture.service.updateAgent(claude.id, {
      displayName: claude.displayName,
      model,
      mentionAlias: claude.mentionAlias,
      enabled: claude.enabled,
      permissionProfile: "workspace_write",
      executionRole: "hybrid",
    });
    assert.equal(writable.permissionProfile, "workspace_write");
    assert.equal(writable.executionRole, "hybrid");

    assert.throws(
      () => fixture.service.updateAgent(claude.id, {
        displayName: claude.displayName,
        model,
        mentionAlias: claude.mentionAlias,
        enabled: claude.enabled,
        permissionProfile: "danger_full_access",
        executionRole: "reviewer",
      }),
      /只有执行者或复合职责/u,
    );

    const provider = await fixture.service.createProvider({
      templateId: "kimi-code",
      slug: "kimi-code",
      displayName: "Kimi Code",
      active: true,
    });
    assert.throws(
      () => fixture.service.createAgent({
        providerId: provider.id,
        slug: "kimi-executor",
        displayName: "Kimi Executor",
        model: "kimi-code/k3",
        mentionAlias: "kimi-executor",
        enabled: true,
        permissionProfile: "workspace_write",
        executionRole: "executor",
      }),
      /只有 Claude CLI 与 Codex CLI/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("Provider 与 Agent 分层：同一 Kimi 连接可创建多个独立 Agent", async () => {
  const fixture = await createFixture();
  try {
    const provider = await fixture.service.createProvider({
      templateId: "kimi",
      slug: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key-not-for-production",
      active: true,
    });
    const primary = fixture.service.createAgent({
      providerId: provider.id,
      slug: "kimi-primary",
      displayName: "Kimi 主审",
      model: "kimi-primary-model",
      mentionAlias: "kimi",
      enabled: true,
    });
    const fast = fixture.service.createAgent({
      providerId: provider.id,
      slug: "kimi-fast",
      displayName: "Kimi 快审",
      model: "kimi-fast-model",
      mentionAlias: "kimi-fast",
      enabled: true,
    });
    assert.equal(primary.providerId, fast.providerId);
    assert.notEqual(primary.actorId, fast.actorId);
    assert.equal(primary.mentionAlias, "kimi");
    assert.equal(fast.mentionAlias, "kimi-fast");

    const snapshot = await fixture.service.snapshot();
    assert.equal(snapshot.providers.find((item) => item.id === provider.id)?.displayName, "Kimi");
    assert.equal(
      snapshot.brands.find((item) => item.id === provider.brandAssetId)?.glyphId,
      "simple-icons-kimi",
    );
    assert.equal(snapshot.agents.filter((item) => item.providerId === provider.id).length, 2);
    assert.equal(readFileSync(fixture.databasePath).includes("test-key-not-for-production"), false);
    assert.equal([...fixture.secrets.values.values()][0], "test-key-not-for-production");
  } finally {
    fixture.cleanup();
  }
});

test("Kimi Code ACP 作为独立 Provider 按需添加且不需要 API Key", async () => {
  const fixture = await createFixture();
  try {
    const before = await fixture.service.snapshot();
    const template = before.catalog.providers.find(
      (candidate) => candidate.templateId === "kimi-code",
    );
    assert.equal(template?.protocol, "acp");
    assert.equal(template?.runtimeDefinitionId, "kimi-code");
    /*
     * 候选取 ACP 的 modelId，不取 name。CLI 两个字段都给：modelId 是
     * `kimi-code/k3` 这样的协议标识，name 是 `k3 (thinking)` 这样的显示名。
     * 显示名会随 CLI 版本改写，思考档的 name 还带空格和括号——拿它当配置值
     * 存进数据库，等于把界面文案当成了稳定标识。
     */
    assert.deepEqual(template?.modelCandidates, [
      "kimi-code/k3",
      "kimi-code/k3,thinking",
      "kimi-code/k3-256k",
      "kimi-code/k3-256k,thinking",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding,thinking",
      "kimi-code/kimi-for-coding-highspeed",
      "kimi-code/kimi-for-coding-highspeed,thinking",
    ]);

    const provider = await fixture.service.createProvider({
      templateId: "kimi-code",
      slug: "kimi-code",
      displayName: "Kimi Code",
      active: true,
    });
    assert.equal(provider.protocol, "acp");
    assert.equal(provider.runtimeDefinitionId, "kimi-code");
    assert.equal(provider.requiresApiKey, false);
    assert.equal(provider.hasApiKey, false);
    assert.equal(provider.baseUrl, undefined);

    const agent = fixture.service.createAgent({
      providerId: provider.id,
      slug: "kimi-k3-reviewer",
      displayName: "Kimi K3 Reviewer",
      model: "kimi-code/k3",
      mentionAlias: "kimi-k3",
      enabled: true,
    });
    assert.equal(await fixture.service.isAgentReady(agent.id), true);
    assert.equal(fixture.secrets.values.size, 0);
  } finally {
    fixture.cleanup();
  }
});

test("ACP Provider 目录按 Agent 品牌声明通用 RuntimeDefinition", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = await fixture.service.snapshot();
    assert.equal(
      snapshot.brands.find((brand) => brand.id === "brand-gemini")?.glyphId,
      "simple-icons-googlegemini",
    );
    assert.deepEqual(
      snapshot.catalog.providers
        .filter((provider) => provider.protocol === "acp")
        .map((provider) => [
          provider.templateId,
          provider.runtimeDefinitionId,
          provider.brandAssetId,
        ]),
      [
        ["claude-agent-acp", "claude-agent", "brand-claude"],
        ["codex-acp", "codex-agent", "brand-openai"],
        ["gemini-cli-acp", "gemini-cli", "brand-gemini"],
        ["grok-build-acp", "grok-build", "brand-grok"],
        ["kimi-code", "kimi-code", "brand-kimi"],
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("Provider 校验 HTTPS；Keychain 写入失败时不创建半配置连接", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      fixture.service.createProvider({
        templateId: "deepseek",
        slug: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "http://provider.example/v1",
        apiKey: "test-key",
        active: true,
      }),
      /只允许 HTTPS/u,
    );
    assert.equal(
      (await fixture.service.snapshot()).providers.some((item) => item.slug === "deepseek"),
      false,
    );
  } finally {
    fixture.cleanup();
  }

  const directory = mkdtempSync(path.join(tmpdir(), "council-model-router-reject-"));
  const databasePath = path.join(directory, "council.sqlite3");
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const service = new ModelRouterService(
    new ModelRouterStore(databasePath, 5_000),
    new RejectingSecretStore(),
  );
  try {
    await assert.rejects(
      service.createProvider({
        templateId: "deepseek",
        slug: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        active: true,
      }),
      /simulated keychain failure/u,
    );
    assert.equal((await service.snapshot()).providers.some((item) => item.slug === "deepseek"), false);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Provider、API Key 与 Agent 每次变更都推进持久单调 configRevision", async () => {
  const fixture = await createFixture();
  try {
    const provider = await fixture.service.createProvider({
      templateId: "deepseek",
      slug: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key-v1",
      active: true,
    });
    assert.equal(provider.configRevision, 1);
    const providerUpdated = await fixture.service.updateProvider(provider.id, {
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      brandAssetId: provider.brandAssetId,
      apiKey: "test-key-v2",
      active: true,
    });
    assert.equal(providerUpdated.configRevision, 2);

    const agent = fixture.service.createAgent({
      providerId: provider.id,
      slug: "deepseek-revision",
      displayName: "DeepSeek Revision",
      model: "fixture-model",
      mentionAlias: "deepseek-revision",
      enabled: true,
    });
    assert.equal(agent.configRevision, 1);
    const agentUpdated = fixture.service.updateAgent(agent.id, {
      displayName: agent.displayName,
      model: "fixture-model-v2",
      mentionAlias: agent.mentionAlias,
      enabled: true,
    });
    assert.equal(agentUpdated.configRevision, 2);
    assert.equal(fixture.store.getProvider(provider.id)?.configRevision, 2);
    assert.equal(fixture.store.getAgent(agent.id)?.configRevision, 2);
  } finally {
    fixture.cleanup();
  }
});

test("@alias 冲突整笔回滚，不留下孤儿 Actor", async () => {
  const fixture = await createFixture();
  try {
    const provider = await fixture.service.createProvider({
      templateId: "custom",
      slug: "reviewer",
      displayName: "Reviewer",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      active: true,
    });
    fixture.service.createAgent({
      providerId: provider.id,
      slug: "reviewer-one",
      displayName: "Reviewer One",
      model: "model-one",
      mentionAlias: "reviewer",
      enabled: true,
    });
    const database = new DatabaseSync(fixture.databasePath);
    const before = (database.prepare("SELECT COUNT(*) AS value FROM actor_identities").get() as { value: number }).value;
    database.close();
    assert.throws(
      () => fixture.service.createAgent({
        providerId: provider.id,
        slug: "reviewer-two",
        displayName: "Reviewer Two",
        model: "model-two",
        mentionAlias: "reviewer",
        enabled: true,
      }),
      /slug 或 @alias 已被使用|已被其他 Actor/u,
    );
    const afterDatabase = new DatabaseSync(fixture.databasePath);
    try {
      const after = (afterDatabase.prepare("SELECT COUNT(*) AS value FROM actor_identities").get() as { value: number }).value;
      assert.equal(after, before);
    } finally {
      afterDatabase.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("活动 Run 使用 Agent 时，Agent 与 Provider 修改均 fail closed", async () => {
  const fixture = await createFixture();
  try {
    const provider = await fixture.service.createProvider({
      templateId: "deepseek",
      slug: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      active: true,
    });
    const agent = fixture.service.createAgent({
      providerId: provider.id,
      slug: "deepseek-reviewer",
      displayName: "DeepSeek Reviewer",
      model: "deepseek-model",
      mentionAlias: "deepseek",
      enabled: true,
    });
    const database = new DatabaseSync(fixture.databasePath);
    try {
      const now = "2026-01-01T00:00:00.000Z";
      database.prepare(`
        INSERT INTO topics (
          id, title, question, constraints_json, project_path, status,
          created_by_actor_id, created_by_snapshot_json, created_by_legacy,
          created_at, updated_at
        ) VALUES (
          'topic-active-router', 'active', 'active', '[]', NULL, 'open',
          'human', ?, NULL, ?, ?
        )
      `).run(JSON.stringify({
        schemaVersion: 1,
        actorId: "human",
        slug: "human",
        displayName: "User",
        shortName: "U",
        role: "决策者",
      }), now, now);
      database.prepare(`
        INSERT INTO orchestration_runs (
          id, topic_id, status, snapshot_schema_version, snapshot_json,
          version, created_at, updated_at
        ) VALUES ('run-active-router', 'topic-active-router', 'waiting_agent', 2, ?, 1, ?, ?)
      `).run(JSON.stringify({ plan: [{ adapterId: agent.id }] }), now, now);
    } finally {
      database.close();
    }

    assert.throws(
      () => fixture.service.updateAgent(agent.id, {
        displayName: agent.displayName,
        model: "changed-model",
        mentionAlias: agent.mentionAlias,
        enabled: true,
      }),
      /活动 Run/u,
    );
    await assert.rejects(
      fixture.service.updateProvider(provider.id, {
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        brandAssetId: provider.brandAssetId,
        active: false,
      }),
      /活动 Run/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("公开 Provider DTO 不暴露 credentialRef，内置供应商品牌身份不可伪装", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      fixture.service.createProvider({
        templateId: "kimi",
        slug: "pretend-kimi",
        displayName: "Other",
        brandAssetId: "brand-custom",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        active: true,
      }),
      /名称、slug 与品牌不能自定义/u,
    );
    const provider = await fixture.service.createProvider({
      templateId: "kimi",
      slug: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      active: true,
    });
    assert.equal(Object.hasOwn(provider, "credentialRef"), false);
    assert.equal(
      Object.hasOwn((await fixture.service.snapshot()).providers[0] ?? {}, "credentialRef"),
      false,
    );
    await assert.rejects(
      fixture.service.updateProvider(provider.id, {
        displayName: "Other",
        baseUrl: provider.baseUrl,
        brandAssetId: "brand-custom",
        active: true,
      }),
      /名称与品牌不能修改/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("删除 Agent 会释放可转移 alias，重建 Kimi 恢复自然 @kimi 且旧 Actor 保持冻结", async () => {
  const fixture = await createFixture();
  try {
    const provider = await fixture.service.createProvider({
      templateId: "kimi",
      slug: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      active: true,
    });
    const agent = fixture.service.createAgent({
      providerId: provider.id,
      slug: "kimi-reviewer",
      displayName: "Kimi Reviewer",
      model: "fixture-model",
      mentionAlias: "kimi-review",
      enabled: true,
    });
    const database = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(
        database.prepare("SELECT actor_id FROM actor_aliases WHERE alias = 'kimi-review'")
          .get()?.actor_id,
        agent.actorId,
      );
      assert.equal(
        database.prepare("SELECT actor_id FROM actor_aliases WHERE alias = 'kimi'").get(),
        undefined,
      );
    } finally {
      database.close();
    }

    fixture.service.updateAgent(agent.id, {
      displayName: agent.displayName,
      model: agent.model,
      mentionAlias: "kimi-final",
      enabled: true,
    });
    const renamedDatabase = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(
        renamedDatabase.prepare("SELECT actor_id FROM actor_aliases WHERE alias = 'kimi-review'")
          .get(),
        undefined,
      );
      assert.equal(
        renamedDatabase.prepare("SELECT actor_id FROM actor_aliases WHERE alias = 'kimi-final'")
          .get()?.actor_id,
        agent.actorId,
      );
    } finally {
      renamedDatabase.close();
    }

    const deleted = fixture.service.removeAgent(agent.id);
    assert(deleted.deletedAt);
    const deletedDatabase = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(
        deletedDatabase.prepare("SELECT status FROM actor_identities WHERE id = ?")
          .get(agent.actorId)?.status,
        "inactive",
      );
      assert.equal(
        deletedDatabase.prepare("SELECT actor_id FROM actor_aliases WHERE alias = 'kimi-final'")
          .get(),
        undefined,
      );
    } finally {
      deletedDatabase.close();
    }

    const replacement = fixture.service.createAgent({
      providerId: provider.id,
      slug: "kimi-replacement",
      displayName: "Kimi",
      model: "fixture-model",
      mentionAlias: "kimi",
      enabled: true,
    });
    assert.notEqual(replacement.actorId, agent.actorId);
    const beforeConflict = new DatabaseSync(fixture.databasePath);
    const actorCountBeforeConflict = beforeConflict.prepare(
      "SELECT COUNT(*) AS count FROM actor_identities",
    ).get()?.count;
    beforeConflict.close();
    assert.throws(
      () => fixture.service.createAgent({
        providerId: provider.id,
        slug: "kimi-conflict",
        displayName: "Kimi Conflict",
        model: "fixture-model",
        mentionAlias: "kimi",
        enabled: true,
      }),
      /已被其他 Actor 使用/u,
    );
    const rebuiltDatabase = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(
        rebuiltDatabase.prepare("SELECT actor_id FROM actor_aliases WHERE alias = 'kimi'")
          .get()?.actor_id,
        replacement.actorId,
      );
      assert.equal(
        rebuiltDatabase.prepare("SELECT actor_id FROM agent_definitions WHERE id = ?")
          .get(agent.id)?.actor_id,
        agent.actorId,
      );
      assert.equal(
        rebuiltDatabase.prepare("SELECT COUNT(*) AS count FROM actor_identities")
          .get()?.count,
        actorCountBeforeConflict,
      );
    } finally {
      rebuiltDatabase.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("Kimi/DeepSeek 自定义 alias、删除与自然 alias 重建经过迁移重开仍保持稳定", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-model-router-restart-"));
  const databasePath = path.join(directory, "council.sqlite3");
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const secrets = new MemorySecretStore();
  let service: ModelRouterService | undefined = new ModelRouterService(
    new ModelRouterStore(databasePath, 5_000),
    secrets,
  );
  try {
    const definitions = [
      { slug: "kimi", displayName: "Kimi" },
      { slug: "deepseek", displayName: "DeepSeek" },
    ] as const;
    const created: Array<{
      slug: string;
      displayName: string;
      providerId: string;
      agentId: string;
      actorId: string;
      customAlias: string;
    }> = [];
    for (const definition of definitions) {
      const provider = await service.createProvider({
        templateId: definition.slug,
        slug: definition.slug,
        displayName: definition.displayName,
        baseUrl: `https://${definition.slug}.example.com/v1`,
        apiKey: `${definition.slug}-restart-key`,
        active: true,
      });
      const customAlias = `${definition.slug}-architect`;
      const agent = service.createAgent({
        providerId: provider.id,
        slug: customAlias,
        displayName: `${definition.displayName} Architect`,
        model: "fixture-model",
        mentionAlias: customAlias,
        enabled: true,
      });
      assert.notEqual(agent.actorId, definition.slug);
      created.push({
        slug: definition.slug,
        displayName: definition.displayName,
        providerId: provider.id,
        agentId: agent.id,
        actorId: agent.actorId,
        customAlias,
      });
    }

    service.close();
    service = undefined;
    assert.deepEqual(
      await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 }),
      { migrated: false, version: COUNCIL_SCHEMA_VERSION },
    );

    service = new ModelRouterService(
      new ModelRouterStore(databasePath, 5_000),
      secrets,
    );
    const customSnapshot = await service.snapshot();
    const database = new DatabaseSync(databasePath);
    try {
      for (const item of created) {
        const reopened = customSnapshot.agents.find((agent) => agent.id === item.agentId);
        assert.equal(reopened?.actorId, item.actorId);
        assert.equal(reopened?.mentionAlias, item.customAlias);
        assert.equal(
          database.prepare(`
            SELECT actor_id
            FROM actor_aliases
            WHERE alias = ?
          `).get(item.customAlias)?.actor_id,
          item.actorId,
        );
        assert.equal(
          database.prepare(`
            SELECT actor_id
            FROM actor_aliases
            WHERE alias = ?
          `).get(item.slug),
          undefined,
        );
      }
    } finally {
      database.close();
    }

    for (const item of created) {
      service.removeAgent(item.agentId);
    }
    service.close();
    service = undefined;
    assert.deepEqual(
      await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 }),
      { migrated: false, version: COUNCIL_SCHEMA_VERSION },
    );

    service = new ModelRouterService(
      new ModelRouterStore(databasePath, 5_000),
      secrets,
    );
    const replacements = created.map((item) => {
      const replacement = service?.createAgent({
        providerId: item.providerId,
        slug: `${item.slug}-replacement`,
        displayName: item.displayName,
        model: "fixture-model-v2",
        mentionAlias: item.slug,
        enabled: true,
      });
      assert(replacement);
      assert.notEqual(replacement.actorId, item.actorId);
      return {
        ...item,
        replacementId: replacement.id,
        replacementActorId: replacement.actorId,
      };
    });
    service.close();
    service = undefined;
    assert.deepEqual(
      await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 }),
      { migrated: false, version: COUNCIL_SCHEMA_VERSION },
    );

    service = new ModelRouterService(
      new ModelRouterStore(databasePath, 5_000),
      secrets,
    );
    const naturalSnapshot = await service.snapshot();
    const rebuiltDatabase = new DatabaseSync(databasePath);
    try {
      for (const item of replacements) {
        const replacement = naturalSnapshot.agents.find(
          (agent) => agent.id === item.replacementId,
        );
        assert.equal(replacement?.actorId, item.replacementActorId);
        assert.equal(replacement?.mentionAlias, item.slug);
        assert.equal(
          rebuiltDatabase.prepare(`
            SELECT actor_id
            FROM actor_aliases
            WHERE alias = ?
          `).get(item.slug)?.actor_id,
          item.replacementActorId,
        );
        assert.equal(
          rebuiltDatabase.prepare(`
            SELECT actor_id
            FROM actor_aliases
            WHERE alias = ?
          `).get(item.customAlias),
          undefined,
        );
        assert.equal(
          rebuiltDatabase.prepare(`
            SELECT status
            FROM actor_identities
            WHERE id = ?
          `).get(item.actorId)?.status,
          "inactive",
        );
      }
    } finally {
      rebuiltDatabase.close();
    }
  } finally {
    service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("删除 Provider 后同模板重连复活原行，重启后新 Agent 使用新凭据", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-model-router-revive-"));
  const databasePath = path.join(directory, "council.sqlite3");
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const secrets = new MemorySecretStore();
  let service = new ModelRouterService(
    new ModelRouterStore(databasePath, 5_000),
    secrets,
  );
  try {
    const firstProvider = await service.createProvider({
      templateId: "kimi",
      slug: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.example.com/v1",
      apiKey: "first-revive-key",
      active: true,
    });
    const firstStoredProvider = new ModelRouterStore(databasePath, 5_000);
    const firstCredentialRef = firstStoredProvider.getProvider(firstProvider.id)?.credentialRef;
    firstStoredProvider.close();
    assert(firstCredentialRef);
    const firstAgent = service.createAgent({
      providerId: firstProvider.id,
      slug: "kimi-first",
      displayName: "Kimi First",
      model: "fixture-model",
      mentionAlias: "kimi",
      enabled: true,
    });
    service.removeAgent(firstAgent.id);
    const deleted = await service.removeProvider(firstProvider.id);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.configRevision, 2);
    assert.equal(await secrets.has(firstCredentialRef), false);

    const revived = await service.createProvider({
      templateId: "kimi",
      slug: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.example.com/v2",
      apiKey: "second-revive-key",
      active: true,
    });
    assert.equal(revived.id, firstProvider.id);
    assert.equal(revived.status, "active");
    assert.equal(revived.configRevision, 3);
    const revivedStore = new ModelRouterStore(databasePath, 5_000);
    const secondCredentialRef = revivedStore.getProvider(revived.id)?.credentialRef;
    revivedStore.close();
    assert(secondCredentialRef);
    assert.notEqual(secondCredentialRef, firstCredentialRef);
    assert.equal(await secrets.has(firstCredentialRef), false);
    assert.equal(await secrets.get(secondCredentialRef), "second-revive-key");

    const replacement = service.createAgent({
      providerId: revived.id,
      slug: "kimi-second",
      displayName: "Kimi",
      model: "fixture-model-v2",
      mentionAlias: "kimi",
      enabled: true,
    });
    assert.notEqual(replacement.actorId, "kimi");
    assert.notEqual(replacement.actorId, firstAgent.actorId);
    service.close();

    service = new ModelRouterService(
      new ModelRouterStore(databasePath, 5_000),
      secrets,
    );
    let tested: {
      actorId: string;
      providerId: string;
      apiKey: string | undefined;
    } | undefined;
    service.registerTester(async (agent, provider, apiKey) => {
      tested = {
        actorId: agent.actorId,
        providerId: provider.id,
        apiKey,
      };
    });
    await service.testAgent(replacement.id);
    assert.deepEqual(tested, {
      actorId: replacement.actorId,
      providerId: revived.id,
      apiKey: "second-revive-key",
    });
    const reopened = await service.snapshot();
    assert.equal(
      reopened.providers.filter((provider) => provider.slug === "kimi").length,
      1,
    );
    assert.equal(
      reopened.agents.find((agent) => agent.id === replacement.id)?.mentionAlias,
      "kimi",
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude/Codex 系统 Agent 只允许修改模型和启用状态", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = await fixture.service.snapshot();
    for (const expected of [
      { actorId: "claude", displayName: "Claude", mentionAlias: "claude" },
      { actorId: "codex", displayName: "Codex", mentionAlias: "codex" },
    ]) {
      const agent = snapshot.agents.find((item) => item.actorId === expected.actorId);
      assert(agent);
      assert.equal(agent.displayName, expected.displayName);
      assert.equal(agent.mentionAlias, expected.mentionAlias);
      assert.throws(
        () => fixture.service.updateAgent(agent.id, {
          displayName: `${expected.displayName} Custom`,
          model: agent.model,
          mentionAlias: expected.mentionAlias,
          enabled: agent.enabled,
        }),
        /名称与 @alias 不能修改/u,
      );
      assert.throws(
        () => fixture.service.updateAgent(agent.id, {
          displayName: expected.displayName,
          model: agent.model,
          mentionAlias: `${expected.mentionAlias}-custom`,
          enabled: agent.enabled,
        }),
        /名称与 @alias 不能修改/u,
      );
      assert.throws(
        () => fixture.service.removeAgent(agent.id),
        /系统 Agent 不能删除/u,
      );
      const updated = fixture.service.updateAgent(agent.id, {
        displayName: expected.displayName,
        model: `${agent.model || expected.actorId}-updated`,
        mentionAlias: expected.mentionAlias,
        enabled: agent.enabled,
      });
      assert.equal(updated.actorId, expected.actorId);
      assert.equal(updated.displayName, expected.displayName);
      assert.equal(updated.mentionAlias, expected.mentionAlias);
      assert.equal(updated.configRevision, agent.configRevision + 1);
    }
  } finally {
    fixture.cleanup();
  }
});

test("Provider 删除先清理 Keychain；数据库失败会恢复凭据，系统 Provider 永不删除", async () => {
  const fixture = await createFixture();
  try {
    const provider = await fixture.service.createProvider({
      templateId: "deepseek",
      slug: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      active: true,
    });
    fixture.service.createAgent({
      providerId: provider.id,
      slug: "deepseek-reviewer",
      displayName: "DeepSeek Reviewer",
      model: "fixture-model",
      mentionAlias: "deepseek",
      enabled: true,
    });
    await assert.rejects(fixture.service.removeProvider(provider.id), /仍有 Agent/u);
    assert.equal([...fixture.secrets.values.values()][0], "test-key");

    const systemProvider = (await fixture.service.snapshot()).providers.find(
      (item) => item.protocol === "claude-cli",
    );
    assert(systemProvider);
    await assert.rejects(
      fixture.service.removeProvider(systemProvider.id),
      /系统 Provider 不能删除/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("Provider 删除时 Keychain delete 返回 false 会阻止数据库软删除", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-model-router-delete-false-"));
  const databasePath = path.join(directory, "council.sqlite3");
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  const secrets = new DeleteFalseSecretStore();
  const service = new ModelRouterService(
    new ModelRouterStore(databasePath, 5_000),
    secrets,
  );
  try {
    const provider = await service.createProvider({
      templateId: "kimi",
      slug: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.example.com/v1",
      apiKey: "first-key",
      active: true,
    });
    await assert.rejects(
      service.removeProvider(provider.id),
      /Keychain 未能删除 API Key/u,
    );
    const unchanged = (await service.snapshot()).providers.find(
      (item) => item.id === provider.id,
    );
    assert.equal(unchanged?.status, "active");
    assert.equal(unchanged?.configRevision, 1);
    assert.equal([...secrets.values.values()][0], "first-key");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
