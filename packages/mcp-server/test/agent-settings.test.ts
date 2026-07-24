/**
 * @input  依赖：临时 SQLite、内存 SecretStore 与 Agent 设置服务
 * @output 验证：模型持久化、Key 零落盘、URL 校验和连接测试
 * @pos    模型设置控制面的核心安全回归测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSettingsService } from "../src/agent-settings-service.js";
import { AgentSettingsStore, type AgentSettingSeed } from "../src/agent-settings-store.js";
import type { SecretStore } from "../src/keychain-secret-store.js";
import { migrateCouncilSchema } from "../src/schema-migrator.js";

async function createTemporaryDatabasePath() {
  const directory = mkdtempSync(path.join(tmpdir(), "council-agent-settings-"));
  const databasePath = path.join(directory, "council.sqlite3");
  await migrateCouncilSchema(databasePath, 5_000, { maxAttempts: 3 });
  return {
    databasePath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
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

const SEEDS: AgentSettingSeed[] = [
  {
    id: "claude",
    label: "Claude Code",
    kind: "claude-cli",
    model: "opus-test",
    enabled: true,
    requiresApiKey: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    model: "",
    enabled: false,
    requiresApiKey: true,
  },
];

test("Agent 设置持久化模型但 API Key 只进入 SecretStore", async () => {
  const fixture = await createTemporaryDatabasePath();
  const secrets = new MemorySecretStore();
  const store = new AgentSettingsStore(fixture.databasePath, 5_000, SEEDS);
  const service = new AgentSettingsService(store, secrets);
  try {
    const saved = await service.update("deepseek", {
      model: "remote-model-test",
      baseUrl: "https://provider.example/v1",
      enabled: true,
      apiKey: "test-api-key-not-for-production",
    });
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.model, "remote-model-test");
    assert.equal(await service.isReady("deepseek"), true);
    assert.equal(secrets.values.get("deepseek"), "test-api-key-not-for-production");

    const bytes = readFileSync(fixture.databasePath).toString("utf8");
    assert.equal(bytes.includes("test-api-key-not-for-production"), false);

    const reopened = new AgentSettingsStore(fixture.databasePath, 5_000, SEEDS);
    assert.equal(reopened.get("deepseek")?.model, "remote-model-test");
    assert.equal(reopened.get("deepseek")?.baseUrl, "https://provider.example/v1");
    reopened.close();
  } finally {
    service.close();
    fixture.cleanup();
  }
});

test("Agent 设置拒绝非 HTTPS 远程地址并支持显式清除 Key", async () => {
  const fixture = await createTemporaryDatabasePath();
  const secrets = new MemorySecretStore();
  const service = new AgentSettingsService(
    new AgentSettingsStore(fixture.databasePath, 5_000, SEEDS),
    secrets,
  );
  try {
    await assert.rejects(
      service.update("deepseek", {
        model: "remote-model-test",
        baseUrl: "http://provider.example/v1",
        enabled: true,
      }),
      /只允许 HTTPS/,
    );
    await assert.rejects(
      service.update("deepseek", {
        model: "remote-model-test",
        baseUrl: "https://provider.example/v1",
        enabled: true,
      }),
      /必须保存 API Key/,
    );
    await service.update("deepseek", {
      model: "remote-model-test",
      baseUrl: "http://127.0.0.1:8080/v1",
      enabled: true,
      apiKey: "test-key",
    });
    const cleared = await service.update("deepseek", {
      model: "remote-model-test",
      baseUrl: "http://127.0.0.1:8080/v1",
      enabled: false,
      clearApiKey: true,
    });
    assert.equal(cleared.hasApiKey, false);
  } finally {
    service.close();
    fixture.cleanup();
  }
});

test("连接测试只调用注册测试器且返回耗时", async () => {
  const fixture = await createTemporaryDatabasePath();
  const service = new AgentSettingsService(
    new AgentSettingsStore(fixture.databasePath, 5_000, SEEDS),
    new MemorySecretStore(),
  );
  let calls = 0;
  service.registerTester("claude", async () => { calls += 1; });
  try {
    const result = await service.test("claude");
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.ok(result.latencyMs >= 0);
  } finally {
    service.close();
    fixture.cleanup();
  }
});

test("Keychain 写入失败时不提前持久化非敏感设置", async () => {
  const fixture = await createTemporaryDatabasePath();
  const store = new AgentSettingsStore(fixture.databasePath, 5_000, SEEDS);
  const service = new AgentSettingsService(store, new RejectingSecretStore());
  try {
    await assert.rejects(
      service.update("deepseek", {
        model: "remote-model-test",
        baseUrl: "https://provider.example/v1",
        enabled: true,
        apiKey: "test-key",
      }),
      /simulated keychain failure/,
    );
    assert.equal(store.get("deepseek")?.model, "");
    assert.equal(store.get("deepseek")?.enabled, false);
  } finally {
    service.close();
    fixture.cleanup();
  }
});
