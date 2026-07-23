/**
 * @input  依赖：OpenAI 兼容 Provider 配置、API Key、公开 prompt、文本增量监听与 AbortSignal
 * @output 导出：有界流式 Chat Completions 生成器与可分类错误
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
  onTextEvent?: (event:
    | { operation: "reset" }
    | { operation: "append"; content: string }
    | { operation: "replace"; content: string }
  ) => void;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown };
  }>;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: unknown };
  }>;
}

const SSE_EVENT_BUFFER_MULTIPLIER = 8;

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

function classifyResponseStatus(status: number): OpenAICompatibleRuntimeError {
  const diagnosticCode = status === 401 || status === 403
    ? "authentication"
    : status === 402
      ? "quota_exhausted"
      : status === 429
        ? "rate_limited"
        : status >= 500
          ? "provider_unavailable"
          : "request_rejected";
  return new OpenAICompatibleRuntimeError(
    "远程模型返回失败状态。",
    status === 429 || status >= 500,
    diagnosticCode,
  );
}

function parseCompletionBody(body: string): string {
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

async function readStreamingCompletion(
  response: Response,
  maximum: number,
  onTextEvent?: OpenAICompatibleGenerateInput["onTextEvent"],
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OpenAICompatibleRuntimeError(
      "远程模型没有返回可读响应流。",
      true,
      "invalid_response",
    );
  }

  const decoder = new TextDecoder();
  const maximumEventBuffer = maximum * SSE_EVENT_BUFFER_MULTIPLIER;
  let lineBuffer = "";
  let eventData: string[] = [];
  let content = "";
  let completed = false;
  onTextEvent?.({ operation: "reset" });

  const processEvent = () => {
    if (eventData.length === 0) {
      return;
    }
    const data = eventData.join("\n").trim();
    eventData = [];
    if (!data) {
      return;
    }
    if (data === "[DONE]") {
      completed = true;
      return;
    }

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch {
      throw new OpenAICompatibleRuntimeError(
        "远程模型返回了无效流式事件。",
        true,
        "invalid_response",
      );
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta !== "string" || !delta) {
      return;
    }
    if (content.length + delta.length > maximum) {
      throw new OpenAICompatibleRuntimeError(
        "远程模型响应超过配置上限。",
        false,
        "output_limit",
      );
    }
    content += delta;
    onTextEvent?.({ operation: "append", content: delta });
  };

  const processLines = (flush: boolean) => {
    while (true) {
      const boundary = lineBuffer.indexOf("\n");
      if (boundary < 0) {
        break;
      }
      const rawLine = lineBuffer.slice(0, boundary);
      lineBuffer = lineBuffer.slice(boundary + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) {
        processEvent();
      } else if (line.startsWith("data:")) {
        eventData.push(line.slice("data:".length).trimStart());
      }
    }
    if (lineBuffer.length > maximumEventBuffer) {
      throw new OpenAICompatibleRuntimeError(
        "远程模型流式事件超过配置上限。",
        false,
        "output_limit",
      );
    }
    if (flush) {
      if (lineBuffer.startsWith("data:")) {
        eventData.push(lineBuffer.slice("data:".length).trimStart());
      }
      lineBuffer = "";
      processEvent();
    }
  };

  while (!completed) {
    const chunk = await reader.read();
    if (chunk.done) {
      lineBuffer += decoder.decode();
      processLines(true);
      break;
    }
    lineBuffer += decoder.decode(chunk.value, { stream: true });
    processLines(false);
  }

  if (!content.trim()) {
    throw new OpenAICompatibleRuntimeError(
      "远程模型没有返回可用内容。",
      true,
      "empty_response",
    );
  }
  return content.trim();
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
          stream: true,
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
    if (!response.ok) {
      await readBoundedText(response, this.maxOutputChars);
      throw classifyResponseStatus(response.status);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    try {
      if (!contentType.includes("text/event-stream")) {
        const body = await readBoundedText(response, this.maxOutputChars);
        const content = parseCompletionBody(body);
        input.onTextEvent?.({ operation: "replace", content });
        return content;
      }
      return await readStreamingCompletion(
        response,
        this.maxOutputChars,
        input.onTextEvent,
      );
    } catch (error) {
      if (error instanceof OpenAICompatibleRuntimeError) {
        throw error;
      }
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
        "远程模型响应流读取失败。",
        true,
        "network_error",
      );
    }
  }
}
