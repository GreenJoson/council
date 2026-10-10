/**
 * @input  依赖：尚无 HEAD 的 Git 仓库根目录与有界 Git 调用
 * @output 导出：createInitialBaseline（经过敏感路径与凭据扫描的初始提交）
 * @pos    「建立安全基线并委派」的唯一实现；用临时索引建树，只认领仍不存在的初始分支，失败不改用户文件
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessResult } from "../process-utils.js";
import { FORBIDDEN_STAGED_PATH, SECRET_DIFF_PATTERN } from "./delegation-workspace-snapshot.js";

export interface BaselineGit {
  /** 失败即抛错的 Git 调用。 */
  git: (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<ProcessResult>;
  /** 不因退出码抛错的 Git 调用。 */
  runGit: (cwd: string, args: string[]) => Promise<ProcessResult>;
}

export async function createInitialBaseline(root: string, deps: BaselineGit): Promise<string> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "council-baseline-"));
  const indexPath = path.join(temporaryDirectory, "index");
  const indexEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
  };
  try {
    await deps.git(root, ["read-tree", "--empty"], indexEnv);
    await deps.git(root, ["add", "--all"], indexEnv);
    const names = (await deps.git(root,
      ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "--"], indexEnv)).stdout.split("\n").filter(Boolean);
    if (names.length === 0) {
      throw new Error("项目没有可建立安全基线的文件。");
    }
    if (names.some((name) => FORBIDDEN_STAGED_PATH.test(name))) {
      throw new Error("安全基线包含凭据或私密配置文件，已停止执行。");
    }
    const stagedDiff = (await deps.git(root,
      ["diff", "--cached", "--no-ext-diff", "--unified=0", "--"], indexEnv)).stdout;
    if (SECRET_DIFF_PATTERN.test(stagedDiff)) {
      throw new Error("安全基线疑似包含凭据，已停止执行。");
    }
    const tree = (await deps.git(root, ["write-tree"], indexEnv)).stdout.trim();
    const headRefResult = await deps.runGit(root, ["symbolic-ref", "-q", "HEAD"]);
    const headRef = headRefResult.stdout.trim();
    if (headRefResult.exitCode !== 0 || !headRef.startsWith("refs/heads/")) {
      throw new Error("项目初始分支无效，不能建立安全基线。");
    }
    const commitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Council Agent",
      GIT_AUTHOR_EMAIL: "council@localhost",
      GIT_COMMITTER_NAME: "Council Agent",
      GIT_COMMITTER_EMAIL: "council@localhost",
    };
    const commit = (await deps.git(root,
      ["commit-tree", tree, "-m", "chore: establish Council baseline"], commitEnv)).stdout.trim();
    // 初始基线只能认领仍不存在的分支，不能覆盖用户并发创建的第一个提交。
    await deps.git(root, ["update-ref", headRef, commit, "0".repeat(commit.length)]);
    // 只同步索引，不改工作文件；这样安全基线失败前后都不会吞掉用户内容。
    await deps.git(root, ["reset", "--mixed", "--quiet", commit]);
    return commit;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
