#!/usr/bin/env node
/**
 * @input  依赖：Keychain 兼容命令参数、隔离文件与显式故障注入开关
 * @output 导出：E2E 专用 add/find/delete-generic-password 及查询故障最小协议
 * @pos    跨进程远程 Provider E2E 的临时 SecretStore 命令替身
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { readFileSync, writeFileSync } from "node:fs";

const storagePath = process.env.COUNCIL_FAKE_KEYCHAIN_FILE?.trim();
if (!storagePath) {
  process.stderr.write("缺少隔离 Keychain 文件路径\n");
  process.exit(2);
}

const args = process.argv.slice(2);
const operation = args[0];

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readEntries() {
  try {
    return JSON.parse(readFileSync(storagePath, "utf8"));
  } catch {
    return {};
  }
}

function writeEntries(entries) {
  writeFileSync(storagePath, JSON.stringify(entries), { mode: 0o600 });
}

const account = option("-a");
if (!account) {
  process.stderr.write("缺少 account\n");
  process.exit(2);
}

const entries = readEntries();
if (operation === "find-generic-password") {
  if (process.env.COUNCIL_FAKE_KEYCHAIN_FAIL_FIND === "1") {
    process.exit(70);
  }
  const secret = entries[account];
  if (typeof secret !== "string") {
    process.exit(44);
  }
  process.stdout.write(secret, () => process.exit(0));
} else if (operation === "add-generic-password") {
  const secret = option("-w");
  if (typeof secret !== "string" || !secret) {
    process.exit(2);
  }
  entries[account] = secret;
  writeEntries(entries);
  process.exit(0);
} else if (operation === "delete-generic-password") {
  if (typeof entries[account] !== "string") {
    process.exit(44);
  }
  delete entries[account];
  writeEntries(entries);
  process.exit(0);
} else {
  process.stderr.write("不支持的 Keychain 操作\n");
  process.exit(2);
}
