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
      const result = await this.client.complete({
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        messages,
        ...(host ? { tools: host.definitions } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onTextEvent ? { onTextEvent: input.onTextEvent } : {}),
      });
      if (result.toolCalls.length === 0) {
        return result.content;
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
