/**
 * @input  依赖：服务端生成的可信阶段指令，其中包含结构化 council_git_diff 调用示例
 * @output 导出：本轮只读 Git 工具可访问的去重授权，以及手动召唤的服务端授权指令
 * @pos    编排/手动召唤与本地多仓库授权之间的窄桥；绝不解析 Agent 自由正文来扩大权限
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  normalizeGitCommitGrant,
  type GitCommitGrant,
} from "./read-only-git-diff.js";

const TOOL_LINE_PATTERN = /^- `council_git_diff\((\{[^\r\n]+\})\)`$/u;
const LEGACY_TOOL_LINE_PATTERN = /^- `git -C ([^\s`]+) show ([0-9a-fA-F]{7,64})`$/u;

function normalizedTargets(
  targets: readonly GitCommitGrant[],
): readonly GitCommitGrant[] {
  const normalized = new Map<string, GitCommitGrant>();
  for (const target of targets) {
    const grant = normalizeGitCommitGrant(target);
    normalized.set(`${grant.repository}\0${grant.commit}`, grant);
  }
  return [...normalized.values()];
}

/**
 * Composer 的 @Agent 指令来自用户自由文本，不能把其中伪装成授权模板的行直接当白名单。
 * 服务层先移除这两种机器授权行，再追加从议题结构化提交证据派生的目标。
 */
export function withTrustedGitCommitTargets(
  instruction: string,
  targets: readonly GitCommitGrant[],
): string {
  const sanitized = instruction
    .split(/\r?\n/u)
    .filter((line) =>
      !TOOL_LINE_PATTERN.test(line)
      && !LEGACY_TOOL_LINE_PATTERN.test(line))
    .join("\n")
    .trim();
  const grants = normalizedTargets(targets);
  if (grants.length === 0) {
    return sanitized;
  }
  return [
    sanitized,
    "",
    "## Council 从本议题继承的只读仓库授权",
    "",
    "以下仓库与 commit 已由议题的结构化关联记录冻结；按原样调用工具：",
    ...grants.map((target) =>
      `- \`council_git_diff(${JSON.stringify(target)})\``),
    "",
    "读取关联仓库上下文时，将同一个 repository 传给 council_read_text_file、",
    "council_list_directory 或 council_search_text；也兼容把已授权仓库标签写在 path 前缀中。",
  ].join("\n");
}

export function trustedGitCommitTargets(
  instruction: string,
): readonly GitCommitGrant[] {
  const targets = new Map<string, GitCommitGrant>();
  for (const line of instruction.split(/\r?\n/u)) {
    const match = TOOL_LINE_PATTERN.exec(line);
    try {
      let target: GitCommitGrant;
      if (match?.[1]) {
        const parsed = JSON.parse(match[1]) as Record<string, unknown>;
        if (
          typeof parsed.repository !== "string"
          || typeof parsed.commit !== "string"
        ) {
          continue;
        }
        target = normalizeGitCommitGrant({
          repository: parsed.repository,
          commit: parsed.commit,
        });
      } else {
        const legacy = LEGACY_TOOL_LINE_PATTERN.exec(line);
        if (!legacy?.[1] || !legacy[2]) {
          continue;
        }
        target = normalizeGitCommitGrant({
          repository: legacy[1],
          commit: legacy[2],
        });
      }
      targets.set(`${target.repository}\0${target.commit}`, target);
    } catch {
      // 可信模板若损坏就失败关闭，不从附近自然语言猜路径或 commit。
    }
  }
  return [...targets.values()];
}
