/**
 * @input  原隔离工作区、冻结基线与有界 Git 调用
 * @output 未提交代码的只读 Git tree 快照与变更文件数；提交和恢复共用内容检查
 * @pos    显式接续草稿时使用临时索引，不更改原 HEAD、索引、文件或委派历史
 */
import path from "node:path";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CouncilConflictError } from "../errors.js";
import { isProtectedProjectRelativePath } from "../project-path-policy.js";

export const FORBIDDEN_STAGED_PATH = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|settings\.json|[^/]+\.(?:pem|p12|pfx|key|log|sqlite3?(?:-(?:wal|shm|journal))?|db(?:-(?:wal|shm|journal))?))$/iu;
export const SECRET_DIFF_PATTERN = /(?:BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,})/iu;

function checkPath(name: string): void {
  if (!name || isProtectedProjectRelativePath(name) || FORBIDDEN_STAGED_PATH.test(name)
    || /(?:^|\/)(?:data|logs|backups|release-backups)(?:\/|$)/iu.test(name)) {
    throw new CouncilConflictError("恢复草稿包含私密配置、运行数据或不支持的路径，已保留原文件，请先人工检查。");
  }
}

function checkContent(content: string): void {
  if (content.includes("\0") || content.includes("\uFFFD") || SECRET_DIFF_PATTERN.test(content)) {
    throw new CouncilConflictError("恢复草稿包含二进制内容或疑似凭据，已保留原文件，请先人工检查。");
  }
}

export async function snapshotUncommittedWork(input: {
  root: string;
  headCommit: string;
  maxFileChars: number;
  allowEmpty?: boolean;
  git: (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
}): Promise<{ tree: string; fileCount: number }> {
  // 写入临时索引前先筛查，避免已知运行数据与凭据进入 Git 对象库。
  const names = new Set([
    ...(await input.git(input.root, ["diff", "--name-only", "--no-renames", "-z", input.headCommit, "--"])).split("\0"),
    ...(await input.git(input.root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
  ].filter(Boolean));
  for (const name of names) checkPath(name);
  const sourceRoot = await realpath(input.root);
  for (const name of names) {
    const file = path.join(input.root, name);
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new CouncilConflictError("无法检查恢复草稿，已保留原文件，请先人工检查。");
    });
    if (!stat) continue;
    if (!stat.isFile()) throw new CouncilConflictError("恢复草稿包含符号链接或子模块，已保留原文件，请先人工检查。");
    const relative = path.relative(sourceRoot, await realpath(file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CouncilConflictError("恢复草稿路径超出原工作区。");
    if (stat.size > input.maxFileChars) throw new CouncilConflictError("恢复草稿文件超过 Git 检查预算，请先人工检查。");
    checkContent(await readFile(file, "utf8"));
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "council-recovery-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index") };
  const git = (args: string[]) => input.git(input.root, args, env);
  try {
    await git(["read-tree", input.headCommit]);
    await git(["add", "--all", "--"]);
    // 禁止 rename 合并，逐个处理增删路径；NUL 分隔避免空格/换行文件名被误解析。
    const changes = (await git(["diff", "--cached", "--raw", "-z", "--no-renames", input.headCommit, "--"])).split("\0");
    let fileCount = 0;
    for (let index = 0; index < changes.length - 1; index += 2) {
      const header = changes[index]!;
      const name = changes[index + 1]!;
      const mode = /^:\d{6} (\d{6}) /u.exec(header)?.[1];
      checkPath(name);
      if (!mode) throw new CouncilConflictError("恢复草稿格式无效，请先人工检查。");
      if (mode !== "000000") {
        if (mode !== "100644" && mode !== "100755") {
          throw new CouncilConflictError("恢复草稿包含符号链接或子模块，已保留原文件，请先人工检查。");
        }
        const content = await git(["show", `:${name}`]);
        checkContent(content);
      }
      fileCount += 1;
    }
    if (!fileCount && !input.allowEmpty) throw new CouncilConflictError("原工作区没有可接续的未提交代码，请重新委派。");
    if ((await input.git(input.root, ["rev-parse", "HEAD"])).trim() !== input.headCommit) {
      throw new CouncilConflictError("原工作区提交在恢复检查期间已变化，请刷新后检查。");
    }
    return { tree: (await git(["write-tree"])).trim(), fileCount };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
