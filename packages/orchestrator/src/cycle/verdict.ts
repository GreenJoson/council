/**
 * @input  依赖：Agent 提交的公开消息正文
 * @output 导出：立场/阻塞提问的结构化尾块解析与失败关闭判定
 * @pos    自然语言回复与收敛状态机之间唯一的结构化边界；解析不了一律按最保守立场处理
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

/**
 * 立场分级——状态机只认这三种，用来判断"还要不要再吵一轮"：
 * - `agree`：没有异议，可以推进
 * - `non_blocking`：异议记录在案但不拦截收敛
 * - `blocking`：必须解决，否则不能进入 synthesis
 */
export const VERDICT_STANCES = ["agree", "non_blocking", "blocking"] as const;

export type VerdictStance = (typeof VERDICT_STANCES)[number];

export const MAX_VERDICT_SUMMARY_CHARS = 400;
export const MAX_QUESTION_CHARS = 1_000;
export const MAX_QUESTION_OPTIONS = 6;
export const MAX_QUESTION_OPTION_CHARS = 200;

export interface AgentVerdict {
  stance: VerdictStance;
  summary: string;
}

export interface AgentQuestion {
  question: string;
  rationale: string;
  options: readonly string[];
}

export interface ParsedAgentReply {
  verdict: AgentVerdict;
  question?: AgentQuestion;
  /**
   * 立场是从尾块读出来的还是兜底推定的。推定意味着 Agent 没按协议回复，
   * 调用方应当把它当作协议违例记录下来，而不是当作正常的 blocking。
   */
  verdictDeclared: boolean;
}

const VERDICT_FENCE = "council-verdict";
const QUESTION_FENCE = "council-question";

/**
 * 只接受行首围栏，避免正文里引用协议示例时被误判。
 * 用非贪婪匹配取最后一个块：Agent 复述完协议再给出真实结论时，后者才是它的立场。
 */
function extractFencedBlock(content: string, fence: string): string | undefined {
  const pattern = new RegExp(
    `^\`\`\`${fence}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?^\`\`\`[ \\t]*$`,
    "gmu",
  );
  let last: string | undefined;
  for (const match of content.matchAll(pattern)) {
    last = match[1];
  }
  return last;
}

/**
 * 去掉协议尾块，只留给人看的正文。
 *
 * 决策正文要和最终 synthesis 逐字一致，但立场/提问块是状态机的管线信号，
 * 留在决策里既没意义又会误导读者以为决策本身还有未决立场。
 */
export function stripProtocolTrailers(content: string): string {
  let stripped = content;
  for (const fence of [VERDICT_FENCE, QUESTION_FENCE]) {
    stripped = stripped.replace(
      new RegExp(
        `^\`\`\`${fence}[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n?^\`\`\`[ \\t]*$`,
        "gmu",
      ),
      "",
    );
  }
  return stripped.trim();
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) {
    return undefined;
  }
  return trimmed;
}

function parseVerdict(content: string): AgentVerdict | undefined {
  const raw = extractFencedBlock(content, VERDICT_FENCE);
  if (raw === undefined) {
    return undefined;
  }
  const record = parseJsonObject(raw);
  if (!record) {
    return undefined;
  }
  const stance = VERDICT_STANCES.find((candidate) => candidate === record.stance);
  if (!stance) {
    return undefined;
  }
  const summary = boundedText(record.summary, MAX_VERDICT_SUMMARY_CHARS);
  if (summary === undefined) {
    return undefined;
  }
  return { stance, summary };
}

function parseQuestion(content: string): AgentQuestion | undefined {
  const raw = extractFencedBlock(content, QUESTION_FENCE);
  if (raw === undefined) {
    return undefined;
  }
  const record = parseJsonObject(raw);
  if (!record) {
    return undefined;
  }
  const question = boundedText(record.question, MAX_QUESTION_CHARS);
  const rationale = boundedText(record.rationale, MAX_QUESTION_CHARS);
  if (question === undefined || rationale === undefined) {
    return undefined;
  }
  const rawOptions = record.options;
  if (!Array.isArray(rawOptions) || rawOptions.length > MAX_QUESTION_OPTIONS) {
    return undefined;
  }
  const options: string[] = [];
  for (const candidate of rawOptions) {
    const option = boundedText(candidate, MAX_QUESTION_OPTION_CHARS);
    if (option === undefined) {
      return undefined;
    }
    options.push(option);
  }
  return { question, rationale, options };
}

/**
 * 失败关闭：尾块缺失、JSON 非法、字段越界都推定为 `blocking`。
 *
 * 反过来推定 `agree` 会让一次格式错误直接把讨论推进到 synthesis——
 * 用一条没人真正认可的结论收尾，比多吵一轮的代价大得多。
 */
export function parseAgentReply(content: string): ParsedAgentReply {
  const verdict = parseVerdict(content);
  const question = parseQuestion(content);
  if (!verdict) {
    return {
      verdict: {
        stance: "blocking",
        summary: "未按协议给出 council-verdict 尾块，按最保守立场处理。",
      },
      ...(question ? { question } : {}),
      verdictDeclared: false,
    };
  }
  return {
    verdict,
    ...(question ? { question } : {}),
    verdictDeclared: true,
  };
}
