/**
 * @input  依赖：OpenAICompatibleModelClient、ReadOnlyToolHost、项目路径/授权仓库与 ToolLoop 配置
 * @output 导出：模型请求→共享批次预算→证据凭据压缩→强制收尾的有界 AgentLoop
 * @pos    Council-owned Runtime；模型只选择工具，原始证据留在本轮内存，发送上下文始终受 Council 预算控制
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createHash } from "node:crypto";

import {
  OpenAICompatibleModelClient,
  OpenAICompatibleRuntimeError,
  type ModelMessage,
  type ModelToolCall,
} from "./openai-compatible-model-client.js";
import {
  ReadOnlyToolHost,
  ReadOnlyToolHostError,
} from "./read-only-tool-host.js";
import { ReadOnlyGitDiffError } from "./read-only-git-diff.js";
import type { GitCommitGrant } from "./read-only-git-diff.js";
import type { CouncilConfig } from "./types.js";

export type ToolLoopToolEventType =
  | "tool.requested"
  | "tool.started"
  | "tool.completed";

export interface ReadOnlyAgentLoopInput {
  baseUrl: string;
  model: string;
  apiKey: string;
  prompt: string;
  projectPath?: string;
  gitCommitTargets?: readonly GitCommitGrant[];
  signal?: AbortSignal;
  onActivity?: () => void;
  onTextEvent?: (event:
    | { operation: "reset" }
    | { operation: "append"; content: string }
    | { operation: "replace"; content: string }
  ) => void;
  onToolEvent?: (event: {
    type: ToolLoopToolEventType;
    callId: string;
    toolName: string;
  }) => void;
}

const FINAL_STEP_INSTRUCTION =
  "工具轮数已用尽，本轮不再提供工具。请基于以上已获得的信息直接给出最终回复；"
  + "若证据不足以支撑结论，请写明还缺什么，不要再请求工具。";

const CONTEXT_PRESSURE_FINAL_STEP_INSTRUCTION =
  "Council 上下文预算即将耗尽，本轮不再提供工具。请基于当前可见证据直接给出最终回复；"
  + "带有“工具证据已压缩”标记的内容不是完整原文。若缺失部分会影响结论，必须明确判定证据不足，"
  + "列出需要重新读取的 commit、文件或行范围，不得据此宣称审核通过。";

const CONTEXT_COVERAGE_GUARD = [
  "> Council 覆盖保护：本轮因上下文预算耗尽提前收回工具，结论只覆盖当前可见证据。",
  "",
  "```council-verdict",
  '{"stance":"blocking","summary":"工具上下文预算耗尽，必须按列出的 commit、文件或行范围重新审核。"}',
  "```",
].join("\n");

interface ToolEvidenceEntry {
  call: ModelToolCall;
  rawContent: string;
}

interface ToolEvidenceBatch {
  entries: ToolEvidenceEntry[];
}

function contextChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => {
    const toolChars = message.role === "assistant"
      ? message.toolCalls?.reduce(
          (sum, call) => sum + call.id.length + call.name.length + call.arguments.length,
          0,
        ) ?? 0
      : message.role === "tool"
        ? message.toolCallId.length
        : 0;
    return total + message.content.length + toolChars;
  }, 0);
}

function messageChars(message: ModelMessage): number {
  return contextChars([message]);
}

function allocateSharedBudgets(
  lengths: readonly number[],
  maximum: number,
): number[] {
  const budgets = lengths.map(() => 0);
  let remaining = Math.max(0, maximum);
  let pending = lengths.map((_, index) => index);

  while (pending.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / pending.length);
    if (share <= 0) {
      for (const index of pending.slice(0, remaining)) {
        budgets[index] = 1;
      }
      break;
    }
    const satisfied = pending.filter((index) => (lengths[index] ?? 0) <= share);
    if (satisfied.length === 0) {
      for (const index of pending) {
        budgets[index] = share;
        remaining -= share;
      }
      for (const index of pending) {
        if (remaining <= 0) {
          break;
        }
        budgets[index] = (budgets[index] ?? 0) + 1;
        remaining -= 1;
      }
      break;
    }
    const satisfiedSet = new Set(satisfied);
    for (const index of satisfied) {
      const length = lengths[index] ?? 0;
      budgets[index] = length;
      remaining -= length;
    }
    pending = pending.filter((index) => !satisfiedSet.has(index));
  }

  return budgets;
}

function compactEvidence(
  entry: ToolEvidenceEntry,
  maximum: number,
): string {
  if (maximum <= 0) {
    return "";
  }
  if (entry.rawContent.length <= maximum) {
    return entry.rawContent;
  }
  const receipt = [
    "[Council：工具证据已压缩]",
    JSON.stringify({
      tool: entry.call.name,
      arguments: entry.call.arguments,
      originalChars: entry.rawContent.length,
      sha256: createHash("sha256").update(entry.rawContent).digest("hex"),
    }),
    "以下仅为首尾摘录；需要完整证据时请缩小文件、行范围或 diff 范围后重新读取。",
    "",
  ].join("\n");
  if (receipt.length >= maximum) {
    return receipt.slice(0, maximum);
  }
  const omission = "\n[Council：中间证据已省略]\n";
  const excerptBudget = maximum - receipt.length;
  if (excerptBudget <= omission.length) {
    return `${receipt}${omission}`.slice(0, maximum);
  }
  const visibleBudget = excerptBudget - omission.length;
  const headLength = Math.ceil(visibleBudget / 2);
  const tailLength = visibleBudget - headLength;
  return `${receipt}${entry.rawContent.slice(0, headLength)}${omission}${
    tailLength > 0 ? entry.rawContent.slice(-tailLength) : ""
  }`;
}

function toolMessageIndex(
  messages: readonly ModelMessage[],
  callId: string,
): number {
  return messages.findIndex((message) =>
    message.role === "tool" && message.toolCallId === callId);
}

function compactBatch(
  messages: ModelMessage[],
  batch: ToolEvidenceBatch,
  maximum: number,
): void {
  const budgets = allocateSharedBudgets(
    batch.entries.map((entry) => entry.rawContent.length),
    maximum,
  );
  batch.entries.forEach((entry, index) => {
    const messageIndex = toolMessageIndex(messages, entry.call.id);
    if (messageIndex < 0) {
      return;
    }
    messages[messageIndex] = {
      role: "tool",
      toolCallId: entry.call.id,
      content: compactEvidence(entry, budgets[index] ?? 0),
    };
  });
}

function compactSeenBatchesUntil(
  messages: ModelMessage[],
  batches: readonly ToolEvidenceBatch[],
  maximumContextChars: number,
  requiredAdditionalChars: number,
  compactedBatchChars: number,
): void {
  for (const batch of batches) {
    if (contextChars(messages) + requiredAdditionalChars <= maximumContextChars) {
      return;
    }
    compactBatch(messages, batch, compactedBatchChars);
  }
}

function toolErrorContent(error: unknown): string {
  if (
    error instanceof ReadOnlyToolHostError
    || error instanceof ReadOnlyGitDiffError
  ) {
    return JSON.stringify({
      error: error.diagnosticCode,
      message: error.message,
    });
  }
  return JSON.stringify({
    error: "tool_failed",
    message: "只读工具执行失败。",
  });
}

function applyContextCoverageGuard(content: string, maximum: number): string {
  if (CONTEXT_COVERAGE_GUARD.length >= maximum) {
    return CONTEXT_COVERAGE_GUARD.slice(0, maximum);
  }
  const separator = "\n\n";
  if (CONTEXT_COVERAGE_GUARD.length + separator.length >= maximum) {
    return CONTEXT_COVERAGE_GUARD;
  }
  const bodyBudget = maximum - CONTEXT_COVERAGE_GUARD.length - separator.length;
  const body = content.trim().slice(0, bodyBudget);
  return `${body}${separator}${CONTEXT_COVERAGE_GUARD}`;
}

export class ReadOnlyAgentLoop {
  constructor(
    private readonly client: OpenAICompatibleModelClient,
    private readonly config: CouncilConfig,
  ) {}

  async generate(input: ReadOnlyAgentLoopInput): Promise<string> {
    const host = input.projectPath
      ? await ReadOnlyToolHost.create(
          input.projectPath,
          this.config,
          input.gitCommitTargets,
        )
      : undefined;
    const messages: ModelMessage[] = [
      { role: "user", content: input.prompt },
    ];
    const evidenceBatches: ToolEvidenceBatch[] = [];
    const compactedBatchChars = Math.floor(
      this.config.maxOutputChars / this.config.toolLoopMaxSteps,
    );
    let forceContextFinal = false;

    for (let step = 1; step <= this.config.toolLoopMaxSteps; step += 1) {
      const finalInstruction = forceContextFinal
        ? CONTEXT_PRESSURE_FINAL_STEP_INSTRUCTION
        : FINAL_STEP_INSTRUCTION;
      compactSeenBatchesUntil(
        messages,
        evidenceBatches,
        this.config.toolLoopMaxContextChars,
        finalInstruction.length,
        compactedBatchChars,
      );
      if (
        contextChars(messages) + finalInstruction.length
        > this.config.toolLoopMaxContextChars
      ) {
        throw new OpenAICompatibleRuntimeError(
          "只读 ToolLoop 的初始提示与必要收尾指令超过配置上限。",
          false,
          "tool_context_limit",
        );
      }
      /*
       * 最后一轮收回工具并明确通知模型收尾。
       *
       * 只靠"轮数用尽就报错"会把前面所有轮次读到的证据一起丢掉，而模型此时
       * 通常已经有足够材料写结论——它只是没有任何理由停下来：工具一直摆在
       * 那里，也没人告诉它还剩几轮。
       */
      const finalStep = forceContextFinal || step === this.config.toolLoopMaxSteps;
      if (finalStep && host) {
        messages.push({ role: "user", content: finalInstruction });
      }
      const result = await this.client.complete({
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        messages,
        ...(host && !finalStep ? { tools: host.definitions } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onActivity ? { onActivity: input.onActivity } : {}),
        ...(input.onTextEvent ? { onTextEvent: input.onTextEvent } : {}),
      });
      if (result.toolCalls.length === 0) {
        /*
         * 收回工具后模型更可能交白卷。空正文会被适配器拼上抬头照常发帖，
         * 于是圆桌里出现一条只有署名的消息——按可重试失败处理更诚实。
         */
        if (!result.content.trim()) {
          throw new OpenAICompatibleRuntimeError(
            "只读 ToolLoop 没有返回公开文本。",
            true,
            "empty_response",
          );
        }
        return forceContextFinal
          ? applyContextCoverageGuard(result.content, this.config.maxOutputChars)
          : result.content;
      }
      if (finalStep) {
        // 工具已收回却仍在请求工具：不执行，落到循环外的失败关闭。
        break;
      }
      if (!host) {
        throw new OpenAICompatibleRuntimeError(
          "当前议题没有有效项目目录，不能执行模型请求的只读工具。",
          false,
          "project_path_required",
        );
      }
      if (result.toolCalls.length > this.config.defaultMessageLimit) {
        throw new OpenAICompatibleRuntimeError(
          "模型单轮请求的工具数量超过配置上限。",
          false,
          "tool_call_limit",
        );
      }
      input.onTextEvent?.({ operation: "reset" });
      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      };
      const seenCallIds = new Set<string>();
      const entries: ToolEvidenceEntry[] = [];
      for (const call of result.toolCalls) {
        if (seenCallIds.has(call.id)) {
          throw new OpenAICompatibleRuntimeError(
            "模型返回了重复 Tool Call ID。",
            true,
            "invalid_response",
          );
        }
        seenCallIds.add(call.id);
        input.onToolEvent?.({
          type: "tool.requested",
          callId: call.id,
          toolName: call.name,
        });
        input.onToolEvent?.({
          type: "tool.started",
          callId: call.id,
          toolName: call.name,
        });
        let content: string;
        try {
          content = (await host.execute(call, input.signal)).content;
        } catch (error) {
          content = toolErrorContent(error);
        }
        input.onToolEvent?.({
          type: "tool.completed",
          callId: call.id,
          toolName: call.name,
        });
        entries.push({ call, rawContent: content });
      }
      const toolMessageOverhead = entries.reduce(
        (total, entry) => total + entry.call.id.length,
        0,
      );
      const desiredBatchChars = Math.min(
        this.config.maxOutputChars,
        entries.reduce((total, entry) => total + entry.rawContent.length, 0),
      );
      const requiredAdditionalChars = messageChars(assistantMessage)
        + toolMessageOverhead
        + desiredBatchChars
        + CONTEXT_PRESSURE_FINAL_STEP_INSTRUCTION.length;
      compactSeenBatchesUntil(
        messages,
        evidenceBatches,
        this.config.toolLoopMaxContextChars,
        requiredAdditionalChars,
        compactedBatchChars,
      );
      messages.push(assistantMessage);
      const remainingContextChars = Math.max(
        0,
        this.config.toolLoopMaxContextChars
          - contextChars(messages)
          - toolMessageOverhead
          - CONTEXT_PRESSURE_FINAL_STEP_INSTRUCTION.length,
      );
      const sharedBatchBudget = Math.min(
        this.config.maxOutputChars,
        remainingContextChars,
      );
      const budgets = allocateSharedBudgets(
        entries.map((entry) => entry.rawContent.length),
        sharedBatchBudget,
      );
      entries.forEach((entry, index) => {
        messages.push({
          role: "tool",
          toolCallId: entry.call.id,
          content: compactEvidence(entry, budgets[index] ?? 0),
        });
      });
      evidenceBatches.push({ entries });
      if (sharedBatchBudget < desiredBatchChars) {
        forceContextFinal = true;
      }
    }

    throw new OpenAICompatibleRuntimeError(
      "只读 ToolLoop 已达到最大工具轮数，尚未生成最终回复。",
      false,
      "tool_steps_exhausted",
    );
  }
}
