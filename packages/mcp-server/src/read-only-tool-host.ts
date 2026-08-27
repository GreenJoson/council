/**
 * @input  依赖：项目根目录、本轮授权仓库标签、CouncilConfig 与结构化 Tool Call
 * @output 导出：项目内读文件/搜索和已授权多仓库 commit diff 的有界只读 ToolHost
 * @pos    Council-owned ToolLoop 的本机沙箱；不执行 Shell、不写文件、不读取凭据文件
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import type {
  ModelToolCall,
  ModelToolDefinition,
} from "./openai-compatible-model-client.js";
import {
  COUNCIL_GIT_DIFF_TOOL_NAME,
  normalizeGitRepositoryLabel,
  ReadOnlyGitDiff,
  ReadOnlyGitDiffError,
  resolveAuthorizedGitRepositoryRoot,
  type GitCommitGrant,
  type GitDiffRequest,
} from "./read-only-git-diff.js";
import {
  IGNORED_PROJECT_DIRECTORIES,
  isProtectedProjectRelativePath,
} from "./project-path-policy.js";
import type { CouncilConfig } from "./types.js";

const TOOL_NAMES = {
  read: "council_read_text_file",
  list: "council_list_directory",
  search: "council_search_text",
  gitDiff: COUNCIL_GIT_DIFF_TOOL_NAME,
} as const;

export function readOnlyToolCapability(
  toolName: string,
): "repository_read" | "git_diff" | undefined {
  if (toolName === TOOL_NAMES.gitDiff) {
    return "git_diff";
  }
  return toolName === TOOL_NAMES.read
    || toolName === TOOL_NAMES.list
    || toolName === TOOL_NAMES.search
    ? "repository_read"
    : undefined;
}

export class ReadOnlyToolHostError extends Error {
  constructor(
    message: string,
    readonly diagnosticCode: string,
  ) {
    super(message);
    this.name = "ReadOnlyToolHostError";
  }
}

export interface ReadOnlyToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
}

interface ToolArguments {
  path?: unknown;
  line?: unknown;
  limit?: unknown;
  query?: unknown;
  repository?: unknown;
  commit?: unknown;
  base?: unknown;
  head?: unknown;
}

interface RepositoryAccess {
  root?: string;
  error?: ReadOnlyToolHostError;
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function parseArguments(call: ModelToolCall): ToolArguments {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments || "{}");
  } catch {
    throw new ReadOnlyToolHostError(
      "工具参数不是有效 JSON。",
      "invalid_tool_arguments",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReadOnlyToolHostError(
      "工具参数必须是对象。",
      "invalid_tool_arguments",
    );
  }
  return value as ToolArguments;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ReadOnlyToolHostError(
      "工具行号或数量必须是正整数。",
      "invalid_tool_arguments",
    );
  }
  return Math.min(Number(value), maximum);
}

function requiredPath(value: unknown, fallback?: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new ReadOnlyToolHostError(
      "工具 path 必须是非空字符串。",
      "invalid_tool_arguments",
    );
  }
  return candidate.trim();
}

function requiredQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ReadOnlyToolHostError(
      "搜索 query 必须是非空字符串。",
      "invalid_tool_arguments",
    );
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new ReadOnlyToolHostError(
      `Git diff 的 ${name} 必须是非空字符串。`,
      "invalid_tool_arguments",
    );
  }
  return value.trim();
}

function optionalRepository(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new ReadOnlyToolHostError(
      "工具 repository 必须是非空字符串。",
      "invalid_tool_arguments",
    );
  }
  try {
    return normalizeGitRepositoryLabel(value);
  } catch (error) {
    if (error instanceof ReadOnlyGitDiffError) {
      throw new ReadOnlyToolHostError(error.message, error.diagnosticCode);
    }
    throw error;
  }
}

function gitDiffRequest(args: ToolArguments): GitDiffRequest {
  const unexpected = Object.keys(args).filter((key) =>
    key !== "repository" && key !== "commit" && key !== "base" && key !== "head");
  if (unexpected.length > 0) {
    throw new ReadOnlyToolHostError(
      "Git diff 包含未允许的参数。",
      "invalid_tool_arguments",
    );
  }
  const repository = optionalString(args.repository, "repository");
  const commit = optionalString(args.commit, "commit");
  const base = optionalString(args.base, "base");
  const head = optionalString(args.head, "head");
  return {
    ...(repository ? { repository } : {}),
    ...(commit ? { commit } : {}),
    ...(base ? { base } : {}),
    ...(head ? { head } : {}),
  };
}

export class ReadOnlyToolHost {
  readonly definitions: readonly ModelToolDefinition[] = [
    {
      type: "function",
      function: {
        name: TOOL_NAMES.read,
        description:
          "读取当前项目或本轮已授权关联仓库内的普通文本文件。关联仓库优先传 repository；凭据、构建产物和未授权路径会被拒绝。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            repository: {
              type: "string",
              description: "本轮已授权的仓库标签；当前仓库默认使用 .。",
            },
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1 },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: TOOL_NAMES.list,
        description: "列出当前项目或本轮已授权关联仓库内一个目录的直接子项，不递归。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            repository: {
              type: "string",
              description: "本轮已授权的仓库标签；当前仓库默认使用 .。",
            },
            path: { type: "string", description: "仓库相对目录，默认仓库根目录。" },
            limit: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: TOOL_NAMES.search,
        description:
          "在当前项目或本轮已授权关联仓库的普通文本文件中按字面量搜索，返回文件、行号和有界片段。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            repository: {
              type: "string",
              description: "本轮已授权的仓库标签；当前仓库默认使用 .。",
            },
            query: { type: "string" },
            path: { type: "string", description: "仓库相对目录，默认仓库根目录。" },
            limit: { type: "integer", minimum: 1 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: TOOL_NAMES.gitDiff,
        description:
          "读取本轮已授权仓库中已提交 commit 或 base/head 范围的 Git diff。不会读取未提交工作区；敏感路径会被过滤，超限会返回明确摘要。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            repository: {
              type: "string",
              description: "本轮议题已授权的仓库标签；当前仓库默认使用 .。",
            },
            commit: {
              type: "string",
              description: "单个 commit/ref；Council 比较它与第一父提交。",
            },
            base: { type: "string", description: "范围起点 commit/ref。" },
            head: { type: "string", description: "范围终点 commit/ref。" },
          },
          oneOf: [
            { required: ["commit"] },
            { required: ["base", "head"] },
          ],
        },
      },
    },
  ];

  readonly #root: string;
  readonly #repositories: ReadonlyMap<string, RepositoryAccess>;
  readonly #maxResultChars: number;
  readonly #maxFileBytes: number;
  readonly #maxScanFiles: number;
  readonly #maxItems: number;
  readonly #gitDiff: ReadOnlyGitDiff;

  private constructor(
    root: string,
    repositories: ReadonlyMap<string, RepositoryAccess>,
    config: CouncilConfig,
    gitDiff: ReadOnlyGitDiff,
  ) {
    this.#root = root;
    this.#repositories = repositories;
    this.#maxResultChars = config.maxOutputChars;
    this.#maxFileBytes = config.toolLoopMaxFileBytes;
    this.#maxScanFiles = config.toolLoopMaxScanFiles;
    this.#maxItems = config.defaultMessageLimit;
    this.#gitDiff = gitDiff;
  }

  static async create(
    projectPath: string,
    config: CouncilConfig,
    gitCommitTargets: readonly GitCommitGrant[] = [],
  ): Promise<ReadOnlyToolHost> {
    const root = await realpath(projectPath);
    const info = await lstat(root);
    if (!info.isDirectory()) {
      throw new ReadOnlyToolHostError(
        "当前项目路径不是目录。",
        "invalid_project_path",
      );
    }
    const repositories = new Map<string, RepositoryAccess>([[".", { root }]]);
    for (const repository of new Set(
      gitCommitTargets.map((target) => normalizeGitRepositoryLabel(target.repository)),
    )) {
      if (repository === ".") {
        continue;
      }
      try {
        repositories.set(repository, {
          root: await resolveAuthorizedGitRepositoryRoot(root, repository),
        });
      } catch (error) {
        repositories.set(repository, {
          error: error instanceof ReadOnlyGitDiffError
            ? new ReadOnlyToolHostError(error.message, error.diagnosticCode)
            : new ReadOnlyToolHostError(
                `关联仓库 ${repository} 无法读取。`,
                "repository_unavailable",
              ),
        });
      }
    }
    return new ReadOnlyToolHost(
      root,
      repositories,
      config,
      await ReadOnlyGitDiff.create(root, config, gitCommitTargets),
    );
  }

  async execute(
    call: ModelToolCall,
    signal?: AbortSignal,
  ): Promise<ReadOnlyToolResult> {
    const args = parseArguments(call);
    let content: string;
    switch (call.name) {
      case TOOL_NAMES.read:
        content = await this.#readTextFile(args);
        break;
      case TOOL_NAMES.list:
        content = await this.#listDirectory(args);
        break;
      case TOOL_NAMES.search:
        content = await this.#searchText(args);
        break;
      case TOOL_NAMES.gitDiff:
        content = await this.#gitDiff.generate(
          gitDiffRequest(args),
          signal,
        );
        break;
      default:
        throw new ReadOnlyToolHostError(
          "模型请求了未注册工具。",
          "unknown_tool",
        );
    }
    return {
      toolCallId: call.id,
      toolName: call.name,
      content: this.#bounded(content),
    };
  }

  async #resolve(
    args: ToolArguments,
    requestedPath: string,
  ): Promise<{ absolute: string; relative: string; repository: string }> {
    const requestedRepository = optionalRepository(args.repository);
    const selected = requestedRepository
      ? this.#repositories.get(requestedRepository)
      : undefined;
    if (requestedRepository && !selected) {
      throw new ReadOnlyToolHostError(
        `仓库 ${requestedRepository} 未被本轮议题授权。`,
        "repository_not_authorized",
      );
    }
    if (selected?.error || (requestedRepository && !selected?.root)) {
      throw selected?.error ?? new ReadOnlyToolHostError(
        `关联仓库 ${requestedRepository} 无法读取。`,
        "repository_unavailable",
      );
    }
    const baseRoot = selected?.root ?? this.#root;
    const candidate = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(baseRoot, requestedPath);
    const absolute = await realpath(candidate);
    const matched = requestedRepository
      ? { repository: requestedRepository, access: selected! }
      : [...this.#repositories.entries()]
          .filter((entry): entry is [string, RepositoryAccess & { root: string }] =>
            Boolean(entry[1].root) && withinRoot(entry[1].root!, absolute))
          .sort((left, right) => right[1].root.length - left[1].root.length)
          .map(([repository, access]) => ({ repository, access }))[0];
    if (!matched?.access.root || !withinRoot(matched.access.root, absolute)) {
      throw new ReadOnlyToolHostError(
        "工具路径超出当前项目与本轮已授权仓库。",
        "path_outside_project",
      );
    }
    const relative = path.relative(matched.access.root, absolute);
    if (isProtectedProjectRelativePath(relative)) {
      throw new ReadOnlyToolHostError(
        "安全策略禁止读取该路径。",
        "protected_path",
      );
    }
    return {
      absolute,
      relative: relative || ".",
      repository: matched.repository,
    };
  }

  async #readTextFile(args: ToolArguments): Promise<string> {
    const resolved = await this.#resolve(args, requiredPath(args.path));
    const info = await lstat(resolved.absolute);
    if (!info.isFile() || info.size > this.#maxFileBytes) {
      throw new ReadOnlyToolHostError(
        "目标不是普通文本文件或超过文件大小上限。",
        "file_not_readable",
      );
    }
    const handle = await open(resolved.absolute, "r");
    let content: string;
    try {
      content = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    if (content.includes("\0")) {
      throw new ReadOnlyToolHostError(
        "目标不是普通文本文件。",
        "file_not_text",
      );
    }
    const startLine = optionalPositiveInteger(
      args.line,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = optionalPositiveInteger(
      args.limit,
      this.#maxItems,
      this.#maxItems,
    );
    return content
      .split(/\r?\n/u)
      .slice(startLine - 1, startLine - 1 + limit)
      .map((line, index) => `${String(startLine + index)}: ${line}`)
      .join("\n");
  }

  async #listDirectory(args: ToolArguments): Promise<string> {
    const resolved = await this.#resolve(args, requiredPath(args.path, "."));
    const info = await lstat(resolved.absolute);
    if (!info.isDirectory()) {
      throw new ReadOnlyToolHostError(
        "目标不是目录。",
        "directory_not_readable",
      );
    }
    const limit = optionalPositiveInteger(
      args.limit,
      this.#maxItems,
      this.#maxItems,
    );
    const entries = (await readdir(resolved.absolute, { withFileTypes: true }))
      .filter((entry) => !isProtectedProjectRelativePath(
        path.join(resolved.relative, entry.name),
      ))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
      }));
    return JSON.stringify({
      repository: resolved.repository,
      path: resolved.relative,
      entries,
    });
  }

  async #searchText(args: ToolArguments): Promise<string> {
    const query = requiredQuery(args.query);
    const resolved = await this.#resolve(args, requiredPath(args.path, "."));
    const info = await lstat(resolved.absolute);
    if (!info.isDirectory()) {
      throw new ReadOnlyToolHostError(
        "搜索目标不是目录。",
        "directory_not_readable",
      );
    }
    const limit = optionalPositiveInteger(
      args.limit,
      this.#maxItems,
      this.#maxItems,
    );
    const normalizedQuery = query.toLowerCase();
    const results: Array<{ path: string; line: number; text: string }> = [];
    const pending = [resolved.absolute];
    let scannedFiles = 0;

    while (pending.length > 0 && results.length < limit) {
      const directory = pending.pop();
      if (!directory) {
        break;
      }
      const entries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (results.length >= limit) {
          break;
        }
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(
          this.#repositories.get(resolved.repository)?.root ?? this.#root,
          absolute,
        );
        if (
          isProtectedProjectRelativePath(relative)
          || entry.isSymbolicLink()
          || (
            entry.isDirectory()
            && IGNORED_PROJECT_DIRECTORIES.has(entry.name.toLowerCase())
          )
        ) {
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        scannedFiles += 1;
        if (scannedFiles > this.#maxScanFiles) {
          throw new ReadOnlyToolHostError(
            "项目搜索达到文件扫描上限，请缩小 path。",
            "scan_limit",
          );
        }
        const fileInfo = await lstat(absolute);
        if (fileInfo.size > this.#maxFileBytes) {
          continue;
        }
        const handle = await open(absolute, "r");
        let content: string;
        try {
          content = await handle.readFile({ encoding: "utf8" });
        } finally {
          await handle.close();
        }
        if (content.includes("\0")) {
          continue;
        }
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length && results.length < limit; index += 1) {
          const line = lines[index] ?? "";
          if (line.toLowerCase().includes(normalizedQuery)) {
            results.push({
              path: relative,
              line: index + 1,
              text: line.slice(0, this.#maxResultChars),
            });
          }
        }
      }
    }
    return JSON.stringify({
      repository: resolved.repository,
      query,
      scannedFiles,
      results,
    });
  }

  #bounded(content: string): string {
    if (content.length <= this.#maxResultChars) {
      return content;
    }
    return `${content.slice(0, this.#maxResultChars)}\n[Council：工具结果已达到上限]`;
  }
}
