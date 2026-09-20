/** @input 临时 Git 仓库；@output 草稿快照、原索引保留及敏感文件拒绝验证；@pos 未提交工作恢复的边界回归。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotUncommittedWork } from "../src/orchestration/delegation-workspace-snapshot.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "council-draft-test-"));
  const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.com"]);
  writeFileSync(path.join(root, "README.md"), "baseline\n");
  writeFileSync(path.join(root, "removed.txt"), "remove later\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  const headCommit = git(root, ["rev-parse", "HEAD"]).trim();
  return { root, headCommit, git, snapshot: () => snapshotUncommittedWork({ root, headCommit, maxFileChars: 100_000, git: async (...args) => git(...args) }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("草稿包含增删改及换行文件名，原 HEAD、索引与文件保持不变", async () => {
  const h = fixture();
  try {
    writeFileSync(path.join(h.root, "README.md"), "staged\n");
    h.git(h.root, ["add", "README.md"]);
    writeFileSync(path.join(h.root, "README.md"), "latest unstaged\n");
    rmSync(path.join(h.root, "removed.txt"));
    const name = "new file\ncontinued.ts";
    writeFileSync(path.join(h.root, name), "export const unfinished = true;\n");
    const index = readFileSync(path.join(h.root, ".git/index"));
    const result = await h.snapshot();
    assert.equal(result.fileCount, 3);
    assert.equal(h.git(h.root, ["show", `${result.tree}:README.md`]), "latest unstaged\n");
    assert.match(h.git(h.root, ["show", `${result.tree}:${name}`]), /unfinished/);
    assert.throws(() => h.git(h.root, ["show", `${result.tree}:removed.txt`]));
    assert.deepEqual(readFileSync(path.join(h.root, ".git/index")), index);
    assert.equal(h.git(h.root, ["rev-parse", "HEAD"]).trim(), h.headCommit);
    assert.equal(readFileSync(path.join(h.root, "README.md"), "utf8"), "latest unstaged\n");
  } finally { h.close(); }
});

for (const [name, content] of [
  ["runtime.sqlite3", "private rows"], ["runtime.sqlite3-wal", "private rows"],
  ["runtime.log", "private log"], [".env", "PRIVATE_SETTING=example"],
  ["settings.json", "{}"], ["secret.ts", 'const token = "fixture-secret-only";'],
  ["binary.txt", "binary\0content"],
]) {
  test(`恢复拒绝 ${name} 并保留原文件`, async () => {
    const h = fixture();
    try {
      writeFileSync(path.join(h.root, name!), content!);
      await assert.rejects(h.snapshot(), /私密配置|疑似凭据/);
      assert.equal(readFileSync(path.join(h.root, name!), "utf8"), content);
      assert.equal(h.git(h.root, ["diff", "--cached"]), "");
      assert.equal(h.git(h.root, ["rev-parse", "HEAD"]).trim(), h.headCommit);
    } finally { h.close(); }
  });
}

test("恢复拒绝符号链接、空草稿与外部改变的 HEAD", async () => {
  const h = fixture();
  try {
    await assert.rejects(h.snapshot(), /没有可接续/);
    symlinkSync("README.md", path.join(h.root, "linked.txt"));
    await assert.rejects(h.snapshot(), /符号链接/);
    rmSync(path.join(h.root, "linked.txt"));
    writeFileSync(path.join(h.root, "new.txt"), "new\n");
    h.git(h.root, ["add", "new.txt"]);
    h.git(h.root, ["commit", "--quiet", "-m", "external"]);
    await assert.rejects(h.snapshot(), /提交在恢复检查期间已变化/);
  } finally { h.close(); }
});
