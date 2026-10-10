/**
 * @input  依赖：委派仓储、受控 Runtime 阶段、有界 Git、分段执行与安全提交
 * @output 导出：executeTeamWorker（Worker 子委派的单段执行→安全提交→approved）与 TeamWorkerWorkspace
 * @pos    Worker 团队 Worker 的执行闭环；只在 Lead 工作区分叉出的独立 worktree 里执行，
 *         不做 brief / 审核（团队只在 Lead 收尾时统一审核一次），也不认领或回写实施项状态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { EXECUTION_DEFAULTS } from "../config.js";
import type { AgentDefinition } from "../model-router-store.js";
import type { DelegationRuntimeInput } from "./delegation-runtime-stage.js";
import { runExecutionSegments } from "./delegation-execution-segments.js";
import { EXECUTION_CHECKPOINT_INSTRUCTION } from "./delegation-execution-result.js";
import { commitDelegationChanges } from "./delegation-git-delivery.js";
import { snapshotUncommittedWork } from "./delegation-workspace-snapshot.js";
import type { WorkItemDelegationStore } from "./work-item-delegation-store.js";

/** TeamService 事先从 Lead 当前 HEAD 分叉好的 Worker 工作区。 */
export interface TeamWorkerWorkspace {
  root: string;
  cwd: string;
  baseCommit: string;
  branchName: string;
}

export interface TeamWorkerExecutionDeps {
  store: WorkItemDelegationStore;
  executor: AgentDefinition;
  executorProtocol: string;
  generate: (input: DelegationRuntimeInput) => Promise<{ content: string; sessionId?: string }>;
  git: (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
  record: (kind: string, data: Record<string, string | number>) => void;
  maxFileChars: number;
  maxExecutionSegments?: number;
  executionTimeoutMs?: number;
  executionMaxTurns?: number;
}

function compact(value: string, maximum: number): string {
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

/** Worker 只执行 Lead 派发的单个子任务；成功返回交付提交，失败抛错由调用方记为 failed。 */
export async function executeTeamWorker(
  id: string,
  workspace: TeamWorkerWorkspace,
  context: { brief: string; scopePaths: readonly string[]; label: string },
  deps: TeamWorkerExecutionDeps,
  signal: AbortSignal,
): Promise<string> {
  const now = () => new Date().toISOString();
  const delegation = deps.store.update(id, {
    status: "executing", attempt: 1, baseCommit: workspace.baseCommit,
    branchName: workspace.branchName, worktreePath: workspace.root, now: now(),
  });
  deps.record("worker.started", { label: context.label, baseCommit: workspace.baseCommit });
  const segments = deps.maxExecutionSegments ?? 1;
  const response = await runExecutionSegments({
    maxSegments: segments > 1 ? segments : delegation.maxAttempts,
    automaticContinuation: segments > 1,
    timeoutMs: deps.executionTimeoutMs ?? EXECUTION_DEFAULTS.timeoutMs,
    signal,
    read: () => deps.store.getPrivate(id)!,
    save: (budget, summary) => deps.store.update(id, {
      checkpoint: { ...deps.store.getPrivate(id)?.checkpoint, version: 1, executionBudget: { ...budget } },
      ...(summary ? { summary } : {}), now: now(),
    }),
    snapshot: async () => (await snapshotUncommittedWork({ root: workspace.root, headCommit: workspace.baseCommit,
      allowEmpty: true, maxFileChars: deps.maxFileChars, git: deps.git })).tree,
    // Worker 不认领实施项，接续前没有额外版本需要核对；取消由 signal 传达。
    validate: () => undefined,
    record: deps.record,
    generate: (sessionId, continuation, segmentSignal) => deps.generate({
      delegationId: id, stage: "execution", agent: deps.executor, cwd: workspace.cwd,
      ...(sessionId ? { sessionId } : {}),
      permissionProfile: delegation.permissionProfile, signal: segmentSignal,
      prompt: [
        `你是 Worker 团队中的 Worker「${context.label}」，只完成 Lead 派发给你的这一项子任务。`,
        "在当前隔离 worktree 中直接修改代码并运行必要验证；不要切换仓库，不要访问无关目录。",
        "不要自行 git commit；Council 会扫描敏感内容后统一提交，由 Lead 决定是否合并。",
        "不要调用 Council，也不要委派其他 Agent。完成后简要说明改动、涉及文件和测试结果。",
        EXECUTION_CHECKPOINT_INSTRUCTION,
        ...(deps.executorProtocol === "claude-cli" && deps.executionMaxTurns
          ? [`本次最多 ${deps.executionMaxTurns} 个模型回合；预留回合用于验证与阶段交接。`] : []),
        ...(context.scopePaths.length > 0
          ? ["", "建议只改动这些路径（与其他 Worker 分工，越界会增加合并冲突）：", ...context.scopePaths.map((item) => `- ${item}`)]
          : []),
        "",
        "Lead 指令：",
        context.brief,
        continuation,
      ].join("\n"),
    }),
  });
  const summary = compact(response.content, 8_000);
  deps.store.update(id, { summary, ...(response.sessionId ? { executorSessionId: response.sessionId } : {}), now: now() });
  signal.throwIfAborted();
  const headCommit = await commitDelegationChanges({
    root: workspace.root, workItemId: delegation.workItemId,
    baseCommit: workspace.baseCommit, expectedHead: workspace.baseCommit,
    maxFileChars: deps.maxFileChars, git: deps.git,
  });
  deps.record("commit.created", { baseCommit: workspace.baseCommit, headCommit });
  deps.store.update(id, { status: "approved", headCommit, summary, now: now() });
  return headCommit;
}
