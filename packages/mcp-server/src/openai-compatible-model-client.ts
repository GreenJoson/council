/**
 * @input  依赖：OpenAI-compatible Chat Completions、消息、只读工具定义与 AbortSignal
 * @output 导出：有界 ModelClient、公开文本增量、结构化 Tool Call 与按 HTTP 状态脱敏的错误原因
 * @pos    Provider 通信层；不访问项目文件、不执行工具、不管理 Council 状态
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

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelClientInput {
  baseUrl: string;
  model: string;
  apiKey: string;
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  signal?: AbortSignal;
  onActivity?: () => void;
  onTextEvent?: (event:
    | { operation: "reset" }
    | { operation: "append"; content: string }
    | { operation: "replace"; content: string }
  ) => void;
}

export interface ModelClientResult {
  content: string;
  toolCalls: ModelToolCall[];
}

interface ApiToolCall {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

const TRANSPORT_BUFFER_MULTIPLIER = 8;

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
  const diagnostic = status === 401
    ? {
        code: "authentication",
        message: "API Key 无效或已过期（HTTP 401），请检查 Provider 设置。",
      }
    : status === 403
      ? {
          code: "authentication",
          message: "API Key 没有该模型或接口权限（HTTP 403），请检查 Provider 账户权限。",
        }
      : status === 402
        ? {
            code: "quota_exhausted",
            message: "Provider API 额度不足或账户欠费（HTTP 402），请检查账户余额与套餐。",
          }
        : status === 429
          ? {
              code: "rate_limited",
              message: "Provider 已限流（HTTP 429）：可能达到请求速率、Token 速率、并发或账户限制，请稍后恢复并检查 Provider 控制台。",
            }
          : status >= 500
            ? {
                code: "provider_unavailable",
                message: `Provider 服务暂时不可用（HTTP ${String(status)}），请稍后恢复。`,
              }
            : {
                code: "request_rejected",
                message: `Provider 拒绝了请求（HTTP ${String(status)}），请检查模型 ID、API 地址与参数兼容性。`,
              };
  return new OpenAICompatibleRuntimeError(
    diagnostic.message,
    status === 429 || status >= 500,
    diagnostic.code,
  );
}

function apiMessages(messages: readonly ModelMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: call.arguments,
                },
              })),
            }
          : {}),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    return { role: message.role, content: message.content };
  });
}

function parseToolCalls(value: unknown): ModelToolCall[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new OpenAICompatibleRuntimeError(
      "远程模型返回了无效 Tool Call。",
      true,
      "invalid_response",
    );
  }
  return value.map((raw) => {
    const call = raw as ApiToolCall;
    const id = call.id;
    const name = call.function?.name;
    const args = call.function?.arguments;
    if (
      typeof id !== "string"
      || !id
      || typeof name !== "string"
      || !name
      || typeof args !== "string"
    ) {
      throw new OpenAICompatibleRuntimeError(
        "远程模型返回了不完整的 Tool Call。",
        true,
        "invalid_response",
      );
    }
    return { id, name, arguments: args };
  });
}

function parseCompletionBody(body: string): ModelClientResult {
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
  const message = parsed.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = parseToolCalls(message?.tool_calls);
  if (!content.trim() && toolCalls.length === 0) {
    throw new OpenAICompatibleRuntimeError(
      "远程模型没有返回可用内容或 Tool Call。",
      true,
      "empty_response",
    );
  }
  return { content: content.trim(), toolCalls };
}

function appendBounded(
  current: string,
  delta: string,
  maximum: number,
): string {
  if (current.length + delta.length > maximum) {
    throw new OpenAICompatibleRuntimeError(
      "远程模型响应超过配置上限。",
      false,
      "output_limit",
    );
  }
  return current + delta;
}

async function readStreamingCompletion(
  response: Response,
  maximum: number,
  onTextEvent?: ModelClientInput["onTextEvent"],
  onActivity?: ModelClientInput["onActivity"],
): Promise<ModelClientResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OpenAICompatibleRuntimeError(
      "远程模型没有返回可读响应流。",
      true,
      "invalid_response",
    );
  }

  const decoder = new TextDecoder();
  const maximumEventBuffer = maximum * TRANSPORT_BUFFER_MULTIPLIER;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let lineBuffer = "";
  let eventData: string[] = [];
  let content = "";
  let transportChars = 0;
  let completed = false;
  onTextEvent?.({ operation: "reset" });

  const processToolDeltas = (value: unknown): void => {
    if (value === undefined || value === null) {
      return;
    }
    if (!Array.isArray(value)) {
      throw new OpenAICompatibleRuntimeError(
        "远程模型返回了无效流式 Tool Call。",
        true,
        "invalid_response",
      );
    }
    for (const raw of value) {
      if (!raw || typeof raw !== "object") {
        throw new OpenAICompatibleRuntimeError(
          "远程模型返回了无效流式 Tool Call。",
          true,
          "invalid_response",
        );
      }
      const delta = raw as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (!Number.isSafeInteger(delta.index) || Number(delta.index) < 0) {
        throw new OpenAICompatibleRuntimeError(
          "远程模型返回了无效 Tool Call 索引。",
          true,
          "invalid_response",
        );
      }
      const index = Number(delta.index);
      const accumulator = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof delta.id === "string" && delta.id) {
        accumulator.id ||= delta.id;
      }
      if (typeof delta.function?.name === "string") {
        accumulator.name = appendBounded(
          accumulator.name,
          delta.function.name,
          maximum,
        );
        transportChars += delta.function.name.length;
      }
      if (typeof delta.function?.arguments === "string") {
        accumulator.arguments = appendBounded(
          accumulator.arguments,
          delta.function.arguments,
          maximum,
        );
        transportChars += delta.function.arguments.length;
      }
      if (transportChars > maximum) {
        throw new OpenAICompatibleRuntimeError(
          "远程模型 Tool Call 超过配置上限。",
          false,
          "output_limit",
        );
      }
      toolCalls.set(index, accumulator);
    }
  };

  const processEvent = (): void => {
    if (eventData.length === 0) {
      return;
    }
    const data = eventData.join("\n").trim();
    eventData = [];
    if (!data) {
      return;
    }
    onActivity?.();
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
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      content = appendBounded(content, delta.content, maximum);
      transportChars += delta.content.length;
      onTextEvent?.({ operation: "append", content: delta.content });
    }
    processToolDeltas(delta?.tool_calls);
  };

  const processLines = (flush: boolean): void => {
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

  const parsedToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.id || !call.name) {
        throw new OpenAICompatibleRuntimeError(
          "远程模型返回了不完整的流式 Tool Call。",
          true,
          "invalid_response",
        );
      }
      return {
        id: call.id,
        name: call.name,
        arguments: call.arguments || "{}",
      };
    });
  if (!content.trim() && parsedToolCalls.length === 0) {
    throw new OpenAICompatibleRuntimeError(
      "远程模型没有返回可用内容或 Tool Call。",
      true,
      "empty_response",
    );
  }
  return { content: content.trim(), toolCalls: parsedToolCalls };
}

export class OpenAICompatibleModelClient {
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

  async complete(input: ModelClientInput): Promise<ModelClientResult> {
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
          messages: apiMessages(input.messages),
          stream: true,
          ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
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
        const body = await readBoundedText(
          response,
          this.maxOutputChars * TRANSPORT_BUFFER_MULTIPLIER,
        );
        const result = parseCompletionBody(body);
        if (result.content) {
          input.onTextEvent?.({ operation: "replace", content: result.content });
        }
        return result;
      }
      return await readStreamingCompletion(
        response,
        this.maxOutputChars,
        input.onTextEvent,
        input.onActivity,
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
