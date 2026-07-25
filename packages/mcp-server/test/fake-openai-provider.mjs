/**
 * @input  依赖：COUNCIL_FAKE_PROVIDER_PORT 与 OpenAI Chat Completions 流式请求
 * @output 导出：按模型返回可识别公开文本增量的 loopback 测试 Provider
 * @pos    动态远程 Provider/双 Agent 热加载与恢复边界的跨进程 E2E 替身
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createServer } from "node:http";

const port = Number(process.env.COUNCIL_FAKE_PROVIDER_PORT);
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  throw new Error("COUNCIL_FAKE_PROVIDER_PORT 必须是有效端口。");
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== "Bearer e2e-example-key") {
    response.writeHead(401).end();
    return;
  }
  let payload;
  try {
    payload = await readJson(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const model = typeof payload?.model === "string" ? payload.model : "";
  if (model === "failure-model") {
    response.writeHead(503).end();
    return;
  }
  const reply = model === "router-model-beta"
    ? "远程 Beta Agent 已完成即时调用。"
    : "远程 Alpha Agent 已完成即时调用。";
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const midpoint = Math.ceil(reply.length / 2);
  for (const content of [reply.slice(0, midpoint), reply.slice(midpoint)]) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});

server.listen(port, "localhost");

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
