/**
 * @input  依赖：OpenAICompatibleModelClient、ReadOnlyToolHost、项目路径与 ToolLoop 配置
 * @output 导出：模型请求→只读工具→结果回填→最终公开文本的有界 AgentLoop
 * @pos    Council-owned Runtime；模型只选择工具，工具执行与安全边界始终归 Council
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  OpenAICompatibleModelClient,
  OpenAICompatibleRuntimeError,
  type ModelMessage,
} from "./openai-compatible-model-client.js";
import {
  ReadOnlyToolHost,
  ReadOnlyToolHostError,
} from "./read-only-tool-host.js";
import { ReadOnlyGitDiffError } from "./read-only-git-diff.js";
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
  signal?: AbortSignal;
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

export class ReadOnlyAgentLoop {
  constructor(
    private readonly client: OpenAICompatibleModelClient,
    private readonly config: CouncilConfig,
  ) {}

  async generate(input: ReadOnlyAgentLoopInput): Promise<string> {
    const host = input.projectPath
      ? await ReadOnlyToolHost.create(input.projectPath, this.config)
      : undefined;
    const messages: ModelMessage[] = [
      { role: "user", content: input.prompt },
    ];

    for (let step = 1; step <= this.config.toolLoopMaxSteps; step += 1) {
      if (contextChars(messages) > this.config.toolLoopMaxContextChars) {
        throw new OpenAICompatibleRuntimeError(
          "只读 ToolLoop 上下文超过配置上限。",
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
      const finalStep = step === this.config.toolLoopMaxSteps;
      if (finalStep && host) {
        messages.push({ role: "user", content: FINAL_STEP_INSTRUCTION });
      }
      const result = await this.client.complete({
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        messages,
        ...(host && !finalStep ? { tools: host.definitions } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
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
        return result.content;
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
      messages.push({
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      });
      const seenCallIds = new Set<string>();
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
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content,
        });
      }
    }

    throw new OpenAICompatibleRuntimeError(
      "只读 ToolLoop 已达到最大工具轮数，尚未生成最终回复。",
      false,
      "tool_steps_exhausted",
    );
  }
}
