/**
 * @input  依赖：OpenAICompatibleModelClient、公开 prompt、文本增量与 AbortSignal
 * @output 导出：向后兼容的纯文本生成器与共享远程错误类型
 * @pos    连接测试和旧调用的薄兼容层；正式远程 Agent 走 ReadOnlyAgentLoop
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  OpenAICompatibleModelClient,
  OpenAICompatibleRuntimeError,
} from "./openai-compatible-model-client.js";

export { OpenAICompatibleRuntimeError } from "./openai-compatible-model-client.js";

export interface OpenAICompatibleGenerateInput {
  baseUrl: string;
  model: string;
  apiKey: string;
  prompt: string;
  signal?: AbortSignal;
  onActivity?: () => void;
  onTextEvent?: (event:
    | { operation: "reset" }
    | { operation: "append"; content: string }
    | { operation: "replace"; content: string }
  ) => void;
}

export class OpenAICompatibleRuntime {
  readonly #client: OpenAICompatibleModelClient;

  constructor(maxOutputChars: number, timeoutMs: number) {
    this.#client = new OpenAICompatibleModelClient(maxOutputChars, timeoutMs);
  }

  async generate(input: OpenAICompatibleGenerateInput): Promise<string> {
    const result = await this.#client.complete({
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      messages: [{ role: "user", content: input.prompt }],
      signal: input.signal,
      onActivity: input.onActivity,
      onTextEvent: input.onTextEvent,
    });
    if (result.toolCalls.length > 0 || !result.content) {
      throw new OpenAICompatibleRuntimeError(
        "远程模型连接测试没有返回纯文本。",
        true,
        "invalid_response",
      );
    }
    return result.content;
  }
}
