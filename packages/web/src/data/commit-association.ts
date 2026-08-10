/**
 * @input  依赖：Composer 输入的仓库相对路径与不可变 commit SHA；同仓库可关联多轮不同提交
 * @output 导出：关联提交校验、council-fix 协议编码与消息展示解码
 * @pos    Web 消息附件与 Council 修复互审协议之间的唯一转换边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const MAX_COMMIT_ASSOCIATIONS = 8;

export interface CommitAssociationTarget {
  repository: string;
  commit: string;
}

export interface CommitAssociation {
  body: string;
  summary: string;
  targets: CommitAssociationTarget[];
}

const COMMIT_REF_PATTERN = /^[0-9a-f]{7,40}$/u;
const REPOSITORY_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9._-]+`;
const REPOSITORY_REF_PATTERN = new RegExp(
  String.raw`^(?:\.|(?:\.\./)?${REPOSITORY_SEGMENT}(?:/${REPOSITORY_SEGMENT})*)$`,
  "u",
);
const FIX_TRAILER_PATTERN = /(?:^|\n)```council-fix[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*(?:\r?\n)?$/u;

function normalizeTarget(target: CommitAssociationTarget): CommitAssociationTarget | undefined {
  const repository = target.repository.trim();
  const commit = target.commit.trim().toLowerCase();
  if (!REPOSITORY_REF_PATTERN.test(repository) || !COMMIT_REF_PATTERN.test(commit)) {
    return undefined;
  }
  return { repository, commit };
}

export function validateCommitAssociationTargets(
  targets: readonly CommitAssociationTarget[],
): string | undefined {
  if (targets.length === 0) {
    return undefined;
  }
  if (targets.length > MAX_COMMIT_ASSOCIATIONS) {
    return `一次最多关联 ${String(MAX_COMMIT_ASSOCIATIONS)} 个提交`;
  }
  const targetKeys = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const repository = target.repository.trim();
    const commit = target.commit.trim().toLowerCase();
    if (!REPOSITORY_REF_PATTERN.test(repository)) {
      return `第 ${String(index + 1)} 项仓库必须是 .、仓库内相对路径或一层同级仓库`;
    }
    if (!COMMIT_REF_PATTERN.test(commit)) {
      return `第 ${String(index + 1)} 项 commit 必须是 7–40 位十六进制 SHA`;
    }
    const targetKey = `${repository}\u0000${commit}`;
    if (targetKeys.has(targetKey)) {
      return `第 ${String(index + 1)} 项与前面的仓库和 commit 完全重复`;
    }
    targetKeys.add(targetKey);
  }
  return undefined;
}

export function buildCommitAssociationContent(
  content: string,
  targets: readonly CommitAssociationTarget[],
): string {
  const error = validateCommitAssociationTargets(targets);
  if (error || targets.length === 0) {
    throw new Error(error ?? "至少需要一个关联提交");
  }
  const normalizedTargets = targets.map((target) => normalizeTarget(target)!);
  const body = content.trim() || "补充本次修复对应的提交记录。";
  const summary = body.replace(/\s+/gu, " ").slice(0, 400);
  const trailer = JSON.stringify({ targets: normalizedTargets, summary });
  return `${body}\n\n\`\`\`council-fix\n${trailer}\n\`\`\``;
}

export function extractCommitAssociation(content: string): CommitAssociation | undefined {
  const match = FIX_TRAILER_PATTERN.exec(content);
  if (!match?.[1]) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const rawTargets = Array.isArray(record.targets)
    ? record.targets
    : [{ repository: ".", commit: record.commit }];
  if (!summary || rawTargets.length === 0 || rawTargets.length > MAX_COMMIT_ASSOCIATIONS) {
    return undefined;
  }
  const targets: CommitAssociationTarget[] = [];
  for (const rawTarget of rawTargets) {
    if (typeof rawTarget !== "object" || rawTarget === null || Array.isArray(rawTarget)) {
      return undefined;
    }
    const target = rawTarget as Record<string, unknown>;
    if (typeof target.repository !== "string" || typeof target.commit !== "string") {
      return undefined;
    }
    const normalized = normalizeTarget({ repository: target.repository, commit: target.commit });
    if (!normalized) {
      return undefined;
    }
    targets.push(normalized);
  }
  if (validateCommitAssociationTargets(targets)) {
    return undefined;
  }
  const blockStart = match.index + (match[0].startsWith("\n") ? 1 : 0);
  return {
    body: content.slice(0, blockStart).trim(),
    summary,
    targets,
  };
}
