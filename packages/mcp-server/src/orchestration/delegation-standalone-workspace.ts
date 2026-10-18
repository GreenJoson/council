/**
 * @input  依赖：Council 管理的委派根目录、有界 Git 调用（失败即抛错）、项目目录
 * @output 导出：STANDALONE_DEMO_DIR、prepareStandaloneRepository（非 Git 项目原型用的独立仓库，空基线提交）、
 *         standaloneCommonDir（工作区的 Git 对象库落在委派根目录内时返回它，否则 undefined）、
 *         standaloneWorkspaceInstructions（执行/审核提示词段落）、exportStandaloneDemo（审核通过后导出成普通文件夹）
 * @pos    项目目录不是 Git 仓库时，流水线原型的代码委派改在这里准备的独立仓库里做静态 Demo：
 *         仓库只建在委派根目录下，不在用户项目里 git init；执行、diff 审核、交接接续照旧走 Git；
 *         导出是唯一写进项目目录的一步——只新建 `council-demos/<名称>/`，同名已存在就加序号，从不覆盖或删除
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import path from "node:path";
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { COUNCIL_INPUT_DIR } from "./delegation-image-execution.js";

/** 导出目录：项目根下的普通文件夹，每次通过的 Demo 一个子目录。 */
export const STANDALONE_DEMO_DIR = "council-demos";

const COUNCIL_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Council Agent",
  GIT_AUTHOR_EMAIL: "council@localhost",
  GIT_COMMITTER_NAME: "Council Agent",
  GIT_COMMITTER_EMAIL: "council@localhost",
};
const MAX_NAME_CHARS = 40;
const MAX_NAME_ATTEMPTS = 100;

type Git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;

/**
 * 在 root（委派根目录下的新目录）建独立仓库并提交一个空树基线：执行者的改动整体落在基线之后，
 * 审核、提交扫描与接续都能沿用 worktree 那套流程。root 已存在即失败，不复用残留目录。
 */
export async function prepareStandaloneRepository(input: {
  root: string;
  branchName: string;
  git: Git;
}): Promise<string> {
  await mkdir(input.root, { mode: 0o700 });
  await input.git(input.root, ["init", "-q"]);
  // 不用 init -b（旧版 Git 不支持）：直接把 HEAD 指向委派分支，与 worktree 模式的分支名一致。
  await input.git(input.root, ["symbolic-ref", "HEAD", `refs/heads/${input.branchName}`]);
  const emptyTree = (await input.git(input.root, ["mktree"])).trim();
  const commit = (await input.git(input.root,
    ["commit-tree", emptyTree, "-m", "chore: start Council demo workspace"],
    { ...process.env, ...COUNCIL_IDENTITY })).trim();
  await input.git(input.root, ["update-ref", `refs/heads/${input.branchName}`, commit, "0".repeat(commit.length)]);
  return commit;
}

/**
 * 工作区的 Git 对象库在委派根目录内 → 独立 Demo 仓库（首次准备的仓库，或接续时从它分出的 worktree）。
 * 普通项目的 worktree 对象库在用户仓库里，返回 undefined。
 */
export async function standaloneCommonDir(input: {
  root: string;
  worktreeRoot: string;
  git: Git;
}): Promise<string | undefined> {
  const managed = await realpath(input.worktreeRoot);
  const common = await realpath(path.resolve(input.root,
    (await input.git(input.root, ["rev-parse", "--git-common-dir"])).trim()));
  const relative = path.relative(managed, common);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? common : undefined;
}

/** 执行者与审核者都要知道的约定：Demo 形态、图片引用方式，以及项目目录只读。 */
export function standaloneWorkspaceInstructions(projectPath: string): string[] {
  return [
    "",
    "独立 Demo 工作区：项目目录不是 Git 仓库，本次在 Council 准备的独立工作区（当前目录，初始为空）里做本地可运行的静态 Demo。",
    "- 入口放在当前目录的 index.html，只用 HTML/CSS/原生 JS，双击即可在浏览器打开；不装依赖、不要构建步骤、离线也能看。",
    `- 图片用相对路径直接引用 \`${COUNCIL_INPUT_DIR}/\` 里的输入图，不要复制或生成二进制文件（Council 只提交文本文件）；目录名避开 data/、logs/、backups/。`,
    `- 审核通过后，Council 会把 Demo 连同引用的输入图导出到项目目录的 ${STANDALONE_DEMO_DIR}/ 下。`,
    `- 项目目录 ${projectPath} 只作参考，可以只读查看，不要修改。`,
  ];
}

/** 文件夹名：保留字母、数字与中日韩文字，其余折成连字符；空了就叫 demo。 */
function demoFolderName(name: string): string {
  const slug = name.normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/u, "");
  return slug || "demo";
}

function safeRelative(name: string): string {
  const parts = name.split("/");
  if (!name || path.isAbsolute(name) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Demo 包含无效路径，已停止导出。");
  }
  return path.join(...parts);
}

/**
 * 导出：已审核提交里的全部文件（按提交内容，而不是工作区现状）+ `.council/in/` 里的输入图，
 * 先写进 `council-demos/` 下的临时目录，完整写完再改名为最终目录；失败时只清理临时目录。
 */
export async function exportStandaloneDemo(input: {
  root: string;
  headCommit: string;
  projectPath: string;
  name: string;
  git: Git;
}): Promise<{ path: string; fileCount: number }> {
  const project = await realpath(input.projectPath);
  const demosDir = path.join(project, STANDALONE_DEMO_DIR);
  const existing = await lstat(demosDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isDirectory()) {
    throw new Error(`项目里的 ${STANDALONE_DEMO_DIR} 不是普通文件夹，已停止导出。`);
  }
  if (!existing) await mkdir(demosDir);

  const files = (await input.git(input.root, ["ls-tree", "-r", "-z", "--name-only", input.headCommit]))
    .split("\0").filter(Boolean);
  if (files.length === 0) throw new Error("Demo 没有可导出的文件。");
  const staging = path.join(demosDir, `.partial-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const name of files) {
      const target = path.join(staging, safeRelative(name));
      await mkdir(path.dirname(target), { recursive: true });
      const content = await input.git(input.root, ["cat-file", "blob", `${input.headCommit}:${name}`]);
      await writeFile(target, content, { flag: "wx" });
    }
    let fileCount = files.length;
    // 输入图不进提交（只提交文本），页面按 `.council/in/` 相对路径引用，导出时原样带上。
    const inputDir = path.join(input.root, COUNCIL_INPUT_DIR);
    const inputs = await readdir(inputDir).catch(() => [] as string[]);
    for (const file of inputs) {
      const source = path.join(inputDir, file);
      if (!(await lstat(source)).isFile()) continue;
      const target = path.join(staging, COUNCIL_INPUT_DIR, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      fileCount += 1;
    }
    const base = demoFolderName(input.name);
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const folder = attempt === 1 ? base : `${base}-${attempt}`;
      const finalPath = path.join(demosDir, folder);
      if (await lstat(finalPath).then(() => true, () => false)) continue;
      await rename(staging, finalPath);
      return { path: `${STANDALONE_DEMO_DIR}/${folder}`, fileCount };
    }
    throw new Error(`${STANDALONE_DEMO_DIR} 下同名 Demo 过多，请先整理后重试。`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
