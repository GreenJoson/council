/**
 * @input  依赖：项目 realpath、本轮授权仓库/精确 commit、受控 Git 配置与 AbortSignal
 * @output 导出：限定当前/同级仓库与冻结 commit、过滤敏感路径并受预算约束的只读 diff
 * @pos    ToolLoop 与 ACP DelegatedRuntime 共用的多仓库 Git 读取边界；不经过 Shell、不读取工作区未提交内容
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { runBoundedProcess } from "./process-utils.js";
import { isProtectedProjectRelativePath } from "./project-path-policy.js";

export const COUNCIL_GIT_DIFF_TOOL_NAME = "council_git_diff";

const REF_PATTERN = /^(?![-.])[A-Za-z0-9._/-]{1,200}$/u;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REPOSITORY_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9._-]+`;
const REPOSITORY_PATTERN = new RegExp(
  String.raw`^(?:\.|(?:\.\./)?${REPOSITORY_SEGMENT}(?:/${REPOSITORY_SEGMENT})*)$`,
  "u",
);
const OUTPUT_LIMIT_MESSAGE = "Council Git diff 输出超过安全上限。";

interface ChangedRecord {
  status: string;
  paths: string[];
}

export interface GitDiffRequest {
  /** 相对议题项目目录的已授权仓库标签；当前仓库默认使用 `.`。 */
  repository?: string;
  commit?: string;
  base?: string;
  head?: string;
}

export interface GitCommitGrant {
  repository: string;
  commit: string;
}

interface RepositoryAccess {
  root?: string;
  error?: ReadOnlyGitDiffError;
  commits?: ReadonlySet<string>;
}

export interface ReadOnlyGitDiffConfig {
  gitCommand: string;
  gitDiffTimeoutMs: number;
  gitDiffKillGraceMs: number;
  gitDiffMaxFiles: number;
  gitDiffMaxLines: number;
  gitDiffMaxHunksPerFile: number;
  gitDiffMaxOutputChars: number;
}

export class ReadOnlyGitDiffError extends Error {
  constructor(
    message: string,
    readonly diagnosticCode: string,
  ) {
    super(message);
    this.name = "ReadOnlyGitDiffError";
  }
}

function normalizeRef(value: string | undefined, name: string): string {
  const ref = value?.trim() ?? "";
  if (
    !REF_PATTERN.test(ref)
    || ref.includes("..")
    || ref.includes("@{")
    || ref.includes("//")
    || ref.endsWith("/")
    || ref.endsWith(".lock")
  ) {
    throw new ReadOnlyGitDiffError(
      `${name} 不是允许的 Git ref。`,
      "invalid_git_ref",
    );
  }
  return ref;
}

export function normalizeGitRepositoryLabel(value: string | undefined): string {
  const repository = value?.trim() || ".";
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new ReadOnlyGitDiffError(
      "repository 必须是当前仓库、仓库内相对路径或一层同级仓库。",
      "invalid_repository",
    );
  }
  return repository;
}

export function normalizeGitCommitGrant(grant: GitCommitGrant): GitCommitGrant {
  const repository = normalizeGitRepositoryLabel(grant.repository);
  const commit = grant.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/u.test(commit)) {
    throw new ReadOnlyGitDiffError(
      "授权 commit 必须是 7 至 64 位十六进制对象名。",
      "invalid_git_grant",
    );
  }
  return { repository, commit };
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveAuthorizedRoot(
  primaryRoot: string,
  repository: string,
): Promise<string> {
  const candidate = await realpath(path.resolve(primaryRoot, repository));
  const info = await lstat(candidate);
  if (!info.isDirectory()) {
    throw new ReadOnlyGitDiffError(
      `关联仓库 ${repository} 不是目录。`,
      "repository_unavailable",
    );
  }
  if (repository === ".") {
    return primaryRoot;
  }
  if (repository.startsWith("../")) {
    const parent = path.dirname(primaryRoot);
    if (
      candidate === parent
      || !withinRoot(parent, candidate)
      || withinRoot(primaryRoot, candidate)
    ) {
      throw new ReadOnlyGitDiffError(
        `关联仓库 ${repository} 超出允许的一层同级目录。`,
        "repository_outside_scope",
      );
    }
    return candidate;
  }
  if (!withinRoot(primaryRoot, candidate)) {
    throw new ReadOnlyGitDiffError(
      `关联仓库 ${repository} 通过链接逃逸出当前项目。`,
      "repository_outside_scope",
    );
  }
  return candidate;
}

function parseRequest(input: GitDiffRequest): {
  mode: "commit" | "range";
  commit?: string;
  base?: string;
  head?: string;
} {
  const hasCommit = input.commit !== undefined;
  const hasRange = input.base !== undefined || input.head !== undefined;
  if (hasCommit === hasRange) {
    throw new ReadOnlyGitDiffError(
      "必须提供 commit，或同时提供 base 与 head。",
      "invalid_tool_arguments",
    );
  }
  if (hasCommit) {
    return {
      mode: "commit",
      commit: normalizeRef(input.commit, "commit"),
    };
  }
  if (input.base === undefined || input.head === undefined) {
    throw new ReadOnlyGitDiffError(
      "base 与 head 必须同时提供。",
      "invalid_tool_arguments",
    );
  }
  return {
    mode: "range",
    base: normalizeRef(input.base, "base"),
    head: normalizeRef(input.head, "head"),
  };
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "Never",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
  };
  if (process.env.PATH) {
    environment.PATH = process.env.PATH;
  }
  if (process.platform === "win32" && process.env.SystemRoot) {
    environment.SystemRoot = process.env.SystemRoot;
  }
  return environment;
}

function parseNameStatus(output: string): ChangedRecord[] {
  if (!output) {
    return [];
  }
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }
  const records: ChangedRecord[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    if (!/^[A-Z][0-9]*$/u.test(status)) {
      throw new ReadOnlyGitDiffError(
        "Git 返回了无法识别的变更清单。",
        "invalid_git_output",
      );
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = tokens.slice(index, index + pathCount);
    if (
      paths.length !== pathCount
      || paths.some((candidate) => !candidate || candidate.includes("\0"))
    ) {
      throw new ReadOnlyGitDiffError(
        "Git 返回了不完整的变更路径。",
        "invalid_git_output",
      );
    }
    index += pathCount;
    records.push({ status, paths });
  }
  return records;
}

function uniquePaths(records: readonly ChangedRecord[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const record of records) {
    for (const candidate of record.paths) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        paths.push(candidate);
      }
    }
  }
  return paths;
}

function statusSummary(
  records: readonly ChangedRecord[],
  maximum: number,
): string {
  const visible = records.slice(0, maximum).map((record) =>
    `${record.status}\t${record.paths.join(" -> ")}`);
  const omitted = Math.max(0, records.length - visible.length);
  return [
    ...visible,
    ...(omitted > 0
      ? [`[Council：另有 ${String(omitted)} 个安全路径未展开]`]
      : []),
  ].join("\n");
}

function exceedsPatchBudget(
  patch: string,
  maxLines: number,
  maxHunksPerFile: number,
): boolean {
  const lines = patch.split(/\r?\n/u);
  if (lines.length > maxLines) {
    return true;
  }
  let hunks = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hunks = 0;
    } else if (line.startsWith("@@ ")) {
      hunks += 1;
      if (hunks > maxHunksPerFile) {
        return true;
      }
    }
  }
  return false;
}

export class ReadOnlyGitDiff {
  readonly #repositories: ReadonlyMap<string, RepositoryAccess>;
  readonly #config: ReadOnlyGitDiffConfig;

  private constructor(
    repositories: ReadonlyMap<string, RepositoryAccess>,
    config: ReadOnlyGitDiffConfig,
  ) {
    this.#repositories = repositories;
    this.#config = config;
  }

  static async create(
    projectPath: string,
    config: ReadOnlyGitDiffConfig,
    commitGrants: readonly GitCommitGrant[] = [],
  ): Promise<ReadOnlyGitDiff> {
    const root = await realpath(projectPath);
    const info = await lstat(root);
    if (!info.isDirectory()) {
      throw new ReadOnlyGitDiffError(
        "当前项目路径不是目录。",
        "invalid_project_path",
      );
    }
    const grants = commitGrants.map(normalizeGitCommitGrant);
    const labels = grants.length > 0
      ? [...new Set(grants.map((grant) => grant.repository))]
      : ["."];
    const repositories = new Map<string, RepositoryAccess>();
    for (const repository of labels) {
      try {
        repositories.set(repository, {
          root: await resolveAuthorizedRoot(root, repository),
          ...(grants.length > 0
            ? {
                commits: new Set(
                  grants
                    .filter((grant) => grant.repository === repository)
                    .map((grant) => grant.commit),
                ),
              }
            : {}),
        });
      } catch (error) {
        if (repository === ".") {
          throw error;
        }
        repositories.set(repository, {
          error: error instanceof ReadOnlyGitDiffError
            ? error
            : new ReadOnlyGitDiffError(
                `关联仓库 ${repository} 无法读取。`,
                "repository_unavailable",
              ),
        });
      }
    }
    return new ReadOnlyGitDiff(repositories, config);
  }

  async generate(
    input: GitDiffRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const repository = normalizeGitRepositoryLabel(input.repository);
    const access = this.#repositories.get(repository);
    if (!access) {
      throw new ReadOnlyGitDiffError(
        `仓库 ${repository} 未被本轮议题授权。`,
        "repository_not_authorized",
      );
    }
    if (access.error || !access.root) {
      throw access.error ?? new ReadOnlyGitDiffError(
        `关联仓库 ${repository} 无法读取。`,
        "repository_unavailable",
      );
    }
    const root = access.root;
    const request = parseRequest(input);
    if (access.commits) {
      const requestedRefs = request.mode === "commit"
        ? [request.commit!]
        : [request.base!, request.head!];
      if (requestedRefs.some((ref) => !access.commits!.has(ref.toLowerCase()))) {
        throw new ReadOnlyGitDiffError(
          `仓库 ${repository} 的该 commit/ref 未被本轮议题授权。`,
          "commit_not_authorized",
        );
      }
    }
    const head = await this.#resolveCommit(
      root,
      request.mode === "commit" ? request.commit! : request.head!,
      signal,
    );
    let base: string | undefined;
    let rootCommit = false;
    if (request.mode === "range") {
      base = await this.#resolveCommit(root, request.base!, signal);
    } else {
      const parents = (await this.#run(
        root,
        ["rev-list", "--parents", "-n", "1", head],
        signal,
      )).trim().split(/\s+/u);
      if (parents[0] !== head || parents.some((candidate) => !OID_PATTERN.test(candidate))) {
        throw new ReadOnlyGitDiffError(
          "Git 返回了无效的 commit 父链。",
          "invalid_git_output",
        );
      }
      base = parents[1];
      rootCommit = base === undefined;
    }

    const records = parseNameStatus(await this.#run(
      root,
      rootCommit
        ? [
            "show",
            "--format=",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            head,
            "--",
          ]
        : [
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            base!,
            head,
            "--",
          ],
      signal,
    ));
    const safeRecords = records.filter((record) =>
      record.paths.every((candidate) => !isProtectedProjectRelativePath(candidate)));
    const filteredCount = records.length - safeRecords.length;
    const notices: string[] = [];
    if (filteredCount > 0) {
      notices.push(
        `[Council：已按安全策略隐去 ${String(filteredCount)} 个敏感路径的完整 diff]`,
      );
    }
    if (safeRecords.length === 0) {
      return [...notices, "没有可公开的文件变更。"].join("\n");
    }
    if (safeRecords.length > this.#config.gitDiffMaxFiles) {
      return [
        ...notices,
        `[Council：安全变更文件数 ${String(safeRecords.length)} 超过 ${
          String(this.#config.gitDiffMaxFiles)
        }，仅返回有界状态摘要；未提供残缺 patch]`,
        statusSummary(safeRecords, this.#config.gitDiffMaxFiles),
      ].join("\n");
    }

    const safePaths = uniquePaths(safeRecords);
    const patchArgs = rootCommit
      ? [
          "show",
          "--format=",
          "--find-renames",
          "--no-ext-diff",
          "--no-textconv",
          head,
          "--",
          ...safePaths,
        ]
      : [
          "diff",
          "--find-renames",
          "--no-ext-diff",
          "--no-textconv",
          base!,
          head,
          "--",
          ...safePaths,
        ];
    let patch: string;
    try {
      patch = await this.#run(root, patchArgs, signal);
    } catch (error) {
      if (!(error instanceof ReadOnlyGitDiffError)
        || error.diagnosticCode !== "git_output_limit") {
        throw error;
      }
      return [
        ...notices,
        "[Council：完整 patch 超过输出预算，已返回安全路径的统计摘要]",
        await this.#stat(root, rootCommit, base, head, safePaths, signal),
      ].join("\n");
    }
    if (exceedsPatchBudget(
      patch,
      this.#config.gitDiffMaxLines,
      this.#config.gitDiffMaxHunksPerFile,
    )) {
      return [
        ...notices,
        "[Council：完整 patch 超过行数或单文件 hunk 预算，已返回安全路径的统计摘要]",
        await this.#stat(root, rootCommit, base, head, safePaths, signal),
      ].join("\n");
    }
    return [...notices, patch.trim() || "没有文本差异。"].join("\n");
  }

  async #resolveCommit(
    root: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const output = (await this.#run(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      signal,
    )).trim();
    if (!OID_PATTERN.test(output)) {
      throw new ReadOnlyGitDiffError(
        "Git ref 未解析为 commit。",
        "invalid_git_ref",
      );
    }
    return output;
  }

  async #stat(
    root: string,
    rootCommit: boolean,
    base: string | undefined,
    head: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.#run(
      root,
      rootCommit
        ? [
            "show",
            "--format=",
            "--stat",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            head,
            "--",
            ...paths,
          ]
        : [
            "diff",
            "--stat",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            base!,
            head,
            "--",
            ...paths,
          ],
      signal,
    )).trim();
  }

  async #run(
    root: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await runBoundedProcess({
        command: this.#config.gitCommand,
        args: [
          "--no-pager",
          "--literal-pathspecs",
          "-c",
          "core.pager=cat",
          "-c",
          "core.quotepath=false",
          ...args,
        ],
        input: "",
        cwd: root,
        env: sanitizedGitEnvironment(),
        ...(signal ? { signal } : {}),
        timeoutMs: this.#config.gitDiffTimeoutMs,
        killGraceMs: this.#config.gitDiffKillGraceMs,
        maxOutputChars: this.#config.gitDiffMaxOutputChars,
        messages: {
          aborted: "Council Git diff 已取消。",
          timeout: "Council Git diff 超时。",
          outputLimit: OUTPUT_LIMIT_MESSAGE,
          commandNotFound: "本机未找到 Git 可执行程序。",
          spawnFailed: "Council 无法启动 Git。",
        },
      });
      if (result.exitCode !== 0) {
        throw new ReadOnlyGitDiffError(
          "Git 无法读取指定 commit/ref。",
          "git_failed",
        );
      }
      return result.stdout;
    } catch (error) {
      if (error instanceof ReadOnlyGitDiffError || error instanceof DOMException) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (error instanceof Error && error.message === OUTPUT_LIMIT_MESSAGE) {
        throw new ReadOnlyGitDiffError(
          OUTPUT_LIMIT_MESSAGE,
          "git_output_limit",
        );
      }
      throw new ReadOnlyGitDiffError(
        error instanceof Error ? error.message : "Council Git diff 失败。",
        error instanceof Error && error.message.includes("超时")
          ? "git_timeout"
          : "git_failed",
      );
    }
  }
}
