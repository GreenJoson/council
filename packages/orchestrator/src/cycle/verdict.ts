/**
 * @input  依赖：Agent 提交的公开消息正文
 * @output 导出：立场/阻塞提问/修复 commit 引用的结构化尾块、议题证据解析与失败关闭判定
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
export const MAX_FIX_SUMMARY_CHARS = 400;
export const MAX_FIX_TARGETS = 8;
export const MAX_FIX_REPOSITORY_CHARS = 200;

export interface AgentVerdict {
  stance: VerdictStance;
  summary: string;
}

export interface AgentQuestion {
  question: string;
  rationale: string;
  options: readonly string[];
}

/**
 * 修复者对自己改动的自述。复审者据此读 diff——
 * 没有 commit 引用，"互审"就退化成互相看对方讲故事。
 */
export interface AgentFixTarget {
  /** 相对议题项目目录的仓库路径；当前仓库使用 `.`。 */
  repository: string;
  /** 已提交的 commit 引用；复审者用它 git show 出真实 diff。 */
  commit: string;
}

export interface AgentFixClaim {
  /** 一个议题可以同时审查当前仓库和明确列出的同级仓库。 */
  targets: readonly AgentFixTarget[];
  /** 这次改动想解决什么，一句话。 */
  summary: string;
}

export interface ParsedAgentReply {
  verdict: AgentVerdict;
  question?: AgentQuestion;
  fix?: AgentFixClaim;
  /**
   * 立场是从尾块读出来的还是兜底推定的。推定意味着 Agent 没按协议回复，
   * 调用方应当把它当作协议违例记录下来，而不是当作正常的 blocking。
   */
  verdictDeclared: boolean;
}

const VERDICT_FENCE = "council-verdict";
const QUESTION_FENCE = "council-question";
const FIX_FENCE = "council-fix";

/**
 * 只接受看起来像 git 对象名的引用：40 位全 sha，或 7 位以上的缩写。
 * 分支名和 tag 会随时间移动，复审者过几分钟读到的就不是被审的那份 diff。
 */
const COMMIT_REF_PATTERN = /^[0-9a-f]{7,40}$/u;
// 只允许当前仓库、仓库内相对路径或一层同级仓库；禁止绝对路径与连续向上穿越。
const REPOSITORY_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9._-]+`;
const REPOSITORY_REF_PATTERN = new RegExp(
  String.raw`^(?:\.|(?:\.\./)?${REPOSITORY_SEGMENT}(?:/${REPOSITORY_SEGMENT})*)$`,
  "u",
);

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
  for (const fence of [VERDICT_FENCE, QUESTION_FENCE, FIX_FENCE]) {
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

function parseFix(content: string): AgentFixClaim | undefined {
  const raw = extractFencedBlock(content, FIX_FENCE);
  if (raw === undefined) {
    return undefined;
  }
  const record = parseJsonObject(raw);
  if (!record) {
    return undefined;
  }
  const summary = boundedText(record.summary, MAX_FIX_SUMMARY_CHARS);
  if (summary === undefined) {
    return undefined;
  }
  const rawTargets = Array.isArray(record.targets)
    ? record.targets
    : [{ repository: ".", commit: record.commit }];
  if (rawTargets.length === 0 || rawTargets.length > MAX_FIX_TARGETS) {
    return undefined;
  }
  const targets: AgentFixTarget[] = [];
  for (const rawTarget of rawTargets) {
    if (typeof rawTarget !== "object" || rawTarget === null || Array.isArray(rawTarget)) {
      return undefined;
    }
    const target = rawTarget as Record<string, unknown>;
    const repository = boundedText(target.repository, MAX_FIX_REPOSITORY_CHARS);
    const commit = typeof target.commit === "string"
      ? target.commit.trim().toLowerCase()
      : "";
    if (
      repository === undefined
      || !REPOSITORY_REF_PATTERN.test(repository)
      || !COMMIT_REF_PATTERN.test(commit)
    ) {
      return undefined;
    }
    targets.push({ repository, commit });
  }
  const uniqueTargets = new Set(
    targets.map((target) => `${target.repository}\u0000${target.commit}`),
  );
  return uniqueTargets.size === targets.length ? { targets, summary } : undefined;
}

const COMMIT_MARKER_PATTERN = /(?:提交|commit(?:\s+sha)?)/iu;
const REPOSITORY_MARKER_PATTERN = /(?:仓库|repository|repo)/iu;
const CURRENT_REPOSITORY_PATTERN = /(?:当前(?:仓库|目录)|current\s+(?:repository|repo|directory)|this\s+(?:repository|repo))/iu;
const CODE_SPAN_PATTERN = /`([^`\r\n]+)`/gu;
const PLAIN_REPOSITORY_PATTERN = /(?:^|[：:,，\s])((?:\.\.\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|\.)(?=$|[，,；;\s])/u;

function evidenceLabel(line: string, markerIndex: number): string {
  return line
    .slice(0, markerIndex)
    .replace(/^[\s>*#\-+\d.()（）]+/u, "")
    .trim()
    .toLowerCase();
}

function repositoryFromEvidenceLine(line: string): string | undefined {
  if (CURRENT_REPOSITORY_PATTERN.test(line)) {
    return ".";
  }
  const marker = REPOSITORY_MARKER_PATTERN.exec(line);
  if (!marker) {
    return undefined;
  }
  for (const match of line.matchAll(CODE_SPAN_PATTERN)) {
    const candidate = match[1]?.trim();
    if (candidate && REPOSITORY_REF_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  const candidate = PLAIN_REPOSITORY_PATTERN.exec(
    line.slice(marker.index + marker[0].length),
  )?.[1];
  return candidate && REPOSITORY_REF_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function commitFromEvidenceLine(line: string): string | undefined {
  const marker = COMMIT_MARKER_PATTERN.exec(line);
  if (!marker) {
    return undefined;
  }
  const candidate = /`?([0-9a-f]{7,40})`?/iu.exec(
    line.slice(marker.index + marker[0].length),
  )?.[1]?.toLowerCase();
  return candidate && COMMIT_REF_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * 从议题正文与发起人的公开说明中提取“仓库 + commit”证据。
 *
 * 结构化 `council-fix` 优先；自然语言只接受显式“仓库/提交”标记和安全相对路径，
 * 不会把正文里任意十六进制字符串猜成 commit。相同仓库后出现的证据覆盖旧值，
 * 使发起人后续补充的新提交能替代议题创建时的旧引用。
 */
export function parseCommitTargetsFromEvidence(
  contents: readonly string[],
): readonly AgentFixTarget[] {
  for (const content of [...contents].reverse()) {
    const structured = parseFix(content);
    if (structured) {
      return structured.targets;
    }
  }

  const lines = contents.flatMap((content) => content.split(/\r?\n/u));
  const repositoriesByLabel = new Map<string, string>();
  for (const line of lines) {
    const marker = REPOSITORY_MARKER_PATTERN.exec(line);
    if (!marker) {
      continue;
    }
    const repository = repositoryFromEvidenceLine(line);
    if (!repository) {
      continue;
    }
    repositoriesByLabel.set(evidenceLabel(line, marker.index), repository);
  }

  const targetsByRepository = new Map<string, AgentFixTarget>();
  for (const line of lines) {
    const marker = COMMIT_MARKER_PATTERN.exec(line);
    if (!marker) {
      continue;
    }
    const commit = commitFromEvidenceLine(line);
    if (!commit) {
      continue;
    }
    const label = evidenceLabel(line, marker.index);
    const directRepository = repositoryFromEvidenceLine(line);
    const repository = directRepository
      ?? repositoriesByLabel.get(label)
      ?? (repositoriesByLabel.size === 1
        ? [...repositoriesByLabel.values()][0]
        : repositoriesByLabel.size === 0 ? "." : undefined);
    if (!repository || !REPOSITORY_REF_PATTERN.test(repository)) {
      continue;
    }
    targetsByRepository.set(repository, { repository, commit });
  }
  return [...targetsByRepository.values()].slice(0, MAX_FIX_TARGETS);
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
  const fix = parseFix(content);
  if (!verdict) {
    return {
      verdict: {
        stance: "blocking",
        summary: "未按协议给出 council-verdict 尾块，按最保守立场处理。",
      },
      ...(question ? { question } : {}),
      ...(fix ? { fix } : {}),
      verdictDeclared: false,
    };
  }
  return {
    verdict,
    ...(question ? { question } : {}),
    ...(fix ? { fix } : {}),
    verdictDeclared: true,
  };
}
