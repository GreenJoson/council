/**
 * @input  依赖：原委派检查点、当前项目与受控 Git 执行器
 * @output 导出：失败分类，以及已提交检查点/未提交草稿的恢复前工作区验证
 * @pos    仅显式恢复；保留原目录与历史，验证草稿时 HEAD 必须仍为原基线
 */
import path from "node:path";
import { realpath } from "node:fs/promises";
import { ClaudeRuntimeError } from "../claude-runtime.js";
import { CodexRuntimeError } from "../codex-runtime.js";
import { CouncilConflictError } from "../errors.js";
import type { DelegationPrivateState } from "./work-item-delegation-store.js";

export function delegationFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof ClaudeRuntimeError || error instanceof CodexRuntimeError) {
    if (error.diagnosticCode === "stream_output_limit" || error.diagnosticCode === "final_output_limit"
      || ["max_turns_exhausted", "budget_exhausted", "permission_denied", "invalid_result"].includes(error.diagnosticCode)) {
      return error.diagnosticCode;
    }
    if (error.diagnosticCode.startsWith("authentication")) return "authentication_failed";
    if (error.diagnosticCode.startsWith("quota")) return "quota_exhausted";
    if (error.diagnosticCode.startsWith("model_unavailable")) return "model_unavailable";
    if (error.diagnosticCode.startsWith("transient")) return "transient_failure";
    if (error.diagnosticCode.includes("timeout")) return "timeout";
  }
  return "execution_failed";
}

export async function validateRecoveryCheckpoint(input: {
  previous: DelegationPrivateState;
  projectPath: string;
  worktreeRoot: string;
  git: (cwd: string, args: string[]) => Promise<string>;
}): Promise<{ originalRoot: string; relativeProjectPath: string; baseCommit: string; headCommit: string; oldRoot: string; mode: "commit" | "workspace" }> {
  const { previous, git } = input;
  const headCommit = previous.headCommit ?? previous.baseCommit;
  const mode = previous.headCommit ? "commit" : "workspace";
  if (!previous.worktreePath || !previous.baseCommit || !headCommit
    || !/^[a-f0-9]{40,64}$/u.test(previous.baseCommit) || !/^[a-f0-9]{40,64}$/u.test(headCommit)) {
    throw new CouncilConflictError("没有可验证的原工作区，请检查后重新委派。");
  }
  const managed = await realpath(input.worktreeRoot);
  const oldRoot = await realpath(previous.worktreePath);
  const contained = path.relative(managed, oldRoot);
  if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) {
    throw new CouncilConflictError("恢复工作区不在 Council 管理目录内。");
  }
  const project = await realpath(input.projectPath);
  const originalRoot = (await git(project, ["rev-parse", "--show-toplevel"])).trim();
  const originalCommon = await realpath(path.resolve(originalRoot, (await git(originalRoot, ["rev-parse", "--git-common-dir"])).trim()));
  const oldCommon = await realpath(path.resolve(oldRoot, (await git(oldRoot, ["rev-parse", "--git-common-dir"])).trim()));
  if (oldCommon !== originalCommon || (await git(oldRoot, ["rev-parse", "HEAD"])).trim() !== headCommit) {
    throw new CouncilConflictError("恢复工作区或提交已经变化，请检查后重新委派。");
  }
  if (mode === "commit" && (await git(oldRoot, ["status", "--porcelain=v1"])).trim()) {
    throw new CouncilConflictError("原工作区有未提交改动；已保留文件，请先人工检查，不能自动恢复。");
  }
  const base = (await git(oldRoot, ["merge-base", previous.baseCommit, headCommit])).trim();
  if (base !== previous.baseCommit) throw new CouncilConflictError("恢复提交不属于原始基线。");
  return { originalRoot, relativeProjectPath: path.relative(originalRoot, project), baseCommit: base, headCommit, oldRoot, mode };
}
