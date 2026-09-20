/**
 * @input  依赖：临时项目/同级 Git 仓库、CouncilConfig 与 ReadOnlyToolHost
 * @output 验证：读文件、搜索、项目边界、凭据隔离与授权仓库的跨目录只读
 * @pos    Council-owned 本机只读沙箱的文件系统安全回归
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ReadOnlyToolHost,
  ReadOnlyToolHostError,
} from "../src/read-only-tool-host.js";
import type { CouncilConfig } from "../src/types.js";

function config(directory: string): CouncilConfig {
  return {
    dataDir: directory,
    databasePath: path.join(directory, "unused.sqlite3"),
    delegationWorktreeRoot: path.join(directory, "delegated-worktrees"),
    delegationRetryDelayMs: 1,
    claudeCommand: process.execPath,
    claudeArgs: [],
    claudePermissionMode: "plan",
    claudeTimeoutMs: 5_000,
    claudeKillGraceMs: 50,
    claudeMaxTurns: 3,
    codexCommand: process.execPath,
    codexArgs: [],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    kimiAcpCommand: process.execPath,
    geminiAcpCommand: process.execPath,
    grokAcpCommand: process.execPath,
    codexAcpCommand: process.execPath,
    claudeAcpCommand: process.execPath,
    acpStartupTimeoutMs: 5_000,
    acpKillGraceMs: 50,
    acpMaxFileReadChars: 10_000,
    toolLoopMaxSteps: 4,
    toolLoopMaxContextChars: 20_000,
    toolLoopMaxFileBytes: 10_000,
    toolLoopMaxScanFiles: 100,
    gitCommand: "git",
    gitDiffTimeoutMs: 5_000,
    gitDiffKillGraceMs: 50,
    gitDiffMaxFiles: 20,
    gitDiffMaxLines: 200,
    gitDiffMaxHunksPerFile: 20,
    gitDiffMaxOutputChars: 10_000,
    sqliteBusyTimeoutMs: 5_000,
    schemaMigrationMaxAttempts: 3,
    maxContextChars: 20_000,
    maxOutputChars: 10_000,
    defaultMessageLimit: 20,
  };
}

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  }).trim();
}

function commitEvidence(directory: string): string {
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.name", "Council Test"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(directory, "source.ts"), "export const value = 1;\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "base"]);
  writeFileSync(path.join(directory, "source.ts"), "export const value = 2;\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "review"]);
  return git(directory, ["rev-parse", "HEAD"]);
}

test("ToolHost 只读取项目普通文本并提供有界列目录与搜索", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-tool-host-"));
  try {
    mkdirSync(path.join(directory, "src"));
    writeFileSync(
      path.join(directory, "src", "service.ts"),
      "export const alpha = 1;\nexport const targetValue = alpha;\n",
    );
    writeFileSync(path.join(directory, ".env"), "SECRET_VALUE=hidden\n");
    writeFileSync(path.join(directory, ".env.example"), "SECRET_VALUE=<value>\n");
    const host = await ReadOnlyToolHost.create(directory, config(directory));

    const listed = await host.execute({
      id: "call-list",
      name: "council_list_directory",
      arguments: JSON.stringify({ path: "." }),
    });
    assert.match(listed.content, /"src"/u);
    assert.doesNotMatch(listed.content, /"\.env"/u);
    assert.match(listed.content, /"\.env\.example"/u);

    const read = await host.execute({
      id: "call-read",
      name: "council_read_text_file",
      arguments: JSON.stringify({ path: "src/service.ts", line: 2, limit: 1 }),
    });
    assert.equal(read.content, "2: export const targetValue = alpha;");

    const searched = await host.execute({
      id: "call-search",
      name: "council_search_text",
      arguments: JSON.stringify({ query: "targetValue", path: "src" }),
    });
    assert.match(searched.content, /src\/service\.ts/u);
    assert.match(searched.content, /targetValue/u);

    await assert.rejects(
      host.execute({
        id: "call-secret",
        name: "council_read_text_file",
        arguments: JSON.stringify({ path: ".env" }),
      }),
      (error: unknown) =>
        error instanceof ReadOnlyToolHostError
        && error.diagnosticCode === "protected_path",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ToolHost 用 realpath 拒绝通过软链越过项目边界", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-tool-host-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "council-tool-host-outside-"));
  try {
    const outsideFile = path.join(outside, "outside.txt");
    writeFileSync(outsideFile, "OUTSIDE_SECRET");
    symlinkSync(outsideFile, path.join(directory, "outside-link"));
    const host = await ReadOnlyToolHost.create(directory, config(directory));

    await assert.rejects(
      host.execute({
        id: "call-outside",
        name: "council_read_text_file",
        arguments: JSON.stringify({ path: "outside-link" }),
      }),
      (error: unknown) =>
        error instanceof ReadOnlyToolHostError
        && error.diagnosticCode === "path_outside_project",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("ToolHost 可读取已授权同级仓库的 diff 与上下文，并拒绝其他跨目录", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "council-tool-host-git-"));
  try {
    const backend = path.join(parent, "backend");
    const client = path.join(parent, "client");
    const unrelated = path.join(parent, "unrelated");
    mkdirSync(backend);
    mkdirSync(client);
    mkdirSync(unrelated);
    commitEvidence(backend);
    const clientCommit = commitEvidence(client);
    writeFileSync(path.join(client, "context.ts"), "export const clientContext = true;\n");
    writeFileSync(path.join(client, ".env"), "CLIENT_SECRET=hidden\n");
    writeFileSync(path.join(unrelated, "private.txt"), "UNRELATED_CONTENT\n");
    const host = await ReadOnlyToolHost.create(
      backend,
      config(backend),
      [{ repository: "../client", commit: clientCommit }],
    );

    const result = await host.execute({
      id: "call-client-diff",
      name: "council_git_diff",
      arguments: JSON.stringify({
        repository: "../client",
        commit: clientCommit,
      }),
    });
    assert.match(result.content, /export const value = 2/u);

    const listed = await host.execute({
      id: "call-client-list",
      name: "council_list_directory",
      arguments: JSON.stringify({ repository: "../client", path: "." }),
    });
    assert.match(listed.content, /"repository":"\.\.\/client"/u);
    assert.match(listed.content, /"context\.ts"/u);
    assert.doesNotMatch(listed.content, /"\.env"/u);

    const read = await host.execute({
      id: "call-client-read",
      name: "council_read_text_file",
      arguments: JSON.stringify({
        repository: "../client",
        path: "context.ts",
      }),
    });
    assert.match(read.content, /clientContext = true/u);

    const searched = await host.execute({
      id: "call-client-search",
      name: "council_search_text",
      arguments: JSON.stringify({
        repository: "../client",
        query: "clientContext",
      }),
    });
    assert.match(searched.content, /"repository":"\.\.\/client"/u);
    assert.match(searched.content, /context\.ts/u);

    const legacyPath = await host.execute({
      id: "call-client-legacy-path",
      name: "council_list_directory",
      arguments: JSON.stringify({ path: "../client" }),
    });
    assert.match(legacyPath.content, /"repository":"\.\.\/client"/u);

    await assert.rejects(
      host.execute({
        id: "call-unrelated",
        name: "council_read_text_file",
        arguments: JSON.stringify({ path: "../unrelated/private.txt" }),
      }),
      (error: unknown) =>
        error instanceof ReadOnlyToolHostError
        && error.diagnosticCode === "path_outside_project",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
