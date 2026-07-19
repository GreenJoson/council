/**
 * @input  依赖：SSE 客户端、两个 CouncilDatabase 连接与共享 SQLite 文件
 * @output 导出：跨连接 revision 触发 council.changed 的集成测试
 * @pos    自动显示另一 MCP 进程回帖能力的关键验收
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CouncilDatabase } from "../src/database.js";
import { startHttpHarness, TEST_ALLOWED_ORIGIN } from "./http-harness.js";

interface ChangedEvent {
  revision: number;
}

class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async nextBlock(): Promise<string> {
    while (true) {
      const boundary = this.#buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const block = this.#buffer.slice(0, boundary);
        this.#buffer = this.#buffer.slice(boundary + 2);
        return block;
      }

      const chunk = await this.#reader.read();
      if (chunk.done) {
        throw new Error("SSE 在收到完整事件前结束。");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async nextChanged(): Promise<ChangedEvent> {
    while (true) {
      const lines = (await this.nextBlock()).split("\n");
      if (!lines.includes("event: council.changed")) {
        continue;
      }
      const dataLine = lines.find((line) => line.startsWith("data: "));
      assert(dataLine);
      const value: unknown = JSON.parse(dataLine.slice("data: ".length));
      assert(value && typeof value === "object" && "revision" in value);
      const revision = (value as { revision: unknown }).revision;
      if (typeof revision !== "number") {
        throw new Error("SSE revision 必须是数字。");
      }
      return { revision };
    }
  }
}

test("SSE 侦测另一个数据库连接写入并发送 council.changed", async () => {
  const harness = await startHttpHarness({ eventPollMs: 10, eventRetryMs: 4_321 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  let otherProcess: CouncilDatabase | undefined;
  try {
    const topic = harness.database.createTopic({
      title: "跨连接回帖",
      question: "另一 MCP 连接的消息能否触发事件？",
      constraints: [],
      createdBy: "human",
    });
    const response = await fetch(`${harness.baseUrl}/api/v1/events`, {
      headers: { Origin: TEST_ALLOWED_ORIGIN },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert(response.body);
    const reader = new SseReader(response.body);
    assert.equal(await reader.nextBlock(), "retry: 4321");
    const initial = await reader.nextChanged();

    otherProcess = new CouncilDatabase(harness.databasePath, 5_000);
    const reply = otherProcess.createMessage({
      topicId: topic.id,
      author: "claude",
      kind: "proposal",
      content: "来自另一个数据库连接的回帖。",
    });
    const changed = await reader.nextChanged();
    assert(changed.revision > initial.revision);
    assert.equal(changed.revision, otherProcess.getRevision());
    assert.equal(harness.database.getTopicDetail(topic.id, 20).messages[0]?.id, reply.id);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    otherProcess?.close();
    await harness.close();
  }
});

async function readInitialChanged(
  baseUrl: string,
  lastEventId: number,
): Promise<ChangedEvent> {
  const controller = new AbortController();
  try {
    const response = await fetch(`${baseUrl}/api/v1/events`, {
      headers: {
        Origin: TEST_ALLOWED_ORIGIN,
        "Last-Event-ID": String(lastEventId),
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert(response.body);
    const reader = new SseReader(response.body);
    await reader.nextBlock();
    return await reader.nextChanged();
  } finally {
    controller.abort();
  }
}

test("SSE 按 Last-Event-ID 去重、追赶并从数据库重置中恢复", async () => {
  const harness = await startHttpHarness({ eventPollMs: 10, eventHeartbeatMs: 1_000 });
  try {
    harness.database.createTopic({
      title: "重连语义",
      question: "Last-Event-ID 如何与 revision 对齐？",
      constraints: [],
      createdBy: "human",
    });
    const current = harness.database.getRevision();
    assert(current > 0);

    const equalController = new AbortController();
    const equalResponse = await fetch(`${harness.baseUrl}/api/v1/events`, {
      headers: {
        Origin: TEST_ALLOWED_ORIGIN,
        "Last-Event-ID": String(current),
      },
      signal: equalController.signal,
    });
    assert(equalResponse.body);
    const equalReader = new SseReader(equalResponse.body);
    await equalReader.nextBlock();
    const pendingChanged = equalReader.nextChanged();
    const outcome = await Promise.race([
      pendingChanged.then(() => "changed" as const),
      new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), 80)),
    ]);
    assert.equal(outcome, "quiet");
    equalController.abort();
    await pendingChanged.catch(() => undefined);

    const behind = await readInitialChanged(harness.baseUrl, current - 1);
    assert.equal(behind.revision, current);

    const ahead = await readInitialChanged(harness.baseUrl, current + 1);
    assert.equal(ahead.revision, current);

    const invalidResponse = await fetch(`${harness.baseUrl}/api/v1/events`, {
      headers: { Origin: TEST_ALLOWED_ORIGIN, "Last-Event-ID": "invalid" },
    });
    assert.equal(invalidResponse.status, 400);
    const invalid: unknown = await invalidResponse.json();
    assert(invalid && typeof invalid === "object" && "message" in invalid);
    assert.equal((invalid as { message: unknown }).message, "Last-Event-ID 无效。");
  } finally {
    await harness.close();
  }
});
