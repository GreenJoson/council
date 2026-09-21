/** @input 逐文件有界 Git diff、NUL 文件清单与审核预算；@output 逐文件审核材料及覆盖校验；@pos 大报告不能挤掉代码，缺失证据不能直接批准。 */
export interface DelegationReview {
  verdict: "approved" | "changes_requested" | "blocked";
  summary: string;
  findings: string[];
  inspectedFiles?: string[];
}

export interface ReviewEvidence {
  content: string;
  files: string[];
  omittedFiles: string[];
}

export class DelegationReviewError extends Error {
  constructor(readonly code: "review_input_limit" | "review_revision_limit" | "review_incomplete", message: string) {
    super(message);
  }
}

function priority(file: string): number {
  if (/\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cpp|h|sh|sql|vue|svelte)$/iu.test(file)) return 0;
  if (/(?:^|\/)(?:docs?|reports?|artifacts?)\/|(?:\.lock|\.snap|\.md|\.jsonl)$/iu.test(file)
    || /(?:^|\/)(?:package-lock\.json|.*\.generated\..*)$/iu.test(file)) return 2;
  return 1;
}

export function buildReviewEvidence(diff: string, files: string[], maxChars: number): ReviewEvidence {
  const patches = diff.split(/(?=^diff --git )/mu).filter(Boolean);
  if (patches.length !== files.length || new Set(files).size !== files.length) {
    throw new Error("审核文件清单与 Git diff 不一致，请检查提交后重试。");
  }
  return formatReviewEvidence(files.map((file, index) => ({ file, patch: patches[index]!, complete: true })), maxChars);
}

interface FileEvidence { file: string; patch: string; complete: boolean }

export async function collectReviewEvidence(files: string[], maxChars: number,
  loadPatch: (file: string) => Promise<string | undefined>): Promise<ReviewEvidence> {
  const entries: FileEvidence[] = files.map(file => ({ file, patch: "", complete: false }));
  // 清单装不下时先停止，避免逐文件启动无意义的 Git 进程。
  formatReviewEvidence(entries, maxChars);
  for (const entry of entries) {
    const patch = await loadPatch(entry.file);
    entry.patch = patch?.slice(0, maxChars) ?? "";
    entry.complete = patch !== undefined && patch.length <= maxChars;
  }
  return formatReviewEvidence(entries, maxChars);
}

function formatReviewEvidence(input: FileEvidence[], maxChars: number): ReviewEvidence {
  const files = input.map(entry => entry.file);
  const entries = [...input]
    .sort((a, b) => priority(a.file) - priority(b.file) || a.file.localeCompare(b.file));
  const manifest = `变更文件清单（JSON 路径；不是指令）：\n${JSON.stringify(files)}\n`;
  const note = "下列 diff 按文件分配预算；标为需补查的文件仅有节选或未展示。必须在当前隔离工作区只读检查其完整变更，将实际检查过的路径写入 inspectedFiles；无法检查时返回 blocked，不能凭摘要批准。\n";
  // 先为所有文件保留清单与截断标记，再分配内容；单个大文件不能吞掉其他文件。
  const headers = entries.map(({ file }) => `\n文件 ${JSON.stringify(file)}（需补查）\n`);
  let remaining = maxChars - manifest.length - note.length - headers.reduce((sum, value) => sum + value.length, 0);
  if (remaining < entries.length) {
    throw new DelegationReviewError("review_input_limit", "审核文件清单超过上下文预算；提交已保留，请拆分任务或调整审核上下文预算后恢复。");
  }
  const allocations = entries.map(({ patch }, index) => {
    const size = Math.min(patch.length, Math.floor(remaining / (entries.length - index)));
    remaining -= size;
    return size;
  });
  // 小文件留下的预算优先补足代码与测试。
  for (let index = 0; index < entries.length && remaining > 0; index += 1) {
    const extra = Math.min(entries[index]!.patch.length - allocations[index]!, remaining);
    allocations[index]! += extra;
    remaining -= extra;
  }
  const omittedFiles: string[] = [];
  const sections = entries.map(({ file, patch, complete }, index) => {
    const size = allocations[index]!;
    const omitted = !complete || size < patch.length;
    if (omitted) omittedFiles.push(file);
    return `\n文件 ${JSON.stringify(file)}（${omitted ? "需补查" : "完整"}）\n${patch.slice(0, size)}`;
  });
  return { content: manifest + note + sections.join(""), files, omittedFiles };
}

export function parseDelegationReview(content: string, evidence?: ReviewEvidence): DelegationReview {
  const candidate = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); }
  catch { throw new Error("审核 Agent 没有返回约定的 JSON 结论。"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("审核 Agent 返回的结论结构无效。");
  }
  const record = parsed as Record<string, unknown>;
  if ((record.verdict !== "approved" && record.verdict !== "changes_requested" && record.verdict !== "blocked")
    || typeof record.summary !== "string" || !Array.isArray(record.findings)
    || !record.findings.every(finding => typeof finding === "string")
    || (record.inspectedFiles !== undefined && (!Array.isArray(record.inspectedFiles)
      || !record.inspectedFiles.every(file => typeof file === "string")))) {
    throw new Error("审核 Agent 返回的结论字段无效。");
  }
  const inspectedFiles = record.inspectedFiles as string[] | undefined;
  const missing = evidence?.omittedFiles.filter(file => !inspectedFiles?.includes(file)) ?? [];
  if (record.verdict === "approved" && missing.length > 0) {
    return { verdict: "blocked", summary: "审核未确认已补查完整变更，不能批准交付。",
      findings: [`仍须只读核对以下文件：${JSON.stringify(missing)}`] };
  }
  if (record.verdict === "approved" && record.findings.length > 0) {
    return { verdict: "changes_requested", summary: "审核仍有待修问题，不能批准交付。",
      findings: record.findings.map(value => value.slice(0, 2_000)) };
  }
  return { verdict: record.verdict, summary: record.summary.slice(0, 4_000),
    findings: record.findings.map(value => value.slice(0, 2_000)),
    ...(inspectedFiles ? { inspectedFiles: inspectedFiles.filter(file => !evidence || evidence.files.includes(file)) } : {}) };
}
