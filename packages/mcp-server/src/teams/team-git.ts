/**
 * @input  依赖：有界子进程、委派工作区安全快照（敏感路径/凭据扫描）
 * @output 导出：TeamGit（Lead 检查点提交、Worker worktree 分叉/清理、--no-ff 合并与冲突收集）、TeamMergeConflictError
 * @pos    Worker 团队对 Git 的唯一写入口；只操作 Council 管理的 Lead / Worker 隔离 worktree，不碰用户项目工作区
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { CouncilConflictError } from "../errors.js";
import { snapshotUncommittedWork } from "../orchestration/delegation-workspace-snapshot.js";
import { runBoundedProcess, type BoundedProcessMessages, type ProcessResult } from "../process-utils.js";

const GIT_MESSAGES: BoundedProcessMessages = {
  aborted: "Git 操作已取消。",
  timeout: "Git 操作超时。",
  outputLimit: "Git 输出超过安全上限。",
  commandNotFound: "找不到 Git 可执行程序。",
  spawnFailed: "无法启动 Git。",
};

const COUNCIL_IDENTITY = {
  GIT_AUTHOR_NAME: "Council Agent", GIT_AUTHOR_EMAIL: "council@localhost",
  GIT_COMMITTER_NAME: "Council Agent", GIT_COMMITTER_EMAIL: "council@localhost",
} as const;

export const MERGE_CONFLICT_HINT = "请 Lead 自行在工作区合并";

/** 合并冲突：已 merge --abort 回到合并前状态；files 为冲突文件（相对仓库根）。 */
export class TeamMergeConflictError extends CouncilConflictError {
  constructor(readonly files: string[]) {
    super(`合并 Worker 出现冲突（${files.length > 0 ? files.join("、") : "未能列出冲突文件"}）；已撤销本次合并，${MERGE_CONFLICT_HINT}。`);
    this.name = "TeamMergeConflictError";
  }
}

export interface TeamGitConfig {
  gitCommand: string;
  timeoutMs: number;
  killGraceMs: number;
  maxOutputChars: number;
}

export class TeamGit {
  constructor(private readonly config: TeamGitConfig) {}

  async run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ProcessResult> {
    return await runBoundedProcess({
      command: this.config.gitCommand,
      args: ["-c", "core.pager=cat", "-c", "diff.external=", ...args],
      input: "",
      cwd,
      ...(env ? { env } : {}),
      signal: AbortSignal.timeout(this.config.timeoutMs + this.config.killGraceMs),
      timeoutMs: this.config.timeoutMs,
      killGraceMs: this.config.killGraceMs,
      maxOutputChars: this.config.maxOutputChars,
      messages: GIT_MESSAGES,
    });
  }

  async ok(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.run(cwd, args, env);
    if (result.exitCode !== 0) throw new Error("Git 操作失败，请检查项目状态和本地日志。");
    return result.stdout;
  }

  /** 项目路径相对 Git 仓库根的子路径；Worker 的 cwd 与 Lead 保持同一相对位置。 */
  async relativeProjectPath(projectRealPath: string): Promise<string> {
    return (await this.ok(projectRealPath, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/u, "");
  }

  /**
   * 把 Lead 工作区里尚未提交的改动做成检查点提交（与交付提交同一套敏感扫描），返回新的 HEAD。
   * Lead 若自行提交过，先 reset --mixed 回 Council 记录的提交，再把这些改动一起重新扫描。
   */
  async checkpoint(root: string, recordedHead: string, workItemId: string): Promise<string> {
    const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => this.ok(cwd, args, env);
    if ((await git(root, ["rev-parse", "HEAD"])).trim() !== recordedHead) {
      await git(root, ["reset", "--mixed", recordedHead]);
    }
    const snapshot = await snapshotUncommittedWork({
      root, headCommit: recordedHead, allowEmpty: true, maxFileChars: this.config.maxOutputChars, git,
    });
    if (snapshot.fileCount > 0) {
      await git(root, ["read-tree", snapshot.tree]);
      await git(root, ["commit", "-m", `council: team checkpoint ${workItemId}`], { ...process.env, ...COUNCIL_IDENTITY });
    }
    return (await git(root, ["rev-parse", "HEAD"])).trim();
  }

  async addWorktree(repoRoot: string, branchName: string, worktreePath: string, base: string): Promise<void> {
    await this.ok(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, base]);
  }

  /** 派发失败时的尽力清理；不抛错，避免掩盖真正的失败原因。 */
  async removeWorktree(repoRoot: string, branchName: string, worktreePath: string): Promise<void> {
    await this.run(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    await this.run(repoRoot, ["branch", "-D", branchName]).catch(() => undefined);
  }

  /** --no-ff 合并 Worker 分支；冲突时收集文件后 merge --abort，并抛 TeamMergeConflictError。 */
  async merge(root: string, branchName: string, label: string): Promise<string> {
    const env = { ...process.env, ...COUNCIL_IDENTITY };
    const result = await this.run(root, ["merge", "--no-ff", "--no-edit", "-m", `council: merge worker ${label}`, branchName], env);
    if (result.exitCode !== 0) {
      const conflicted = await this.run(root, ["diff", "--name-only", "--diff-filter=U"]);
      const files = conflicted.exitCode === 0 ? conflicted.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
      await this.run(root, ["merge", "--abort"]);
      throw new TeamMergeConflictError(files);
    }
    return (await this.ok(root, ["rev-parse", "HEAD"])).trim();
  }
}
