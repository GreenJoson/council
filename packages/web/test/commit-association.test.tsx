/**
 * @input  依赖：批量 SHA 草稿、关联提交协议编解码与 MessageCard 服务端渲染
 * @output 验证：多分隔符展开、同仓库多轮 SHA、多仓库校验、协议尾块隐藏及证据卡
 * @pos    Composer 关联提交不会退化为不可识别普通文本的前端回归证据
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageCard } from "../src/components/MessageCard";
import {
  buildCommitAssociationContent,
  expandCommitAssociationDrafts,
  extractCommitAssociation,
  validateCommitAssociationDrafts,
  validateCommitAssociationTargets,
} from "../src/data/commit-association";
import type { CouncilMessage } from "../src/types/council";

const TARGETS = [
  { repository: ".", commit: "F0FE5C5" },
  { repository: ".", commit: "4D7E416" },
  { repository: "../admin", commit: "352BFA5A1" },
];

describe("关联提交", () => {
  it("把逗号、中文标点、空格和换行分隔的 SHA 展开为独立提交", () => {
    const drafts = [
      { repository: ".", commits: "F0FE5C5, 4D7E416，c9e62da\n3a1ab31" },
      { repository: "../admin", commits: "352BFA5A1、47C67FA；abcdef1" },
    ];

    expect(validateCommitAssociationDrafts(drafts)).toBeUndefined();
    expect(expandCommitAssociationDrafts(drafts)).toEqual([
      { repository: ".", commit: "F0FE5C5" },
      { repository: ".", commit: "4D7E416" },
      { repository: ".", commit: "c9e62da" },
      { repository: ".", commit: "3a1ab31" },
      { repository: "../admin", commit: "352BFA5A1" },
      { repository: "../admin", commit: "47C67FA" },
      { repository: "../admin", commit: "abcdef1" },
    ]);
  });

  it("批量输入按提交数限制上限，并拒绝空列表和重复 SHA", () => {
    expect(validateCommitAssociationDrafts([{ repository: ".", commits: " , ， \n" }]))
      .toContain("至少填写一个");
    expect(validateCommitAssociationDrafts([{
      repository: ".",
      commits: "abcdef1 abcdef2 abcdef3 abcdef4 abcdef5 abcdef6 abcdef7 abcdef8 abcdef9",
    }])).toContain("最多关联 8 个");
    expect(validateCommitAssociationDrafts([{
      repository: ".",
      commits: "ABCDEF1, abcdef1",
    }])).toContain("完全重复");
  });

  it("把同仓库多轮提交及跨仓库提交编码成修复互审协议并无损解码", () => {
    const content = buildCommitAssociationContent("权限修复已经提交。", TARGETS);
    const association = extractCommitAssociation(content);

    expect(content).toContain("```council-fix");
    expect(association).toEqual({
      body: "权限修复已经提交。",
      summary: "权限修复已经提交。",
      targets: [
        { repository: ".", commit: "f0fe5c5" },
        { repository: ".", commit: "4d7e416" },
        { repository: "../admin", commit: "352bfa5a1" },
      ],
    });
  });

  it("允许同仓库不同 SHA，拒绝分支名、过短 SHA、越界仓库与完全重复项", () => {
    expect(validateCommitAssociationTargets([{ repository: ".", commit: "main" }]))
      .toContain("7–40");
    expect(validateCommitAssociationTargets([{ repository: ".", commit: "abc123" }]))
      .toContain("7–40");
    expect(validateCommitAssociationTargets([{ repository: "../../private", commit: "abcdef1" }]))
      .toContain("相对路径");
    expect(validateCommitAssociationTargets([
      { repository: ".", commit: "abcdef1" },
      { repository: ".", commit: "abcdef2" },
    ])).toBeUndefined();
    expect(validateCommitAssociationTargets([
      { repository: ".", commit: "ABCDEF1" },
      { repository: ".", commit: "abcdef1" },
    ])).toContain("完全重复");
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
    expect(html).toContain("3 个提交");
    expect(html).not.toContain("3 个仓库");
    expect(html).toContain("当前项目");
    expect(html).toContain("../admin");
    expect(html).toContain("f0fe5c5");
    expect(html).not.toContain("council-fix");
    expect(html).not.toContain("&quot;targets&quot;");
  });
});
