/**
 * @input  依赖：CouncilDatabase（任务/资产记录、工作项回写）、AssetService（参考图字节、产物入库与关联）、
 *         CodexRuntime（生图探针与 generateImages）、brief-protocol（brief/清单/提示词）、委派账本、
 *         调用方注入的 Git 执行器、审计记录器与任务上下文解析
 * @output 导出：图像委派派发前校验（brief、参考资产、默认监督者）、单段生图执行 executeImageDelegation、
 *         DelegationImageError（image_unavailable / outputs_missing / manifest_invalid，失败文案带协议定位原因；
 *         image_unavailable 沿用 Codex 运行时的脱敏文案并在审计记 diagnosticCode，超时与出错可区分）与常量；
 *         清单里超出 brief 的产物（修订轮常见的「多报」）只丢弃并记审计，不让整轮失败；
 *         委派 outputManifest 的公开形状 ImageOutputManifest（清单 + 本次入库的 assetIds、逐张 assetId）与读取 helper
 *         readImageOutputManifest（流水线复盘据此只看本次委派入库的产物）；
 *         共享 helper excludeCouncilDir / copyInputAssets / COUNCIL_INPUT_DIR（代码委派输入资产与流水线复用）
 * @pos    图像委派的唯一执行体：管理器只按 kind 分流到这里；不 import 管理器，所有依赖显式传入。
 *         单段执行、无审核与 brief 生成阶段；产物不提交（headCommit = baseCommit），只入资产库并关联任务。
 *         审计只记数量、字节、去重数与耗时，任何路径都不进 DTO、审计、日志或错误文案
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssetService } from "../assets/asset-service.js";
import { CodexRuntimeError, type CodexRuntime } from "../codex-runtime.js";
import { MAX_IMAGE_INPUT_ASSETS, MAX_WORK_ITEM_STATUS_NOTE_CHARS } from "../constants.js";
import type { CouncilDatabase } from "../database.js";
import { CouncilValidationError } from "../errors.js";
import type { AgentDefinition, ProviderProfile } from "../model-router-store.js";
import {
  assetManifestJsonSchema,
  BRIEF_PROTOCOL_LIMITS,
  CouncilProtocolError,
  parseCouncilAssetManifest,
  parseCouncilBrief,
  renderImageBriefPrompt,
  type CouncilAssetManifest,
  type CouncilAssetManifestOutput,
  type CouncilBrief,
} from "../pipelines/brief-protocol.js";
import { normalizeProjectPath } from "../project-path.js";
import type { WorkItem } from "../types.js";
import { validateInputImageAssets, type ResolvedDelegationTask } from "./delegation-task-resolver.js";
import { redactAuditText } from "./runtime-audit-store.js";
import type { WorkItemDelegationStore } from "./work-item-delegation-store.js";

// ┌─────────────────────────────────────────────────────────────┐
// │ 常量与错误                                                  │
// └─────────────────────────────────────────────────────────────┘

/** 执行者不满足生图条件时的固定文案（REST 400，Web/MCP 直接展示）。 */
export const IMAGE_EXECUTOR_REQUIRED_MESSAGE = "生图需要本机 ChatGPT 登录的 Codex。";
/** 单次图像委派的参考图上限：契约 8 张，且不超过 brief 协议允许的输入数。 */
export const IMAGE_MAX_INPUT_ASSETS = Math.min(MAX_IMAGE_INPUT_ASSETS, BRIEF_PROTOCOL_LIMITS.maxInputs);

const COUNCIL_DIR = ".council";
const INPUT_DIR = `${COUNCIL_DIR}/in`;
/** 输入资产相对工作区根的目录；代码委派输入资产与流水线复用同一位置。 */
export const COUNCIL_INPUT_DIR = INPUT_DIR;
const OUTPUT_DIR = `${COUNCIL_DIR}/out`;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** Codex thread id 只用于拼兜底目录名；拒绝 `.`/`..` 这类会跳出目录的取值。 */
const SAFE_THREAD_ID = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,199}$/u;

export type DelegationImageFailureCode = "image_unavailable" | "outputs_missing" | "manifest_invalid";

/** 图像委派的分类失败；code 写进委派 failureCode 与审计 kind，message 以「图像」开头可公开展示。 */
export class DelegationImageError extends Error {
  override readonly name = "DelegationImageError";

  constructor(readonly code: DelegationImageFailureCode, message: string) {
    super(message);
  }
}

function compact(value: string, maximum: number): string {
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function abortError(): Error {
  return Object.assign(new Error("任务执行已取消。"), { name: "AbortError" });
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 派发前校验                                                  │
// └─────────────────────────────────────────────────────────────┘

/**
 * 图像任务必须已有可解析的 council-brief；参考资产须存在、未删除、kind=image 且与任务同项目。
 * 缺失/已删除资产由仓储抛 CouncilNotFoundError（404），其余不合规为 400。
 */
export function validateImageDelegationRequest(
  database: CouncilDatabase,
  input: { item: WorkItem; projectPath: string; inputAssetIds: readonly string[] },
): CouncilBrief {
  const brief = parseTaskBrief(input.item);
  validateInputImageAssets(database, {
    projectPath: input.projectPath,
    inputAssetIds: input.inputAssetIds,
    label: "图像委派",
    maxAssets: IMAGE_MAX_INPUT_ASSETS,
  });
  return brief;
}

function parseTaskBrief(item: WorkItem): CouncilBrief {
  if (!item.brief) throw new CouncilValidationError("图像任务需要先提交 council-brief。");
  try {
    return parseCouncilBrief(item.brief);
  } catch (error) {
    if (error instanceof CouncilProtocolError) {
      throw new CouncilValidationError("图像任务需要先提交 council-brief。");
    }
    throw error;
  }
}

/**
 * 默认监督者：启用、未删除、Provider 为活跃 claude-cli 的 Agent，优先 mentionAlias `claude`；
 * 表上 CHECK supervisor≠executor，因此排除执行者本身。找不到时 400。
 */
export function defaultImageSupervisor(
  agents: readonly AgentDefinition[],
  providerOf: (providerId: string) => ProviderProfile | undefined,
  executorId: string,
): AgentDefinition {
  const candidates = agents.filter((agent) => {
    if (agent.deletedAt || !agent.enabled || agent.id === executorId) return false;
    const provider = providerOf(agent.providerId);
    return provider?.status === "active" && provider.protocol === "claude-cli";
  });
  const preferred = candidates.find((agent) => agent.mentionAlias === "claude") ?? candidates[0];
  if (!preferred) {
    throw new CouncilValidationError("图像委派找不到可用的默认监督者（需要一个启用的 Claude CLI Agent），请显式指定监督 Agent。");
  }
  return preferred;
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 执行                                                        │
// └─────────────────────────────────────────────────────────────┘

export interface ImageDelegationWorkspace {
  /** 隔离 worktree 根目录（绝对路径，仅本地使用）。 */
  root: string;
  baseCommit: string;
}

export interface ImageDelegationDeps {
  store: WorkItemDelegationStore;
  database: CouncilDatabase;
  assets: AssetService;
  codex: CodexRuntime;
  /** 管理器的受控 Git 执行器，返回 stdout；非零退出时抛错。 */
  git: (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;
  record: (kind: string, data: Record<string, string | number>) => void;
  requireAgent: (id: string, action: string) => AgentDefinition;
  taskContext: (workItemId: string) => ResolvedDelegationTask;
  /** 派发/认领所得任务版本；只回写这个版本，不覆盖执行期间的人工作答。 */
  workItemVersion: () => number | undefined;
  setWorkItemVersion: (version: number) => void;
  config: { codexHome?: string; timeoutMs: number; maxOutputs: number };
}

interface CollectedFile {
  absolutePath: string;
  sha256: string;
  bytes: number;
  prompt: string;
  /** 清单声明的相对路径（只有清单路①收到的文件有）：入库后用它把 assetId 写回清单。 */
  manifestPath?: string;
}

/**
 * 生图委派 `outputManifest` 的公开形状：清单原文（prompt/notes 脱敏）加上本次执行实际入库的资产。
 * resume 会对同一子任务重新委派，而失败尝试（清单无效）已入库的产物仍以 output 挂在子任务上；
 * 流水线复盘只看这里的 assetIds，才不会把上一次尝试的产物当成本轮结果。
 */
export type ImageOutputManifest = {
  schemaVersion: 1;
  outputs: Array<CouncilAssetManifestOutput & { assetId?: string }>;
  /** 本次执行入库的资产 id（sha256 命中既有资产时为既有 id），顺序同清单；清单漏报、`.council/out` 收回的也在内。 */
  assetIds: string[];
  notes: string;
};

/**
 * 从委派 DTO 的 outputManifest 读回本次入库的资产与每张对应的 deliverableId。
 * 旧记录、非图像委派或形状不符返回 undefined，调用方退回「子任务全部 output 资产」。
 */
export function readImageOutputManifest(
  value: Record<string, unknown> | undefined,
): { assetIds: string[]; deliverableIds: Map<string, string> } | undefined {
  if (!value || !Array.isArray(value["assetIds"]) || !Array.isArray(value["outputs"])) return undefined;
  const assetIds = value["assetIds"].filter((item): item is string => typeof item === "string");
  const deliverableIds = new Map<string, string>();
  for (const output of value["outputs"]) {
    if (typeof output !== "object" || output === null) continue;
    const { assetId, deliverableId } = output as Record<string, unknown>;
    if (typeof assetId === "string" && typeof deliverableId === "string") deliverableIds.set(assetId, deliverableId);
  }
  return { assetIds, deliverableIds };
}

/**
 * 单段生图：认领任务 → 准备 `.council/in|out` 并写入 Git exclude → 复制参考图 → generateImages →
 * 清单解析 → 三路收集（清单 path、`.council/out`；前两路为空时才兜底扫 `<codex-home>/generated_images/<threadId>`）→
 * sha256 去重入库并关联任务 → 置 approved，任务停在 in_progress 等人工验收。
 */
export async function executeImageDelegation(
  deps: ImageDelegationDeps,
  id: string,
  workspace: ImageDelegationWorkspace,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw abortError();
  const delegation = deps.store.get(id);
  if (!delegation) throw new Error("任务委派不存在。");
  const task = deps.taskContext(delegation.workItemId);
  const supervisor = deps.requireAgent(delegation.supervisorAgentId, "监督");
  const executor = deps.requireAgent(delegation.executorAgentId, "执行");
  const brief = parseTaskBrief(task.item);
  const claimed = deps.database.claimWorkItemAsActor({
    topicId: delegation.topicId,
    workItemId: delegation.workItemId,
    expectedVersion: deps.workItemVersion() ?? task.item.version,
    statusNote: `${executor.displayName} 正在隔离 worktree 中生成图像；${supervisor.displayName} 负责监督。`,
    actorId: executor.actorId,
  });
  deps.setWorkItemVersion(claimed.version);
  deps.store.update(id, { status: "executing", attempt: 1, now: new Date().toISOString() });

  const outputDir = path.join(workspace.root, OUTPUT_DIR);
  const inputDir = path.join(workspace.root, INPUT_DIR);
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await excludeCouncilDir(deps.git, workspace.root, signal);
  const inputs = await copyInputAssets(deps.assets, inputDir, delegation.inputAssetIds);

  const startedAt = Date.now();
  const scratch = await mkdtemp(path.join(tmpdir(), "council-image-"));
  let threadId: string;
  let lastMessage: string;
  try {
    const outputSchemaPath = path.join(scratch, "manifest.schema.json");
    const lastMessagePath = path.join(scratch, "last-message.json");
    await writeFile(outputSchemaPath, JSON.stringify(assetManifestJsonSchema()), "utf8");
    const probe = await deps.codex.checkAvailability();
    if (!probe.available || !probe.authenticated || !probe.imageGeneration.available) {
      throw imageFailure(deps, "image_unavailable", "图像生成不可用：Codex 未登录或生图探针未通过，请检查后重新委派。");
    }
    const prompt = renderImageBriefPrompt(brief, {
      outputDir: OUTPUT_DIR,
      inputs: inputs.map((item) => ({ assetId: item.assetId, relativePath: item.relativePath })),
    });
    try {
      ({ threadId, lastMessage } = await deps.codex.generateImages({
        worktreeDir: workspace.root,
        prompt,
        outputSchemaPath,
        lastMessagePath,
        inputImagePaths: inputs.map((item) => item.absolutePath),
        ...(executor.model ? { model: executor.model } : {}),
        timeoutMs: deps.config.timeoutMs,
        signal,
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (signal.aborted) throw abortError();
      // 运行时文案本身不含路径（超时/未登录/进程退出分类），再脱敏一次只为兜底；审计记诊断码便于区分超时与出错。
      const reason = error instanceof Error && error.message.trim()
        ? redactAuditText(error.message.trim())
        : "Codex 执行出错或超时，请检查本机 Codex 后重新委派。";
      throw imageFailure(
        deps,
        "image_unavailable",
        `图像生成失败：${reason}`,
        error instanceof CodexRuntimeError ? error.diagnosticCode : "runtime_error",
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (signal.aborted) throw abortError();

  const parsed = parseManifestForBrief(deps, lastMessage, brief);
  const manifest = parsed.manifest;
  const collected = await collectOutputs({
    root: workspace.root,
    outputDir,
    manifest,
    ignoredPaths: parsed.ignoredPaths,
    brief,
    ...(deps.config.codexHome ? { codexHome: deps.config.codexHome } : {}),
    threadId,
  });
  const ingest = await ingestOutputs(deps, {
    delegationId: id,
    workItemId: delegation.workItemId,
    projectPath: task.projectPath,
    files: collected.files,
  });
  const durationMs = Date.now() - startedAt;
  deps.record("image.collected", {
    candidates: collected.files.length + collected.localDuplicates,
    unique: collected.files.length,
    ingested: ingest.assetIds.length,
    deduplicated: collected.localDuplicates + ingest.deduplicated,
    rejected: collected.rejected + ingest.rejected,
    skipped: ingest.skipped,
    bytes: ingest.bytes,
    inputs: inputs.length,
    durationMs,
  });
  if (ingest.skipped > 0) {
    deps.record("image.outputs_skipped", { skipped: ingest.skipped, maxOutputs: deps.config.maxOutputs });
  }
  if (!manifest) {
    const reason = parsed.reason ? `（${parsed.reason}）` : "";
    throw imageFailure(deps, "manifest_invalid", ingest.assetIds.length > 0
      ? `图像清单无效${reason}：已入库找到的 ${String(ingest.assetIds.length)} 张产物，请检查后重新委派。`
      : `图像清单无效${reason}且没有找到可入库的产物，请检查后重新委派。`);
  }
  if (ingest.assetIds.length === 0) {
    throw imageFailure(deps, "outputs_missing", "图像委派没有找到可入库的产物，请检查后重新委派。");
  }

  const deduplicated = collected.localDuplicates + ingest.deduplicated;
  // 清单是模型自述：notes 与逐张 prompt 落库前统一脱敏；path 已被协议约束为相对路径。
  // 逐张写回入库后的 assetId（本地 sha256 重复的那张没有），并记下本次入库的全部资产供流水线复盘圈定范围。
  const publicManifest: ImageOutputManifest = {
    schemaVersion: manifest.schemaVersion,
    outputs: manifest.outputs.map((output) => {
      const assetId = ingest.assetIdByManifestPath.get(output.path);
      return { ...output, prompt: redactAuditText(output.prompt), ...(assetId ? { assetId } : {}) };
    }),
    assetIds: ingest.assetIds,
    notes: redactAuditText(manifest.notes),
  };
  const statusNote = compact(
    `图像已入库 ${String(ingest.assetIds.length)} 张（去重 ${String(deduplicated)} 张），等待人工验收。`,
    MAX_WORK_ITEM_STATUS_NOTE_CHARS,
  );
  deps.database.updateWorkItemAsActor({
    ...(delegation.topicId ? { topicId: delegation.topicId } : {}),
    workItemId: delegation.workItemId,
    status: "in_progress",
    expectedVersion: claimed.version,
    statusNote,
    actorId: supervisor.actorId,
  });
  deps.store.update(id, {
    status: "approved",
    headCommit: workspace.baseCommit,
    summary: compact(`${statusNote}${publicManifest.notes ? ` ${publicManifest.notes}` : ""}`, 8_000),
    outputManifest: publicManifest,
    now: new Date().toISOString(),
  });
  return workspace.baseCommit;
}

/**
 * 解析清单并对齐 brief。修订轮的 brief 只含不合格交付物，而真实 Codex 常把已通过的交付物也重做一遍写进清单：
 * 这种「多报」只丢弃多出的产物（记审计、不入库），不让整轮失败；清单本身损坏或没有一张对得上 brief 才视为无效。
 * reason 只含协议定位文案（字段路径），不含文件路径，可进错误文案。
 */
function parseManifestForBrief(
  deps: ImageDelegationDeps,
  lastMessage: string,
  brief: CouncilBrief,
): { manifest?: CouncilAssetManifest; ignoredPaths: readonly string[]; reason?: string } {
  try {
    return { manifest: parseCouncilAssetManifest(lastMessage, { brief }), ignoredPaths: [] };
  } catch (error) {
    if (!(error instanceof CouncilProtocolError)) throw error;
    const reason = compact(redactAuditText(error.message), 200);
    let loose: CouncilAssetManifest;
    try {
      loose = parseCouncilAssetManifest(lastMessage);
    } catch {
      return { ignoredPaths: [], reason };
    }
    const deliverableIds = new Set(brief.deliverables.map((item) => item.id));
    const kept = loose.outputs.filter((output) => deliverableIds.has(output.deliverableId));
    const dropped = loose.outputs.filter((output) => !deliverableIds.has(output.deliverableId));
    if (kept.length === 0 || dropped.length === 0) return { ignoredPaths: [], reason };
    const keptPaths = new Set(kept.map((output) => output.path));
    const outputs = kept.map((output) => (
      output.variantOf && !keptPaths.has(output.variantOf) ? { ...output, variantOf: undefined } : output
    )).map(({ variantOf, ...rest }) => ({ ...rest, ...(variantOf ? { variantOf } : {}) }));
    deps.record("image.manifest_outputs_dropped", { dropped: dropped.length, kept: kept.length });
    return {
      manifest: { schemaVersion: 1, outputs, notes: loose.notes },
      ignoredPaths: dropped.map((output) => output.path),
    };
  }
}

function imageFailure(
  deps: ImageDelegationDeps,
  code: DelegationImageFailureCode,
  message: string,
  diagnosticCode?: string,
): DelegationImageError {
  deps.record(`image.${code}`, { failureCode: code, ...(diagnosticCode ? { diagnosticCode } : {}) });
  return new DelegationImageError(code, message);
}

/**
 * `.council/` 不进入任何提交：写入 `git rev-parse --git-path info/exclude` 解析出的真实文件（worktree 共享仓库级 exclude）。
 * 图像委派、代码委派的输入资产与流水线 brief/review 阶段共用。
 */
export async function excludeCouncilDir(
  git: (cwd: string, args: string[], signal: AbortSignal) => Promise<string>,
  root: string,
  signal: AbortSignal,
): Promise<void> {
  const resolved = (await git(root, ["rev-parse", "--git-path", "info/exclude"], signal)).trim();
  if (!resolved) throw new Error("Git 无法解析 exclude 文件。");
  const excludePath = path.resolve(root, resolved);
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  if (existing.split(/\r?\n/u).some((line) => line.trim() === `${COUNCIL_DIR}/` || line.trim() === `/${COUNCIL_DIR}/`)) {
    return;
  }
  await mkdir(path.dirname(excludePath), { recursive: true });
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}# Council 图像委派的输入与产物目录\n${COUNCIL_DIR}/\n`, "utf8");
}

/** 把资产字节拷到 inputDir（通常是 `<root>/.council/in`）；relativePath 相对 root，供提示词引用。 */
export async function copyInputAssets(
  assets: AssetService,
  inputDir: string,
  assetIds: readonly string[],
): Promise<Array<{ assetId: string; relativePath: string; absolutePath: string }>> {
  const copied: Array<{ assetId: string; relativePath: string; absolutePath: string }> = [];
  for (const assetId of assetIds) {
    const payload = await assets.content(assetId);
    // AssetPayload.filename 固定为 <assetId>.<ext>，不含原始文件名。
    const filename = path.basename(payload.filename);
    const absolutePath = path.join(inputDir, filename);
    // 先删后独占创建：目标若已被换成指向项目外的符号链接，直接 writeFile 会跟随链接写到项目外。
    await rm(absolutePath, { force: true });
    await writeFile(absolutePath, payload.bytes, { flag: "wx" });
    copied.push({ assetId, relativePath: `${INPUT_DIR}/${filename}`, absolutePath });
  }
  return copied;
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 产物收集与入库                                              │
// └─────────────────────────────────────────────────────────────┘

/** 常规文件且扩展名受支持才收；符号链接一律拒绝。 */
async function regularImage(absolutePath: string): Promise<{ bytes: Buffer } | undefined> {
  if (!IMAGE_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) return undefined;
  const stat = await lstat(absolutePath).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  return { bytes: await readFile(absolutePath) };
}

async function listImages(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

/** 清单 path 只能落在 `.council/out/` 下；拒绝 `..`、绝对路径与经符号链接逃逸的位置。 */
async function manifestOutputPath(root: string, realOutputDir: string, relative: string): Promise<string | undefined> {
  if (path.isAbsolute(relative) || relative.split("/").includes("..") || !relative.startsWith(`${OUTPUT_DIR}/`)) {
    return undefined;
  }
  const absolutePath = path.join(root, relative);
  const stat = await lstat(absolutePath).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const real = await realpath(absolutePath).catch(() => undefined);
  if (!real) return undefined;
  const contained = path.relative(realOutputDir, real);
  return contained && !contained.startsWith("..") && !path.isAbsolute(contained) ? absolutePath : undefined;
}

/**
 * 清单漏报或兜底收回的文件没有模型给的逐张 prompt：按文件名前缀对回交付物；
 * 对不上的退回简报目标，而不是硬套第一个交付物的描述——真实 Codex 的兜底目录里是随机文件名的原图，
 * 硬套会把 hero 原图标成 icon。
 */
function deliverablePrompt(brief: CouncilBrief, filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  const matched = brief.deliverables.find((item) => base === item.id || base.startsWith(`${item.id}-`));
  return matched?.description ?? brief.goal;
}

async function collectOutputs(input: {
  root: string;
  outputDir: string;
  manifest: CouncilAssetManifest | undefined;
  /** 清单里超出 brief 的产物路径：既不入库，也不当作「漏报」从 `.council/out` 收回。 */
  ignoredPaths?: readonly string[];
  brief: CouncilBrief;
  codexHome?: string;
  threadId: string;
}): Promise<{ files: CollectedFile[]; localDuplicates: number; rejected: number }> {
  const files: CollectedFile[] = [];
  const seen = new Set<string>();
  let localDuplicates = 0;
  let rejected = 0;
  const add = async (absolutePath: string, prompt: string, manifestPath?: string): Promise<void> => {
    const image = await regularImage(absolutePath);
    if (!image) {
      rejected += 1;
      return;
    }
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    if (seen.has(sha256)) {
      localDuplicates += 1;
      return;
    }
    seen.add(sha256);
    files.push({ absolutePath, sha256, bytes: image.bytes.length, prompt, ...(manifestPath ? { manifestPath } : {}) });
  };
  const realOutputDir = await realpath(input.outputDir);
  const claimed = new Set<string>();
  for (const ignored of input.ignoredPaths ?? []) {
    const absolutePath = await manifestOutputPath(input.root, realOutputDir, ignored);
    if (absolutePath) claimed.add(absolutePath);
  }
  // ① 清单声明的产物优先：保留模型给出的逐张 prompt。
  for (const output of input.manifest?.outputs ?? []) {
    const absolutePath = await manifestOutputPath(input.root, realOutputDir, output.path);
    if (!absolutePath) {
      rejected += 1;
      continue;
    }
    claimed.add(absolutePath);
    await add(absolutePath, output.prompt, output.path);
  }
  // ② `.council/out/` 里实际存在、清单漏报的文件。
  for (const absolutePath of await listImages(input.outputDir)) {
    if (claimed.has(absolutePath)) continue;
    await add(absolutePath, deliverablePrompt(input.brief, absolutePath));
  }
  // ③ Codex 默认产物目录兜底：只在清单与 `.council/out` 一张都没收到时才扫。
  // 真实 Codex 会先把原图落在这里、再缩放/复制进 worktree，两份字节不同、sha256 去不掉；
  // 与前两路取并集会让产物翻倍并混入未定稿的原图，人工验收反而要自己辨别。
  if (files.length === 0 && input.codexHome && SAFE_THREAD_ID.test(input.threadId)) {
    const generated = path.join(input.codexHome, "generated_images", input.threadId);
    for (const absolutePath of await listImages(generated)) {
      await add(absolutePath, deliverablePrompt(input.brief, absolutePath));
    }
  }
  return { files, localDuplicates, rejected };
}

async function ingestOutputs(
  deps: ImageDelegationDeps,
  input: { delegationId: string; workItemId: string; projectPath: string; files: readonly CollectedFile[] },
): Promise<{
  assetIds: string[];
  /** 清单相对路径 → 入库 assetId，只含清单路①收到的文件。 */
  assetIdByManifestPath: Map<string, string>;
  deduplicated: number;
  rejected: number;
  skipped: number;
  bytes: number;
}> {
  const assetIds: string[] = [];
  const assetIdByManifestPath = new Map<string, string>();
  let deduplicated = 0;
  let rejected = 0;
  let bytes = 0;
  // 名额只给真正入库的产物：被拒的文件不占名额，否则前几张无效文件会把后面的合法产物挤掉。
  let attempted = 0;
  for (const file of input.files) {
    if (assetIds.length >= deps.config.maxOutputs) break;
    attempted += 1;
    try {
      const result = await deps.assets.ingestFile({
        projectPath: input.projectPath,
        sourcePath: file.absolutePath,
        origin: { delegationId: input.delegationId },
        prompt: redactAuditText(file.prompt),
      });
      deps.assets.addLink(result.asset.id, "work_item", input.workItemId, "output");
      if (result.deduplicated) deduplicated += 1;
      bytes += result.asset.byteSize;
      assetIds.push(result.asset.id);
      if (file.manifestPath) assetIdByManifestPath.set(file.manifestPath, result.asset.id);
    } catch (error) {
      // 单张被资产库拒绝（嗅探不符、超限、配额）不拖垮其余产物；数量进审计。
      if (error instanceof CouncilValidationError) {
        rejected += 1;
        continue;
      }
      throw error;
    }
  }
  return { assetIds, assetIdByManifestPath, deduplicated, rejected, skipped: input.files.length - attempted, bytes };
}
