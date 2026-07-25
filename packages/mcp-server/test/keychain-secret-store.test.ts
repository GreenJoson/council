/**
 * @input  依赖：隔离 fake-keychain 命令、临时凭据文件与 MacOsKeychainSecretStore
 * @output 验证：Keychain 不存在返回空值，命令故障 fail closed
 * @pos    远程 Provider 凭据读取语义的安全回归测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MacOsKeychainSecretStore } from "../src/keychain-secret-store.js";

test("Keychain 不存在与命令故障使用不同语义", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-keychain-test-"));
  const storagePath = path.join(directory, "entries.json");
  writeFileSync(storagePath, "{}", { mode: 0o600 });
  const previousStorage = process.env.COUNCIL_FAKE_KEYCHAIN_FILE;
  const previousFailure = process.env.COUNCIL_FAKE_KEYCHAIN_FAIL_FIND;
  process.env.COUNCIL_FAKE_KEYCHAIN_FILE = storagePath;
  delete process.env.COUNCIL_FAKE_KEYCHAIN_FAIL_FIND;
  const store = new MacOsKeychainSecretStore(
    fileURLToPath(new URL("../../test/fake-keychain.mjs", import.meta.url)),
  );
  try {
    assert.equal(await store.get("missing-provider"), undefined);
    process.env.COUNCIL_FAKE_KEYCHAIN_FAIL_FIND = "1";
    await assert.rejects(
      store.get("missing-provider"),
      /无法确认 API Key 是否存在/u,
    );
    await assert.rejects(
      store.has("missing-provider"),
      /无法确认 API Key 是否存在/u,
    );
  } finally {
    if (previousStorage === undefined) {
      delete process.env.COUNCIL_FAKE_KEYCHAIN_FILE;
    } else {
      process.env.COUNCIL_FAKE_KEYCHAIN_FILE = previousStorage;
    }
    if (previousFailure === undefined) {
      delete process.env.COUNCIL_FAKE_KEYCHAIN_FAIL_FIND;
    } else {
      process.env.COUNCIL_FAKE_KEYCHAIN_FAIL_FIND = previousFailure;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
