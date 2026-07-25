/**
 * @input  依赖：mention-parser 纯函数与 OrchestrationAdapter 领域类型
 * @output 导出：parseMention/hasMentionAttempt/findActiveMentionQuery/extractLeadingMentionChip 回归测试
 * @pos    动态 Agent 召唤语法边界规则的固化验证（无 @、未知名、代码围栏、多 @、
 *         空指令、大小写、可用性无关性、自动补全实时光标态、消息流展示前导芯片提取）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import {
  extractLeadingMentionChip,
  findActiveMentionQuery,
  hasMentionAttempt,
  parseMention,
} from "../src/data/mention-parser";
import type { OrchestrationAdapter } from "../src/types/orchestration";

const ADAPTERS: OrchestrationAdapter[] = [
  {
    id: "claude-code",
    actorId: "claude",
    mentionAlias: "claude",
    label: "Claude",
    available: true,
  },
  {
    id: "codex-shared",
    actorId: "codex",
    mentionAlias: "codex",
    label: "Codex",
    available: false,
    limitation: "当前仅自动共享回帖，不会从 Web 主动唤醒。",
  },
  {
    id: "agent-deepseek",
    actorId: "actor-deepseek",
    mentionAlias: "deepseek",
    label: "DeepSeek",
    available: true,
  },
  {
    id: "agent-kimi",
    actorId: "actor-kimi",
    mentionAlias: "kimi",
    label: "Kimi",
    available: true,
  },
];

describe("parseMention", () => {
  it("无 @ 时返回 null", () => {
    expect(parseMention("总结整理当前分歧", ADAPTERS)).toBeNull();
  });

  it("行首 @claude 解析出 adapterId 与去除标记后的正文", () => {
    expect(parseMention("@claude 总结整理当前分歧", ADAPTERS)).toEqual({
      adapterId: "claude-code",
      instruction: "总结整理当前分歧",
    });
  });

  it("@ 后紧跟未知名时返回 null（未知名不等同于换成随便处理）", () => {
    expect(parseMention("@bob 帮我看看", ADAPTERS)).toBeNull();
  });

  it("@ 对大小写不敏感，仍能命中对应 adapter", () => {
    expect(parseMention("@Claude 总结", ADAPTERS)?.adapterId).toBe("claude-code");
    expect(parseMention("@CODEX 总结", ADAPTERS)?.adapterId).toBe("codex-shared");
  });

  it("不判断 adapter.available——即使 codex 当前不可用，语法层仍能解析出来", () => {
    expect(parseMention("@codex 看看这个假设是否成立", ADAPTERS)).toEqual({
      adapterId: "codex-shared",
      instruction: "看看这个假设是否成立",
    });
  });

  it("远程 Provider 使用自己的独立 Actor 标识召唤", () => {
    expect(parseMention("@deepseek 复核并发风险", ADAPTERS)).toEqual({
      adapterId: "agent-deepseek",
      instruction: "复核并发风险",
    });
    expect(parseMention("@kimi 给出替代方案", ADAPTERS)?.adapterId).toBe("agent-kimi");
    expect(parseMention("@other 无歧义目标", ADAPTERS)).toBeNull();
  });

  it("代码围栏内的 @ 不误触发召唤", () => {
    const text = ["```", "@claude 这只是示例代码里的文本", "```"].join("\n");
    expect(parseMention(text, ADAPTERS)).toBeNull();
  });

  it("围栏内的 @ 被跳过，围栏外后续的合法 @ 仍能命中（围栏本身作为正文一部分保留）", () => {
    const text = ["```", "@claude 示例", "```", "@codex 真正的召唤"].join("\n");
    expect(parseMention(text, ADAPTERS)).toEqual({
      adapterId: "codex-shared",
      instruction: "```\n@claude 示例\n```\n真正的召唤",
    });
  });

  it("多个 @ 只认第一个，其余原样保留在正文里", () => {
    expect(parseMention("@claude 请综合一下，也提醒 @codex 稍后跟进", ADAPTERS)).toEqual({
      adapterId: "claude-code",
      instruction: "请综合一下，也提醒 @codex 稍后跟进",
    });
  });

  it("句中（空白之后）的 @ 同样能被识别为召唤边界", () => {
    expect(parseMention("辛苦 @claude 帮忙看一下", ADAPTERS)).toEqual({
      adapterId: "claude-code",
      instruction: "辛苦 帮忙看一下",
    });
  });

  it("邮箱式的 @（前面不是空白/行首）不触发召唤", () => {
    expect(parseMention("联系 foo@claude.internal 处理", ADAPTERS)).toBeNull();
  });

  it("去除标记后正文为空时返回 null，不把空指令交给 Agent", () => {
    expect(parseMention("@claude", ADAPTERS)).toBeNull();
    expect(parseMention("  @claude   ", ADAPTERS)).toBeNull();
  });
});

describe("hasMentionAttempt", () => {
  it("语法合法即返回 true，不要求 adapter 能解析成功", () => {
    expect(hasMentionAttempt("@claude 总结")).toBe(true);
    expect(hasMentionAttempt("@unknown-agent 总结")).toBe(true);
  });

  it("无 @ 或只在代码围栏内出现时返回 false", () => {
    expect(hasMentionAttempt("普通正文")).toBe(false);
    expect(hasMentionAttempt(["```", "@claude", "```"].join("\n"))).toBe(false);
  });
});

describe("findActiveMentionQuery", () => {
  it("光标紧跟在 @ 之后：query 为空", () => {
    expect(findActiveMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("正在输入候选过滤词时返回累计输入内容", () => {
    expect(findActiveMentionQuery("@cla", 4)).toEqual({ start: 0, query: "cla" });
    expect(findActiveMentionQuery("先看看 @cla", 8)).toEqual({ start: 4, query: "cla" });
  });

  it("@ 与光标之间出现空白后视为已输入完毕，不再是 active 状态", () => {
    expect(findActiveMentionQuery("@claude 总结", 8)).toBeNull();
  });

  it("光标不紧邻任何 @ 时返回 null", () => {
    expect(findActiveMentionQuery("没有召唤标记", 4)).toBeNull();
  });
});

describe("extractLeadingMentionChip", () => {
  it("正文最开头是已知 Agent 标识时提取芯片信息与剩余正文", () => {
    expect(extractLeadingMentionChip("@claude 总结整理当前分歧")).toEqual({
      token: "claude",
      remainder: "总结整理当前分歧",
    });
    expect(extractLeadingMentionChip("@CODEX 看看这个假设")).toEqual({
      token: "codex",
      remainder: "看看这个假设",
    });
    expect(extractLeadingMentionChip("@deepseek 复核边界")).toEqual({
      token: "deepseek",
      remainder: "复核边界",
    });
  });

  it("@ 不在最开头（句中提及）时不提取，交给正文正常渲染", () => {
    expect(extractLeadingMentionChip("辛苦 @claude 帮忙看一下")).toBeNull();
  });

  it("历史消息的动态 @alias 不依赖当前能力白名单", () => {
    expect(extractLeadingMentionChip("@future-agent 帮我看看")).toEqual({
      token: "future-agent",
      remainder: "帮我看看",
    });
  });

  it("只有召唤标记、没有其余正文时仍能提取（remainder 为空字符串）", () => {
    expect(extractLeadingMentionChip("@claude")).toEqual({ token: "claude", remainder: "" });
  });
});
