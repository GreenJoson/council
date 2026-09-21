/** @input 受管工作区、上一份已记录提交与安全快照；@output 追加交付提交；@pos 扫描通过后才更新索引，失败不会回退已保存提交。 */
import { snapshotUncommittedWork } from "./delegation-workspace-snapshot.js";

export async function commitDelegationChanges(input: {
  root: string;
  workItemId: string;
  baseCommit: string;
  expectedHead: string;
  maxFileChars: number;
  git: (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
}): Promise<string> {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => input.git(input.root, args, env);
  if ((await git(["rev-parse", "HEAD"])).trim() !== input.expectedHead) {
    // Agent 自行创建的提交重新扫描；上一轮 Council 提交始终保留。
    await git(["reset", "--mixed", input.expectedHead]);
  }
  const snapshot = await snapshotUncommittedWork({ ...input, headCommit: input.expectedHead, allowEmpty: true });
  if (snapshot.fileCount > 0) {
    await git(["read-tree", snapshot.tree]);
    await git(["commit", "-m", `council: implement ${input.workItemId}`], {
      ...process.env, GIT_AUTHOR_NAME: "Council Agent", GIT_AUTHOR_EMAIL: "council@localhost",
      GIT_COMMITTER_NAME: "Council Agent", GIT_COMMITTER_EMAIL: "council@localhost",
    });
  }
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (head === input.baseCommit) throw new Error("执行 Agent 没有产生代码改动。");
  return head;
}
