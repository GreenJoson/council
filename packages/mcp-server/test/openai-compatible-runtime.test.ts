/**
 * @input  依赖：本地 HTTP 测试服务、OpenAICompatibleModelClient 与兼容 Runtime
 * @output 验证：兼容流式请求、Tool Call 增量、文本增量、JSON 回退、HTTP 安全原因与输出上限
 * @pos    DeepSeek/Kimi API ModelClient 与纯文本兼容层的协议回归测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { OpenAICompatibleModelClient } from "../src/openai-compatible-model-client.js";
import {
  OpenAICompatibleRuntime,
  OpenAICompatibleRuntimeError,
} from "../src/openai-compatible-runtime.js";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${String(address.port)}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("兼容运行时发送流式 Chat Completions 并转发公开文本增量", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-key");
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      const parsed: unknown = JSON.parse(requestBody);
      assert(parsed && typeof parsed === "object" && "stream" in parsed);
      assert.equal((parsed as { stream: unknown }).stream, true);
      response.setHeader("content-type", "text/event-stream");
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "  O" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "K  " } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  }, async (baseUrl) => {
    const runtime = new OpenAICompatibleRuntime(1_000, 5_000);
    const events: Array<{ operation: string; content?: string }> = [];
    let activityCount = 0;
    const content = await runtime.generate({
      baseUrl,
      model: "test-model",
      apiKey: "test-key",
      prompt: "test prompt",
      onActivity: () => {
        activityCount += 1;
      },
      onTextEvent: (event) => events.push(event),
    });
    assert.equal(content, "OK");
    assert.deepEqual(events, [
      { operation: "reset" },
      { operation: "append", content: "  O" },
      { operation: "append", content: "K  " },
    ]);
    assert.equal(activityCount, 3, "文本事件与 DONE 都应刷新远程 Runtime 活动时间");
  });
});

test("ModelClient 合并流式 Tool Call 并保留结构化 assistant 消息", async () => {
  await withServer((request, response) => {
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(requestBody) as {
        messages: Array<Record<string, unknown>>;
        tools?: unknown[];
      };
      assert.equal(parsed.tools?.length, 1);
      assert.equal(parsed.messages[0]?.role, "user");
      response.setHeader("content-type", "text/event-stream");
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-read",
              function: { name: "council_read_", arguments: "{\"path\":" },
            }],
          },
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "text_file", arguments: "\"src/a.ts\"}" },
            }],
          },
        }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  }, async (baseUrl) => {
    const client = new OpenAICompatibleModelClient(1_000, 5_000);
    const result = await client.complete({
      baseUrl,
      model: "test-model",
      apiKey: "test-key",
      messages: [{ role: "user", content: "读取代码" }],
      tools: [{
        type: "function",
        function: {
          name: "council_read_text_file",
          description: "读取",
          parameters: { type: "object" },
        },
      }],
    });
    assert.deepEqual(result, {
      content: "",
      toolCalls: [{
        id: "call-read",
        name: "council_read_text_file",
        arguments: "{\"path\":\"src/a.ts\"}",
      }],
    });
  });
});

test("兼容运行时兼容忽略 stream 参数后返回的普通 JSON", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "  fallback  " } }] }));
  }, async (baseUrl) => {
    const runtime = new OpenAICompatibleRuntime(1_000, 5_000);
    const events: Array<{ operation: string; content?: string }> = [];
    const content = await runtime.generate({
      baseUrl,
      model: "test-model",
      apiKey: "test-key",
      prompt: "test prompt",
      onTextEvent: (event) => events.push(event),
    });
    assert.equal(content, "fallback");
    assert.deepEqual(events, [{ operation: "replace", content: "fallback" }]);
  });
});

test("兼容运行时将认证失败分类为不可重试且不公开响应正文", async () => {
  await withServer((_request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: "sensitive upstream detail" } }));
  }, async (baseUrl) => {
    const runtime = new OpenAICompatibleRuntime(1_000, 5_000);
    await assert.rejects(
      runtime.generate({
        baseUrl,
        model: "test-model",
        apiKey: "test-key",
        prompt: "test prompt",
      }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAICompatibleRuntimeError);
        assert.equal(error.retryable, false);
        assert.equal(error.diagnosticCode, "authentication");
        assert.equal(error.message, "API Key 无效或已过期（HTTP 401），请检查 Provider 设置。");
        assert.equal(error.message.includes("sensitive upstream detail"), false);
        return true;
      },
    );
  });
});

test("兼容运行时将限流状态转换为可恢复的安全原因", async () => {
  await withServer((_request, response) => {
    response.statusCode = 429;
    response.end(JSON.stringify({ error: { message: "private rate-limit detail" } }));
  }, async (baseUrl) => {
    const runtime = new OpenAICompatibleRuntime(1_000, 5_000);
    await assert.rejects(
      runtime.generate({
        baseUrl,
        model: "test-model",
        apiKey: "test-key",
        prompt: "test prompt",
      }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAICompatibleRuntimeError);
        assert.equal(error.retryable, true);
        assert.equal(error.diagnosticCode, "rate_limited");
        assert.match(error.message, /Provider 已限流（HTTP 429）/);
        assert.equal(error.message.includes("private rate-limit detail"), false);
        return true;
      },
    );
  });
});

test("兼容运行时区分额度、权限、服务故障与请求参数", async () => {
  const cases = [
    { status: 402, code: "quota_exhausted", retryable: false, pattern: /API 额度不足/ },
    { status: 403, code: "authentication", retryable: false, pattern: /没有该模型或接口权限/ },
    { status: 503, code: "provider_unavailable", retryable: true, pattern: /服务暂时不可用/ },
    { status: 400, code: "request_rejected", retryable: false, pattern: /模型 ID、API 地址与参数兼容性/ },
  ] as const;
  for (const expected of cases) {
    await withServer((_request, response) => {
      response.statusCode = expected.status;
      response.end("private upstream response");
    }, async (baseUrl) => {
      const runtime = new OpenAICompatibleRuntime(1_000, 5_000);
      await assert.rejects(
        runtime.generate({
          baseUrl,
          model: "test-model",
          apiKey: "test-key",
          prompt: "test prompt",
        }),
        (error: unknown) => {
          assert.ok(error instanceof OpenAICompatibleRuntimeError);
          assert.equal(error.diagnosticCode, expected.code);
          assert.equal(error.retryable, expected.retryable);
          assert.match(error.message, expected.pattern);
          assert.equal(error.message.includes("private upstream response"), false);
          return true;
        },
      );
    });
  }
});

test("兼容运行时拒绝超过上限的远程响应", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(2_000) } }] })}\n\n`,
    );
  }, async (baseUrl) => {
    const runtime = new OpenAICompatibleRuntime(100, 5_000);
    await assert.rejects(
      runtime.generate({
        baseUrl,
        model: "test-model",
        apiKey: "test-key",
        prompt: "test prompt",
      }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAICompatibleRuntimeError);
        assert.equal(error.diagnosticCode, "output_limit");
        return true;
      },
    );
  });
});

test("兼容运行时对无响应 Provider 使用有界超时", async () => {
  await withServer(() => {
    // 故意不结束响应，验证内部 timeout signal 能终止 fetch。
  }, async (baseUrl) => {
    const runtime = new OpenAICompatibleRuntime(1_000, 20);
    await assert.rejects(
      runtime.generate({
        baseUrl,
        model: "test-model",
        apiKey: "test-key",
        prompt: "test prompt",
      }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAICompatibleRuntimeError);
        assert.equal(error.diagnosticCode, "timeout");
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });
});
