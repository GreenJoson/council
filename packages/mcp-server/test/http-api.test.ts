/**
 * @input  依赖：隔离 HTTP 服务、REST 客户端与 canonical 请求体
 * @output 导出：REST 成功、错误、CORS、安全头和限流集成测试
 * @pos    WebUI 本地 API 契约与安全基线的端到端验证
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { CouncilMessage, Decision, PaginatedTopics, Topic, TopicDetail } from "../src/types.js";
import {
  readEnvelope,
  startHttpHarness,
  TEST_ALLOWED_ORIGIN,
  TEST_BLOCKED_ORIGIN,
} from "./http-harness.js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Origin: TEST_ALLOWED_ORIGIN,
};

test("REST API 完成议题、消息和决策 canonical 生命周期", async () => {
  const harness = await startHttpHarness();
  try {
    const statusResponse = await fetch(`${harness.baseUrl}/api/v1/status`, {
      headers: { Origin: TEST_ALLOWED_ORIGIN },
    });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("access-control-allow-origin"), TEST_ALLOWED_ORIGIN);
    assert.equal(statusResponse.headers.get("x-powered-by"), null);
    assert.equal(statusResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(statusResponse.headers.get("x-frame-options"), "SAMEORIGIN");

    const createResponse = await fetch(`${harness.baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: "会话同步",
        question: "如何让两个客户端共享讨论？",
        constraints: ["支持增量刷新"],
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await readEnvelope<Topic>(createResponse);
    assert.equal(created.code, 0);
    assert.equal(created.data?.title, "会话同步");
    const topicId = created.data?.id;
    assert(topicId);

    const listResponse = await fetch(
      `${harness.baseUrl}/api/v1/topics?limit=10&offset=0`,
      { headers: { Origin: TEST_ALLOWED_ORIGIN } },
    );
    const page = await readEnvelope<PaginatedTopics>(listResponse);
    assert.equal(page.data?.total, 1);
    assert.equal(page.data?.topics[0]?.id, topicId);

    const messageResponse = await fetch(
      `${harness.baseUrl}/api/v1/topics/${topicId}/messages`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          kind: "proposal",
          content: "用共享 SQLite revision 驱动刷新。",
        }),
      },
    );
    assert.equal(messageResponse.status, 201);
    const message = await readEnvelope<CouncilMessage>(messageResponse);
    assert.equal(message.data?.topicId, topicId);
    assert.equal(message.data?.author, "human");

    const decisionResponse = await fetch(
      `${harness.baseUrl}/api/v1/topics/${topicId}/decisions`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          title: "采用本地事件流",
          decision: "使用 SQLite revision 与 SSE。",
          rationale: "跨进程且无需外部服务。",
          alternatives: ["手工刷新"],
          status: "accepted",
        }),
      },
    );
    assert.equal(decisionResponse.status, 201);
    const decision = await readEnvelope<Decision>(decisionResponse);
    assert.equal(decision.data?.status, "accepted");
    assert.equal(decision.data?.createdBy, "human");

    const detailResponse = await fetch(
      `${harness.baseUrl}/api/v1/topics/${topicId}?messageLimit=10&messageOffset=0`,
    );
    const detail = await readEnvelope<TopicDetail>(detailResponse);
    assert.equal(detail.data?.topic.status, "decided");
    assert.equal(detail.data?.messages.length, 1);
    assert.equal(detail.data?.decisions.length, 1);
  } finally {
    await harness.close();
  }
});

test("REST API 拒绝非法输入、跨议题父消息和非白名单来源", async () => {
  const harness = await startHttpHarness();
  try {
    const invalidResponse = await fetch(`${harness.baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: " ", question: "有效问题", unknown: true }),
    });
    assert.equal(invalidResponse.status, 400);
    const invalid = await readEnvelope(invalidResponse);
    assert.equal(invalid.code, 400);
    assert.match(invalid.message, /校验/);

    const unknownFieldResponse = await fetch(`${harness.baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: "有效标题",
        question: "严格 schema 是否拒绝未知字段？",
        constraints: [],
        unknown: true,
      }),
    });
    assert.equal(unknownFieldResponse.status, 400);

    const malformedResponse = await fetch(`${harness.baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{",
    });
    assert.equal(malformedResponse.status, 400);
    const malformed = await readEnvelope(malformedResponse);
    assert.equal(malformed.message, "请求体不是合法 JSON。");

    const invalidProjectResponse = await fetch(`${harness.baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: "无效项目路径",
        question: "不存在的项目目录应如何处理？",
        projectPath: path.join(harness.directory, "missing"),
      }),
    });
    assert.equal(invalidProjectResponse.status, 400);
    const invalidProject = await readEnvelope(invalidProjectResponse);
    assert.equal(invalidProject.message, "项目路径不存在或不是文件夹。");

    const blockedResponse = await fetch(`${harness.baseUrl}/api/v1/status`, {
      headers: { Origin: TEST_BLOCKED_ORIGIN },
    });
    assert.equal(blockedResponse.status, 403);
    assert.equal(blockedResponse.headers.get("access-control-allow-origin"), null);

    const preflightResponse = await fetch(`${harness.baseUrl}/api/v1/topics`, {
      method: "OPTIONS",
      headers: {
        Origin: TEST_ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(preflightResponse.status, 204);
    assert.equal(
      preflightResponse.headers.get("access-control-allow-origin"),
      TEST_ALLOWED_ORIGIN,
    );

    const firstTopic = harness.database.createTopic({
      title: "议题一",
      question: "父消息在哪个议题？",
      constraints: [],
      createdBy: "human",
    });
    const secondTopic = harness.database.createTopic({
      title: "议题二",
      question: "能否跨议题引用？",
      constraints: [],
      createdBy: "human",
    });
    const forgedTopicResponse = await fetch(`${harness.baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: "伪造创建者",
        question: "浏览器能否伪造创建者？",
        constraints: [],
        createdBy: "claude",
      }),
    });
    assert.equal(forgedTopicResponse.status, 400);
    assert.equal(harness.database.listTopics({ limit: 100, offset: 0 }).total, 2);

    const forgedMessageResponse = await fetch(
      `${harness.baseUrl}/api/v1/topics/${firstTopic.id}/messages`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          author: "codex",
          kind: "note",
          content: "伪造作者不得写入。",
        }),
      },
    );
    assert.equal(forgedMessageResponse.status, 400);
    assert.equal(harness.database.getTopicDetail(firstTopic.id, 20).messageTotal, 0);

    const forgedDecisionResponse = await fetch(
      `${harness.baseUrl}/api/v1/topics/${firstTopic.id}/decisions`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          title: "越权接受",
          decision: "Agent 不得代替用户接受决策。",
          rationale: "用于验证身份边界。",
          alternatives: [],
          status: "accepted",
          createdBy: "claude",
        }),
      },
    );
    assert.equal(forgedDecisionResponse.status, 400);
    assert.equal(
      harness.database.getTopicDetail(firstTopic.id, 20).decisions.length,
      0,
    );

    const parent = harness.database.createMessage({
      topicId: firstTopic.id,
      author: "claude",
      kind: "proposal",
      content: "父消息",
    });
    const conflictResponse = await fetch(
      `${harness.baseUrl}/api/v1/topics/${secondTopic.id}/messages`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          kind: "critique",
          content: "错误引用",
          parentMessageId: parent.id,
        }),
      },
    );
    assert.equal(conflictResponse.status, 409);
    const conflict = await readEnvelope(conflictResponse);
    assert.equal(conflict.code, 409);
  } finally {
    await harness.close();
  }
});

test("REST API 统一限流且 5xx 不泄漏内部错误", async () => {
  const limited = await startHttpHarness({ rateLimitMax: 2 });
  try {
    assert.equal((await fetch(`${limited.baseUrl}/api/v1/status`)).status, 200);
    assert.equal((await fetch(`${limited.baseUrl}/api/v1/status`)).status, 200);
    const limitedResponse = await fetch(`${limited.baseUrl}/api/v1/status`);
    assert.equal(limitedResponse.status, 429);
    const envelope = await readEnvelope(limitedResponse);
    assert.equal(envelope.code, 429);
  } finally {
    await limited.close();
  }

  const broken = await startHttpHarness();
  try {
    broken.database.close();
    const response = await fetch(`${broken.baseUrl}/api/v1/status`);
    assert.equal(response.status, 500);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.message, "服务器内部错误。");
    assert.doesNotMatch(JSON.stringify(envelope), /database|sqlite|closed/i);
  } finally {
    await broken.close();
  }
});
