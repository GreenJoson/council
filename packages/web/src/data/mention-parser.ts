/**
 * @input  依赖：OrchestrationAdapter 领域类型
 * @output 导出：ParsedMention、parseMention（召唤解析）、ActiveMentionQuery、
 *         findActiveMentionQuery（Composer 自动补全的实时光标态）、hasMentionAttempt
 *         （不依赖具体 adapter 解析的"看起来像召唤"探测）、LeadingMentionChip、
 *         extractLeadingMentionChip（消息流展示层的前导召唤芯片提取）
 * @pos    Composer 动态 Agent 召唤语法的唯一解析入口；纯函数，不发起任何请求，
 *         不关心 adapter.available——是否可用是调用方（Composer）结合实时 orchestration
 *         快照另行判断的业务问题，本文件只负责语法层面的识别
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { OrchestrationAdapter } from "../types/orchestration";

export interface ParsedMention {
  /** OrchestrationAdapter.id，直接可用于 CreateOrchestrationRunInput.plan[].adapterId */
  adapterId: string;
  /** 去掉命中的 @ 标记后的正文，已 trim；调用方应在为空时视为"没有可执行指令" */
  instruction: string;
}

export interface ActiveMentionQuery {
  /** 触发中的 '@' 字符在原始文本里的绝对下标，用于替换插入 */
  start: number;
  /** '@' 之后、光标之前已经输入的候选过滤词（不含 '@' 本身） */
  query: string;
}

export interface LeadingMentionChip {
  token: string;
  /** 去掉前导召唤标记（含其后一个空白）后剩余的正文，未 trim 结尾，仅 trimStart */
  remainder: string;
}

/**
 * 命中"行首或空白后的 @token"边界规则：token 只允许字母数字下划线短横线，
 * 避免把邮箱地址（如 foo@bar.com，@ 前是字母不是空白）或代码里的装饰器语法误判为召唤。
 */
const MENTION_PATTERN = /(^|\s)@([A-Za-z][\w-]*)/;

const KNOWN_MENTION_TOKENS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "deepseek",
  "kimi",
]);
const LEADING_MENTION_PATTERN = /^@([A-Za-z][\w-]*)(\s|$)/;

/** 每个 Provider 使用自己解析后的稳定 Actor 标识，禁止退化成共享占位名。 */
export function getMentionToken(adapter: OrchestrationAdapter): string {
  return adapter.actorId;
}

/**
 * 逐行标记"该行处于围栏代码块内部"（含起止围栏行本身）；规则与 selectors.ts 的
 * extractMermaidBlocks 保持一致（同字符、闭合长度 >= 起始长度），但这里不关心语言、
 * 也不提取代码块内容，只用于从召唤扫描里排除代码块，防止 ```@claude``` 这类示例代码
 * 被误当成真实召唤。
 */
function computeFenceFlags(lines: readonly string[]): boolean[] {
  const fenceStartPattern = /^ {0,3}(`{3,}|~{3,})/;
  const flags: boolean[] = new Array(lines.length).fill(false);
  let openFenceChar: "`" | "~" | null = null;
  let openFenceLength = 0;

  lines.forEach((line, index) => {
    if (openFenceChar === null) {
      const match = fenceStartPattern.exec(line);
      if (match) {
        const marker = match[1] ?? "";
        openFenceChar = marker.startsWith("~") ? "~" : "`";
        openFenceLength = marker.length;
        flags[index] = true;
      }
      return;
    }
    flags[index] = true;
    const closePattern = new RegExp(`^ {0,3}(?:\\${openFenceChar}){${String(openFenceLength)},}\\s*$`);
    if (closePattern.test(line)) {
      openFenceChar = null;
      openFenceLength = 0;
    }
  });

  return flags;
}

interface MentionMatch {
  lines: string[];
  lineIndex: number;
  token: string;
  matchStart: number;
  matchEnd: number;
}

/**
 * 找到文本里第一个"围栏外、边界合法"的 @token，不做 adapter 解析。
 * 多个 @ 只认这一个——找到即返回，不继续往后找"是否有另一个能解析成功的"。
 */
function findFirstMentionMatch(text: string): MentionMatch | null {
  const lines = text.split(/\r\n|\r|\n/);
  const fenceFlags = computeFenceFlags(lines);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (fenceFlags[lineIndex]) {
      continue;
    }
    const line = lines[lineIndex] ?? "";
    const match = MENTION_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    const matchStart = match.index;
    const matchEnd = matchStart + prefix.length + 1 + token.length;
    return { lines, lineIndex, token, matchStart, matchEnd };
  }
  return null;
}

/**
 * 解析 Composer 草稿里的 "@claude"/"@codex" 召唤标记。
 *
 * 规则（单测固化于 test/mention-parser.test.ts）：
 * - 无 @ → null。
 * - 命中的 token 大小写不敏感地匹配某个 adapter 的稳定召唤标识才算召唤成功；
 *   本机与远程 Provider 都使用独立 actorId。
 *   匹配不到任何 adapter（未知名，或当前不在 adapters 列表里，
 *   例如编排离线时列表只剩占位 adapter）→ null。是否"可用"（adapter.available）
 *   不在这里判断，调用方按需读取解析结果对应的 adapter.available 再决定是否阻止发布。
 * - 代码围栏（``` / ~~~）内部的 @ 不参与匹配。
 * - 文本中出现多个 @：只处理第一个围栏外的合法 @，其余原样保留在 instruction 里。
 * - 去掉命中的 "@token" 后，正文 trim 为空（例如整条消息只有 "@claude"）→ 视为没有
 *   可执行指令，返回 null，而不是把空指令传给 Agent。
 */
export function parseMention(
  text: string,
  adapters: readonly OrchestrationAdapter[],
): ParsedMention | null {
  const found = findFirstMentionMatch(text);
  if (!found) {
    return null;
  }
  const lowerToken = found.token.toLowerCase();
  const adapter = adapters.find((candidate) => getMentionToken(candidate).toLowerCase() === lowerToken);
  if (!adapter) {
    return null;
  }
  const { lines, lineIndex, matchStart, matchEnd } = found;
  const line = lines[lineIndex] ?? "";
  // 召唤标记正好在本行开头（matchStart === 0）时，token 之后紧跟的一个空格是
  // "标记与正文之间"的分隔符，应该随标记一起消费掉，否则该行剩余正文会带一个
  // 突兀的前导空格（尤其是标记单独占一行时，如围栏代码块之后另起一行 @codex ...）。
  // 标记出现在行中（前面已经有真实文本）时不做这个消费——此时 matchStart 之前保留的
  // 内容与 matchEnd 之后的空格恰好凑成一个正常的词间分隔，不需要、也不应该再多退一格。
  const sliceEnd = matchStart === 0 && line[matchEnd] === " " ? matchEnd + 1 : matchEnd;
  const nextLines = [...lines];
  nextLines[lineIndex] = line.slice(0, matchStart) + line.slice(sliceEnd);
  const instruction = nextLines.join("\n").trim();
  if (!instruction) {
    return null;
  }
  return { adapterId: adapter.id, instruction };
}

/**
 * 不依赖 adapters 解析、只探测"文本里是否存在一个语法上合法的召唤标记"。
 * 供 Composer 在编排离线（此时 adapters 只剩占位条目，parseMention 必然解析失败）
 * 场景下区分"用户压根没打算召唤"和"打算召唤但当前系统不可用"，从而给出诚实提示
 * 而不是把 @claude 悄悄当成普通文本发布出去。
 */
export function hasMentionAttempt(text: string): boolean {
  return findFirstMentionMatch(text) !== null;
}

/**
 * 定位光标所在处"正在输入中的" @ 候选：从光标向前找最近一个合法边界的 @，
 * 且 @ 与光标之间不能有空白（否则视为已经输入完毕，不再是"输入中"状态，
 * 与主流聊天工具的 @ 自动补全关闭时机一致）。用于 Composer 弹出/过滤候选列表。
 */
export function findActiveMentionQuery(content: string, cursorIndex: number): ActiveMentionQuery | null {
  const upToCursor = content.slice(0, Math.max(0, Math.min(cursorIndex, content.length)));
  const activePattern = /(?:^|\s)@([A-Za-z0-9_-]*)$/;
  const match = activePattern.exec(upToCursor);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  const start = match.index + match[0].length - query.length - 1;
  return { start, query };
}

/**
 * 消息流展示专用：只认正文最开头的已知召唤标识（大小写不敏感），用于 MessageCard
 * 把它渲染成召唤芯片、正文其余部分照常交给 MarkdownContent。故意只认绝对开头这一种
 * 位置（比 parseMention 更严格）：消息中间提到 "...@claude 的方案..." 属于正常讨论文本，
 * 不该被当成召唤强行抠出来做成芯片。识别的身份是产品里固定的已知集合
 * （claude/codex/deepseek/kimi），
 * 不依赖动态编排能力列表——展示历史消息时不应该因为当前 adapters 是否可用而改变外观。
 */
export function extractLeadingMentionChip(content: string): LeadingMentionChip | null {
  const match = LEADING_MENTION_PATTERN.exec(content);
  if (!match) {
    return null;
  }
  const token = (match[1] ?? "").toLowerCase();
  if (!KNOWN_MENTION_TOKENS.has(token)) {
    return null;
  }
  return {
    token,
    remainder: content.slice(match[0].length).trimStart(),
  };
}
