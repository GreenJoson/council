/**
 * @input  依赖：关联提交协议编解码与 MessageCard 服务端渲染
 * @output 验证：多仓库 SHA 校验、协议尾块隐藏及可读提交证据卡
 * @pos    Composer 关联提交不会退化为不可识别普通文本的前端回归证据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageCard } from "../src/components/MessageCard";
import {
  buildCommitAssociationContent,
  extractCommitAssociation,
  validateCommitAssociationTargets,
} from "../src/data/commit-association";
import type { CouncilMessage } from "../src/types/council";

const TARGETS = [
  { repository: ".", commit: "F0FE5C5" },
  { repository: "../admin", commit: "352BFA5A1" },
];

describe("关联提交", () => {
  it("把多个仓库提交编码成修复互审协议并无损解码", () => {
    const content = buildCommitAssociationContent("权限修复已经提交。", TARGETS);
    const association = extractCommitAssociation(content);

    expect(content).toContain("```council-fix");
    expect(association).toEqual({
      body: "权限修复已经提交。",
      summary: "权限修复已经提交。",
      targets: [
        { repository: ".", commit: "f0fe5c5" },
        { repository: "../admin", commit: "352bfa5a1" },
      ],
    });
  });

  it("拒绝分支名、过短 SHA、越界仓库与重复仓库", () => {
    expect(validateCommitAssociationTargets([{ repository: ".", commit: "main" }]))
      .toContain("7–40");
    expect(validateCommitAssociationTargets([{ repository: ".", commit: "abc123" }]))
      .toContain("7–40");
    expect(validateCommitAssociationTargets([{ repository: "../../private", commit: "abcdef1" }]))
      .toContain("相对路径");
    expect(validateCommitAssociationTargets([
      { repository: ".", commit: "abcdef1" },
      { repository: ".", commit: "abcdef2" },
    ])).toContain("已经关联");
  });

  it("消息卡隐藏协议 JSON，只展示仓库与 commit", () => {
    const message: CouncilMessage = {
      id: "message_commit",
      author: "codex",
      actorSnapshot: {
        schemaVersion: 1,
        actorId: "codex",
        slug: "codex",
        displayName: "Codex",
        shortName: "CX",
        role: "实现者",
      },
      kind: "note",
      title: "补充记录",
      content: buildCommitAssociationContent("实现与测试已经完成。", TARGETS),
      createdLabel: "刚刚",
    };

    const html = renderToStaticMarkup(
      <MessageCard message={message} index={0} onQuote={() => undefined} />,
    );

    expect(html).toContain("关联提交");
    expect(html).toContain("当前仓库");
    expect(html).toContain("../admin");
    expect(html).toContain("f0fe5c5");
    expect(html).not.toContain("council-fix");
    expect(html).not.toContain("&quot;targets&quot;");
  });
});
