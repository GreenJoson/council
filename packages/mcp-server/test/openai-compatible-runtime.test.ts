/**
 * @input  依赖：本地 HTTP 测试服务与 OpenAICompatibleRuntime
 * @output 验证：兼容请求、响应提取、认证分类与输出上限
 * @pos    DeepSeek/Kimi 统一远程运行时的协议回归测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
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

test("兼容运行时发送标准 Chat Completions 并提取正文", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-key");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "  OK  " } }] }));
  }, async (baseUrl) => {
    const runtime = new OpenAICompatibleRuntime(1_000, 5_000);
    const content = await runtime.generate({
      baseUrl,
      model: "test-model",
      apiKey: "test-key",
      prompt: "test prompt",
    });
    assert.equal(content, "OK");
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
        assert.equal(error.message.includes("sensitive upstream detail"), false);
        return true;
      },
    );
  });
});

test("兼容运行时拒绝超过上限的远程响应", async () => {
  await withServer((_request, response) => {
    response.end(JSON.stringify({ choices: [{ message: { content: "x".repeat(2_000) } }] }));
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
