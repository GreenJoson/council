/**
 * @input  依赖：OpenAI 兼容 Provider 配置、API Key、公开 prompt 与 AbortSignal
 * @output 导出：有界远程 Chat Completions 生成器与可分类错误
 * @pos    DeepSeek、Kimi 及后续兼容 Provider 的统一网络运行时边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export class OpenAICompatibleRuntimeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly diagnosticCode: string,
  ) {
    super(message);
    this.name = "OpenAICompatibleRuntimeError";
  }
}

export interface OpenAICompatibleGenerateInput {
  baseUrl: string;
  model: string;
  apiKey: string;
  prompt: string;
  signal?: AbortSignal;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown };
  }>;
}

function completionEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", normalized);
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      text += decoder.decode();
      return text;
    }
    text += decoder.decode(chunk.value, { stream: true });
    if (text.length > maximum) {
      await reader.cancel();
      throw new OpenAICompatibleRuntimeError(
        "远程模型响应超过配置上限。",
        false,
        "output_limit",
      );
    }
  }
}

export class OpenAICompatibleRuntime {
  constructor(
    private readonly maxOutputChars: number,
    private readonly timeoutMs: number,
  ) {
    if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars <= 0) {
      throw new Error("远程模型输出上限必须是正整数。");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("远程模型超时必须是正整数。");
    }
  }

  async generate(input: OpenAICompatibleGenerateInput): Promise<string> {
    let response: Response;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    try {
      response = await fetch(completionEndpoint(input.baseUrl), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: input.prompt }],
          stream: false,
        }),
        signal,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        throw error;
      }
      if (timeoutSignal.aborted) {
        throw new OpenAICompatibleRuntimeError(
          "远程模型调用超时。",
          true,
          "timeout",
        );
      }
      throw new OpenAICompatibleRuntimeError(
        "远程模型网络请求失败。",
        true,
        "network_error",
      );
    }
    const body = await readBoundedText(response, this.maxOutputChars);
    if (!response.ok) {
      const diagnosticCode = response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 402
          ? "quota_exhausted"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "request_rejected";
      throw new OpenAICompatibleRuntimeError(
        "远程模型返回失败状态。",
        response.status === 429 || response.status >= 500,
        diagnosticCode,
      );
    }
    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(body) as ChatCompletionResponse;
    } catch {
      throw new OpenAICompatibleRuntimeError(
        "远程模型返回了无效 JSON。",
        true,
        "invalid_response",
      );
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new OpenAICompatibleRuntimeError(
        "远程模型没有返回可用内容。",
        true,
        "empty_response",
      );
    }
    return content.trim();
  }
}
