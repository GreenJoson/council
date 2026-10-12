/**
 * @input  依赖：`codex features list` 文本输出、Council 传给 Codex 的额外参数、图像委派准备好的绝对路径
 * @output 导出：CodexImageCapability 探针结论、生图输入/输出类型、features 判定、Provider 覆盖检测、
 *         生图输入校验与 `codex exec` 生图参数拼装
 * @pos    Codex 生图的纯函数层：不起进程、不读文件、不读环境变量；进程生命周期仍归 CodexRuntime
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import type { NativeRuntimeProgressListener } from "./native-runtime-progress.js";

/** 生图探针结论；不可用时只给机器可读的诊断码，不携带 CLI 原文。 */
export interface CodexImageCapability {
  available: boolean;
  /**
   * disabled（配置关闭）/ not_authenticated / runtime_unavailable / provider_overridden /
   * features_failed / feature_missing / feature_not_stable / feature_disabled
   */
  diagnosticCode?: string;
}

export interface CodexImageGenerationInput {
  /** 委派隔离 worktree 的绝对路径；生图沙箱只允许写这里。 */
  worktreeDir: string;
  /** 由 renderImageBriefPrompt 生成的完整提示词，经 stdin 传入。 */
  prompt: string;
  /** assetManifestJsonSchema() 写出的 JSON Schema 文件绝对路径（`--output-schema`）。 */
  outputSchemaPath: string;
  /** 最终消息文件绝对路径（`-o`）；调用方负责创建目录与清理。 */
  lastMessagePath: string;
  /** 参考图绝对路径（`-i`），通常是 worktree `.council/in/` 下的拷贝。 */
  inputImagePaths: readonly string[];
  model?: string;
  /** 单次调用绝对时长上限，调用方传 COUNCIL_CODEX_IMAGE_TIMEOUT_MS。 */
  timeoutMs: number;
  /** 事件流连续静默上限（COUNCIL_CODEX_IMAGE_IDLE_TIMEOUT_MS）：超过即判定卡住终止；缺省只受 timeoutMs 约束。 */
  idleTimeoutMs?: number;
  /** 白名单进程进度（会话、工具计数）；不含正文、命令参数或路径。 */
  onEvent?: NativeRuntimeProgressListener;
  onActivity?: () => void;
  signal?: AbortSignal;
}

export interface CodexImageGenerationResult {
  /** JSONL `thread.started.thread_id`；兜底扫描 `<codex-home>/generated_images/<threadId>/` 用。 */
  threadId: string;
  /** `-o` 文件内容（为空时回退到最后一条 agent_message）；应是符合清单 schema 的 JSON 文本。 */
  lastMessage: string;
}

const IMAGE_FEATURE_NAME = "image_generation";
const MAX_NODE_TIMER_MS = 2_147_483_647;
const MAX_INPUT_IMAGES = 16;

/**
 * 解析 `codex features list`：每行 `<name> <stage> <enabled>`，stage 可能含空格
 * （如 `under development`），因此取首 token 为名称、末 token 为开关、中间为 stage。
 */
export function evaluateCodexImageFeature(stdout: string): CodexImageCapability {
  for (const line of stdout.split("\n")) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 3 || tokens[0] !== IMAGE_FEATURE_NAME) {
      continue;
    }
    const stage = tokens.slice(1, -1).join(" ");
    const enabled = tokens[tokens.length - 1];
    if (stage !== "stable") {
      return { available: false, diagnosticCode: "feature_not_stable" };
    }
    if (enabled !== "true") {
      return { available: false, diagnosticCode: "feature_disabled" };
    }
    return { available: true };
  }
  return { available: false, diagnosticCode: "feature_missing" };
}

/**
 * Council 自己传给 Codex 的参数若改写了 Provider（`model_provider`/`model_providers.*`、
 * 本地 OSS Provider），image 工具不会挂载。配置层已拒绝 `--config`/`--oss` 等保留参数，
 * 这里再按值兜底一次，避免以后放宽配置时探针给出假阳性。
 */
export function overridesModelProvider(args: readonly string[]): boolean {
  return args.some((value) =>
    /model_providers?\b/iu.test(value)
    || /^--(?:oss|local-provider)(?:=|$)/iu.test(value));
}

function requireAbsolute(value: string, label: string): void {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`Codex 生图的 ${label} 必须是绝对路径。`);
  }
}

export function validateCodexImageInput(input: CodexImageGenerationInput): void {
  requireAbsolute(input.worktreeDir, "worktree");
  requireAbsolute(input.outputSchemaPath, "清单 schema 路径");
  requireAbsolute(input.lastMessagePath, "最终消息路径");
  if (input.inputImagePaths.length > MAX_INPUT_IMAGES) {
    throw new Error(`Codex 生图参考图不能超过 ${String(MAX_INPUT_IMAGES)} 张。`);
  }
  input.inputImagePaths.forEach((item) => requireAbsolute(item, "参考图路径"));
  if (!input.prompt.trim()) {
    throw new Error("Codex 生图提示词不能为空。");
  }
  if (
    !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs <= 0
    || input.timeoutMs > MAX_NODE_TIMER_MS
  ) {
    throw new Error("Codex 生图超时必须是 Node.js 定时器范围内的正整数。");
  }
}

/**
 * 固定参数集。`-i` 是可变参数（`<FILE>...`），必须放在其他选项之前，
 * 否则末尾表示 stdin 的 `-` 会被当作一张参考图吞掉；路径都已校验为绝对路径，不会被当成选项。
 */
export function buildCodexImageArgs(input: {
  worktreeDir: string;
  outputSchemaPath: string;
  lastMessagePath: string;
  inputImagePaths: readonly string[];
  model?: string;
}): string[] {
  return [
    "exec",
    "--sandbox",
    "workspace-write",
    "--cd",
    input.worktreeDir,
    "--skip-git-repo-check",
    // 与讨论路径一致：跳过用户 config.toml（含用户 MCP 与 Provider），认证仍走 CODEX_HOME。
    "--ignore-user-config",
    "--enable",
    IMAGE_FEATURE_NAME,
    ...input.inputImagePaths.flatMap((item) => ["-i", item]),
    "--json",
    "--output-schema",
    input.outputSchemaPath,
    "-o",
    input.lastMessagePath,
    ...(input.model ? ["--model", input.model] : []),
    "-",
  ];
}
