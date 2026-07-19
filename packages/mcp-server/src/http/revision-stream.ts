/**
 * @input  依赖：CouncilDatabase revision、Express SSE 连接与轮询配置
 * @output 导出：跨进程 council.changed 事件流
 * @pos    SQLite 共享写入到浏览器实时刷新之间的桥梁
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Request, Response } from "express";
import { CouncilDatabase } from "../database.js";
import { logger } from "../logger.js";
import { HttpError } from "./responses.js";
import { lastEventIdSchema } from "./schemas.js";

interface RevisionEvent {
  revision: number;
}

function writeChanged(response: Response, revision: number): void {
  const event: RevisionEvent = { revision };
  response.write(`id: ${String(revision)}\n`);
  response.write("event: council.changed\n");
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export class RevisionEventStream {
  readonly #database: CouncilDatabase;
  readonly #clients = new Set<Response>();
  readonly #pollTimer: NodeJS.Timeout;
  readonly #heartbeatTimer: NodeJS.Timeout;
  readonly #retryMs: number;
  #revision: number;
  #closed = false;

  constructor(
    database: CouncilDatabase,
    pollMs: number,
    retryMs: number,
    heartbeatMs: number,
  ) {
    this.#database = database;
    this.#retryMs = retryMs;
    this.#revision = database.getRevision();
    this.#pollTimer = setInterval(() => this.#poll(), pollMs);
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.#pollTimer.unref();
    this.#heartbeatTimer.unref();
  }

  handle(request: Request, response: Response): void {
    if (this.#closed) {
      throw new HttpError(503, "事件流正在关闭。");
    }
    const parsedLastEventId = lastEventIdSchema.safeParse(request.header("last-event-id"));
    if (!parsedLastEventId.success) {
      throw new HttpError(400, "Last-Event-ID 无效。");
    }
    const currentRevision = this.#refreshRevision();

    response.status(200);
    response.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    response.flushHeaders();
    response.write(`retry: ${String(this.#retryMs)}\n\n`);
    const lastEventId = parsedLastEventId.data;
    if (lastEventId === undefined || lastEventId !== currentRevision) {
      // ID 超前通常表示数据库已重置；发送当前值可让客户端回落并重新校准。
      writeChanged(response, currentRevision);
    }
    this.#clients.add(response);

    request.once("close", () => {
      this.#clients.delete(response);
    });
  }

  #poll(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#refreshRevision();
    } catch (error) {
      logger.error("http-events", "读取 SQLite revision 失败", error);
    }
  }

  #refreshRevision(): number {
    const revision = this.#database.getRevision();
    if (revision === this.#revision) {
      return revision;
    }
    this.#revision = revision;
    for (const client of this.#clients) {
      writeChanged(client, revision);
    }
    return revision;
  }

  #heartbeat(): void {
    if (this.#closed) {
      return;
    }
    for (const client of this.#clients) {
      client.write(": heartbeat\n\n");
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearInterval(this.#pollTimer);
    clearInterval(this.#heartbeatTimer);
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
  }
}
