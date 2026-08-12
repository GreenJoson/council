/**
 * @input  依赖：服务端生成的可信阶段指令，其中包含结构化 council_git_diff 调用示例
 * @output 导出：本轮只读 Git 工具可访问的去重仓库/精确 commit 授权
 * @pos    编排指令与本地多仓库授权之间的窄桥；绝不解析公开讨论正文来扩大权限
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  normalizeGitCommitGrant,
  type GitCommitGrant,
} from "./read-only-git-diff.js";

const TOOL_LINE_PATTERN = /^- `council_git_diff\((\{[^\r\n]+\})\)`$/u;
const LEGACY_TOOL_LINE_PATTERN = /^- `git -C ([^\s`]+) show ([0-9a-fA-F]{7,64})`$/u;

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
