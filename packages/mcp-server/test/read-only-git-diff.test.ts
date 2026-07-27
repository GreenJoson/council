/**
 * @input  依赖：临时 Git 仓库、只读 Git diff 服务与单工具 MCP server
 * @output 验证：commit/ref 解析、敏感路径过滤、外部驱动禁用、预算降级与 MCP 调用
 * @pos    ToolLoop 与 ACP DelegatedRuntime 共用 Git 边界的对抗性回归
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ReadOnlyGitDiff,
  ReadOnlyGitDiffError,
  type ReadOnlyGitDiffConfig,
} from "../src/read-only-git-diff.js";
import { createReadOnlyGitMcpServer } from "../src/read-only-git-mcp.js";

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  }).trim();
}

function config(overrides: Partial<ReadOnlyGitDiffConfig> = {}): ReadOnlyGitDiffConfig {
  return {
    gitCommand: "git",
    gitDiffTimeoutMs: 5_000,
    gitDiffKillGraceMs: 50,
    gitDiffMaxFiles: 20,
    gitDiffMaxLines: 200,
    gitDiffMaxHunksPerFile: 20,
    gitDiffMaxOutputChars: 20_000,
    ...overrides,
  };
}

function initializeRepository(directory: string): void {
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.name", "Council Test"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  mkdirSync(path.join(directory, "src"));
  writeFileSync(path.join(directory, "src", "service.ts"), "export const value = 1;\n");
  writeFileSync(path.join(directory, ".env"), "PRIVATE_TOKEN=old-secret\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "base"]);
}

function createReviewCommit(directory: string): string {
  writeFileSync(path.join(directory, "src", "service.ts"), "export const value = 2;\n");
  writeFileSync(path.join(directory, ".env"), "PRIVATE_TOKEN=new-secret\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "review"]);
  return git(directory, ["rev-parse", "HEAD"]);
}

test("受控 Git diff 独立读取 commit 并过滤被跟踪的敏感文件", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-git-diff-"));
  try {
    initializeRepository(directory);
    const marker = path.join(directory, "external-diff-ran");
    const external = path.join(directory, "external-diff");
    writeFileSync(
      external,
      `#!/bin/sh\nprintf 'unsafe' > ${JSON.stringify(marker)}\n`,
    );
    chmodSync(external, 0o700);
    git(directory, ["config", "diff.external", external]);
    const commit = createReviewCommit(directory);

    const reader = await ReadOnlyGitDiff.create(directory, config());
    const output = await reader.generate({ commit });

    assert.match(output, /src\/service\.ts/u);
    assert.match(output, /export const value = 2/u);
    assert.match(output, /已按安全策略隐去 1 个敏感路径/u);
    assert.doesNotMatch(output, /PRIVATE_TOKEN|new-secret|old-secret|\.env/u);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("受控 Git diff 拒绝 option、range 注入与路径型 ref", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-git-ref-"));
  try {
    initializeRepository(directory);
    const reader = await ReadOnlyGitDiff.create(directory, config());
    for (const commit of [
      "--upload-pack=/bin/sh",
      "-x",
      "a\nb",
      "../../etc",
      "main..other",
      "refs/heads/main.lock",
    ]) {
      await assert.rejects(
        reader.generate({ commit }),
        (error: unknown) =>
          error instanceof ReadOnlyGitDiffError
          && error.diagnosticCode === "invalid_git_ref",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("敏感文件改名为普通路径时整条 rename 仍被过滤", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-git-rename-"));
  try {
    initializeRepository(directory);
    renameSync(
      path.join(directory, ".env"),
      path.join(directory, "src", "recovered.txt"),
    );
    git(directory, ["add", "."]);
    git(directory, ["commit", "-qm", "rename sensitive file"]);
    const reader = await ReadOnlyGitDiff.create(directory, config());

    const output = await reader.generate({ commit: "HEAD" });

    assert.match(output, /已按安全策略隐去 1 个敏感路径/u);
    assert.doesNotMatch(
      output,
      /PRIVATE_TOKEN|old-secret|recovered\.txt|\.env/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("patch 超过预算时明确降级为安全路径统计摘要", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-git-budget-"));
  try {
    initializeRepository(directory);
    const commit = createReviewCommit(directory);
    const reader = await ReadOnlyGitDiff.create(
      directory,
      config({ gitDiffMaxLines: 1 }),
    );
    const output = await reader.generate({ commit });
    assert.match(output, /超过行数或单文件 hunk 预算/u);
    assert.match(output, /src\/service\.ts/u);
    assert.doesNotMatch(output, /PRIVATE_TOKEN|new-secret|old-secret|\.env/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("单工具 MCP 只公开 council_git_diff 并返回同一安全结果", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-git-mcp-"));
  try {
    initializeRepository(directory);
    const commit = createReviewCommit(directory);
    const server = await createReadOnlyGitMcpServer(directory, config());
    const client = new Client({ name: "git-diff-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ["council_git_diff"],
      );
      const response = await client.callTool({
        name: "council_git_diff",
        arguments: { commit },
      });
      assert.ok(Array.isArray(response.content));
      const text = response.content
        .flatMap((item: unknown) => {
          if (
            typeof item === "object"
            && item !== null
            && "type" in item
            && item.type === "text"
            && "text" in item
            && typeof item.text === "string"
          ) {
            return [item.text];
          }
          return [];
        })
        .join("\n");
      assert.match(text, /src\/service\.ts/u);
      assert.doesNotMatch(text, /PRIVATE_TOKEN|new-secret|old-secret|\.env/u);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
