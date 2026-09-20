/**
 * @input  依赖：临时 Git 仓库、Claude/Codex 假 CLI、Model Router 与委派管理器
 * @output 验证：委派闭环、Council 提交、人工验收、超限文件保留与分类审计、提交/草稿恢复和 checkout 隔离
 * @pos    Agent 互相指挥并实际改代码的端到端安全回归
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { RuntimeAuditStore } from "../src/orchestration/runtime-audit-store.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SecretStore } from "../src/keychain-secret-store.js";
import { ClaudeRuntime } from "../src/claude-runtime.js";
import { CodexRuntime } from "../src/codex-runtime.js";
import { CouncilDatabase } from "../src/database.js";
import { ModelRouterService } from "../src/model-router-service.js";
import { ModelRouterStore } from "../src/model-router-store.js";
import { WorkItemDelegationManager } from "../src/orchestration/work-item-delegation-manager.js";
import { WorkItemDelegationStore } from "../src/orchestration/work-item-delegation-store.js";
import type { CouncilConfig } from "../src/types.js";

class EmptySecretStore implements SecretStore {
  async has(): Promise<boolean> { return false; }
  async get(): Promise<undefined> { return undefined; }
  async set(): Promise<void> { return undefined; }
  async delete(): Promise<boolean> { return true; }
}

const CLAUDE_SCRIPT = String.raw`
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const prompt = readFileSync(0, "utf8");
appendFileSync(process.argv[2], prompt + "\n---CALL---\n");
if (prompt.includes("你是本次任务的 executor")) {
  const target = prompt.includes("第二个串行任务") ? "second.txt" : "implemented.txt";
  writeFileSync(path.join(process.cwd(), target), "delegated by claude\n");
}
const content = prompt.includes("只返回一个 JSON 对象")
  ? JSON.stringify({ verdict: "approved", summary: "实现符合当前任务。", findings: [] })
  : prompt.includes("你是本次任务的 executor")
    ? "已新增目标文件并验证内容。"
    : prompt.includes("第二个串行任务")
      ? "第二个串行任务：只新增 second.txt 并确认内容可读取。"
      : "只新增目标文件并确认内容可读取；不得修改其他文件。";
process.stdout.write(JSON.stringify({
  type: "result",
  result: content,
  session_id: "claude-delegation-session",
  is_error: false
}));
`;

const CODEX_SCRIPT = String.raw`
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const prompt = readFileSync(0, "utf8");
appendFileSync(process.argv[2], prompt + "\n---CALL---\n");
if (prompt.includes("你是本次任务的 executor")) {
  const target = prompt.includes("第二个串行任务") ? "second.txt" : "implemented.txt";
  writeFileSync(path.join(process.cwd(), target), "delegated by codex\n");
}
const content = prompt.includes("只返回一个 JSON 对象")
  ? JSON.stringify({ verdict: "approved", summary: "实现符合当前任务。", findings: [] })
  : prompt.includes("你是本次任务的 executor")
    ? "已新增目标文件并验证内容。"
    : prompt.includes("第二个串行任务")
      ? "第二个串行任务：只新增 second.txt 并确认内容可读取。"
      : "只新增目标文件并确认内容可读取；不得修改其他文件。";
const events = [
  { type: "thread.started", thread_id: "codex-delegation-session" },
  { type: "item.completed", item: { type: "agent_message", text: content } }
];
process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createConfig(directory: string, databasePath: string, claudeScript: string, codexScript: string, claudeLog: string, codexLog: string): CouncilConfig {
  return {
    dataDir: directory,
    databasePath,
    delegationWorktreeRoot: path.join(directory, "delegated-worktrees"),
    delegationRetryDelayMs: 1,
    claudeCommand: process.execPath,
    claudeArgs: [claudeScript, claudeLog],
    claudePermissionMode: "plan",
    claudeTimeoutMs: 5_000,
    claudeKillGraceMs: 50,
    claudeMaxTurns: 3,
    codexCommand: process.execPath,
    codexArgs: [codexScript, codexLog],
    codexSandboxMode: "read-only",
    codexTimeoutMs: 5_000,
    codexKillGraceMs: 50,
    kimiAcpCommand: process.execPath,
    geminiAcpCommand: process.execPath,
    grokAcpCommand: process.execPath,
    codexAcpCommand: process.execPath,
    claudeAcpCommand: process.execPath,
    acpStartupTimeoutMs: 5_000,
    acpKillGraceMs: 50,
    acpMaxFileReadChars: 10_000,
    toolLoopMaxSteps: 4,
    toolLoopMaxContextChars: 20_000,
    toolLoopMaxFileBytes: 10_000,
    toolLoopMaxScanFiles: 100,
    gitCommand: "git",
    gitDiffTimeoutMs: 5_000,
    gitDiffKillGraceMs: 50,
    gitDiffMaxFiles: 20,
    gitDiffMaxLines: 200,
    gitDiffMaxHunksPerFile: 20,
    delegationGitMaxOutputChars: 1_000_000,
    gitDiffMaxOutputChars: 100_000,
    sqliteBusyTimeoutMs: 5_000,
    schemaMigrationMaxAttempts: 3,
    maxContextChars: 20_000,
    maxOutputChars: 20_000,
    cliMaxStreamChars: 32_000_000,
    defaultMessageLimit: 100,
  };
}

async function waitForTerminal(
  manager: WorkItemDelegationManager,
  topicId: string,
  delegationId: string,
) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const current = manager.list(topicId).find((item) => item.id === delegationId);
    if (current && ["approved", "failed", "cancelled"].includes(current.status)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("委派测试等待超时。");
}

async function createDelegationHarness(
  directory: string,
  databasePath: string,
  claudeScript: string,
  codexScript: string,
  claudeLog: string,
  codexLog: string,
  cliMaxStreamChars = 32_000_000,
) {
  const config = createConfig(
    directory,
    databasePath,
    claudeScript,
    codexScript,
    claudeLog,
    codexLog,
  );
  config.cliMaxStreamChars = cliMaxStreamChars;
  const store = new ModelRouterStore(databasePath, 5_000);
  const router = new ModelRouterService(store, new EmptySecretStore());
  const snapshot = await router.snapshot();
  const claude = snapshot.agents.find((agent) => agent.actorId === "claude");
  const codex = snapshot.agents.find((agent) => agent.actorId === "codex");
  assert(claude);
  assert(codex);
  router.updateAgent(claude.id, {
    displayName: claude.displayName,
    model: claude.model || "test-model",
    mentionAlias: claude.mentionAlias,
    enabled: true,
    permissionProfile: "read_only",
    executionRole: "hybrid",
  });
  router.updateAgent(codex.id, {
    displayName: codex.displayName,
    model: codex.model || "test-model",
    mentionAlias: codex.mentionAlias,
    enabled: true,
    permissionProfile: "workspace_write",
    executionRole: "hybrid",
  });
  const manager = new WorkItemDelegationManager({
    databasePath,
    sqliteBusyTimeoutMs: 5_000,
    defaultMessageLimit: 100,
    maxAttempts: 2,
    retryDelayMs: 1,
    worktreeRoot: config.delegationWorktreeRoot,
    gitCommand: config.gitCommand,
    gitTimeoutMs: config.gitDiffTimeoutMs,
    gitKillGraceMs: config.gitDiffKillGraceMs,
    gitMaxOutputChars: config.delegationGitMaxOutputChars,
    maxContextChars: config.maxContextChars,
  }, router, new ClaudeRuntime(config), new CodexRuntime(config));
  return { manager, router, claude, codex };
}

test("Claude 与 Codex 可双向指挥，在隔离 worktree 改代码并完成审核", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-delegation-"));
  const repositoryPath = path.join(directory, "repository");
  const databasePath = path.join(directory, "council.sqlite3");
  const claudeScript = path.join(directory, "fake-claude.cjs");
  const codexScript = path.join(directory, "fake-codex.cjs");
  const claudeLog = path.join(directory, "claude-prompts.log");
  const codexLog = path.join(directory, "codex-prompts.log");
  execFileSync("mkdir", ["-p", repositoryPath]);
  writeFileSync(claudeScript, CLAUDE_SCRIPT);
  writeFileSync(codexScript, CODEX_SCRIPT);
  writeFileSync(path.join(repositoryPath, "README.md"), "# fixture\n");
  git(repositoryPath, ["init", "--quiet"]);
  git(repositoryPath, ["config", "user.name", "Fixture"]);
  git(repositoryPath, ["config", "user.email", "fixture@example.com"]);
  git(repositoryPath, ["add", "README.md"]);
  git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);

  const database = await CouncilDatabase.open(databasePath, 5_000, { maxAttempts: 3 });
  const topic = database.createTopic({
    title: "当前委派议题",
    question: "验证 Agent 协作执行",
    constraints: ["原 checkout 必须保持干净"],
    projectPath: repositoryPath,
    createdByAlias: "human",
  });
  database.createMessage({
    topicId: topic.id,
    actorAlias: "human",
    kind: "note",
    content: "UNRELATED_HISTORY_MUST_NOT_REACH_RUNTIME",
  });
  const decision = database.createDecision({
    topicId: topic.id,
    title: "使用隔离执行",
    decision: "执行者只能写隔离 worktree。",
    rationale: "保护用户当前工作区。",
    alternatives: [],
    status: "accepted",
    createdByAlias: "human",
  });
  const [codexWorkItem, claudeWorkItem] = database.createWorkItems({
    topicId: topic.id,
    decisionId: decision.id,
    items: [
      { title: "Codex 新增目标文件", details: "生成 implemented.txt 并写入验证内容。" },
      { title: "Claude 新增目标文件", details: "生成 implemented.txt 并写入验证内容。" },
    ],
    createdByAlias: "human",
  });
  assert(codexWorkItem);
  assert(claudeWorkItem);
  database.close();

  const config = createConfig(directory, databasePath, claudeScript, codexScript, claudeLog, codexLog);
  const store = new ModelRouterStore(databasePath, 5_000);
  const router = new ModelRouterService(store, new EmptySecretStore());
  const snapshot = await router.snapshot();
  const claude = snapshot.agents.find((agent) => agent.actorId === "claude");
  const codex = snapshot.agents.find((agent) => agent.actorId === "codex");
  assert(claude);
  assert(codex);
  router.updateAgent(claude.id, {
    displayName: claude.displayName,
    model: claude.model || "test-model",
    mentionAlias: claude.mentionAlias,
    enabled: true,
    permissionProfile: "read_only",
    executionRole: "hybrid",
  });
  router.updateAgent(codex.id, {
    displayName: codex.displayName,
    model: codex.model || "test-model",
    mentionAlias: codex.mentionAlias,
    enabled: true,
    permissionProfile: "workspace_write",
    executionRole: "hybrid",
  });
  const manager = new WorkItemDelegationManager({
    databasePath,
    sqliteBusyTimeoutMs: 5_000,
    defaultMessageLimit: 100,
    maxAttempts: 2,
    retryDelayMs: 1,
    worktreeRoot: config.delegationWorktreeRoot,
    gitCommand: config.gitCommand,
    gitTimeoutMs: config.gitDiffTimeoutMs,
    gitKillGraceMs: config.gitDiffKillGraceMs,
    gitMaxOutputChars: config.delegationGitMaxOutputChars,
    maxContextChars: config.maxContextChars,
  }, router, new ClaudeRuntime(config), new CodexRuntime(config));

  try {
    const started = manager.start({
      topicId: topic.id,
      workItemId: codexWorkItem.id,
      expectedVersion: codexWorkItem.version,
      supervisorAgentId: claude.id,
      executorAgentId: codex.id,
      requestedPermission: "workspace_write",
      completionPolicy: "review",
    });
    const completed = await waitForTerminal(manager, topic.id, started.id);
    assert.equal(completed.status, "approved", completed.error ?? completed.status);
    const headCommit = completed.headCommit;
    assert.ok(headCommit);
    assert.match(completed.branchName ?? "", /^codex\/council-/u);
    assert.equal(git(repositoryPath, ["status", "--porcelain=v1"]), "");
    assert.equal(existsSync(path.join(repositoryPath, "implemented.txt")), false);
    assert.equal(git(repositoryPath, ["show", `${headCommit}:implemented.txt`]), "delegated by codex");

    const verificationDatabase = new CouncilDatabase(databasePath, 5_000);
    try {
      const updated = verificationDatabase.listWorkItems({ topicId: topic.id })
        .find((item) => item.id === codexWorkItem.id);
      assert.equal(updated?.status, "completed");
      assert.equal(updated?.assigneeActorId, codex.actorId);
      assert.equal(updated?.fixCommit, headCommit);
    } finally {
      verificationDatabase.close();
    }

    router.updateAgent(claude.id, {
      displayName: claude.displayName,
      model: claude.model || "test-model",
      mentionAlias: claude.mentionAlias,
      enabled: true,
      permissionProfile: "workspace_write",
      executionRole: "hybrid",
    });
    router.updateAgent(codex.id, {
      displayName: codex.displayName,
      model: codex.model || "test-model",
      mentionAlias: codex.mentionAlias,
      enabled: true,
      permissionProfile: "read_only",
      executionRole: "hybrid",
    });
    const reverseStarted = manager.start({
      topicId: topic.id,
      workItemId: claudeWorkItem.id,
      expectedVersion: claudeWorkItem.version,
      supervisorAgentId: codex.id,
      executorAgentId: claude.id,
      requestedPermission: "workspace_write",
      acceptanceCriteria: "人工验证目标文件并记录证据",
    });
    const reverseCompleted = await waitForTerminal(manager, topic.id, reverseStarted.id);
    assert.equal(reverseCompleted.status, "approved", reverseCompleted.error ?? reverseCompleted.status);
    const reverseHeadCommit = reverseCompleted.headCommit;
    assert.ok(reverseHeadCommit);
    assert.equal(
      git(repositoryPath, ["show", `${reverseHeadCommit}:implemented.txt`]),
      "delegated by claude",
    );
    const reverseDatabase = new CouncilDatabase(databasePath, 5_000);
    try {
      const reverseItem = reverseDatabase.listWorkItems({ topicId: topic.id })
        .find((item) => item.id === claudeWorkItem.id);
      assert(reverseItem);
      assert.equal(reverseCompleted.completionPolicy, "human");
      assert.equal(reverseItem.status, "in_progress");
      assert.throws(() => reverseDatabase.updateWorkItemAsActor({
        topicId: topic.id, workItemId: reverseItem.id, expectedVersion: reverseItem.version,
        status: "completed", statusNote: "Agent 自行声明完成", actorId: codex.actorId,
      }), /人工填写验收证据/u);
      assert.throws(() => reverseDatabase.updateWorkItemAsActor({
        topicId: topic.id, workItemId: reverseItem.id, expectedVersion: reverseItem.version,
        status: "completed", actorId: "human",
      }), /人工填写验收证据/u);
      const accepted = reverseDatabase.updateWorkItemAsActor({
        topicId: topic.id, workItemId: reverseItem.id, expectedVersion: reverseItem.version,
        status: "completed", statusNote: "人工检查目标文件内容与提交一致", actorId: "human",
      });
      assert.equal(accepted.status, "completed");
      assert.equal(accepted.fixCommit, reverseHeadCommit);
      assert.throws(() => reverseDatabase.updateWorkItemAsActor({
        topicId: topic.id, workItemId: reverseItem.id, expectedVersion: reverseItem.version,
        status: "completed", statusNote: "重复验收", actorId: "human",
      }), /已被其他参与者更新/u);
      assert.equal(reverseItem?.assigneeActorId, claude.actorId);
      assert.equal(reverseItem?.fixCommit, reverseHeadCommit);
    } finally {
      reverseDatabase.close();
    }

    const prompts = `${readFileSync(claudeLog, "utf8")}\n${readFileSync(codexLog, "utf8")}`;
    assert.doesNotMatch(prompts, /UNRELATED_HISTORY_MUST_NOT_REACH_RUNTIME/u);
    assert.match(prompts, /当前实施项：Codex 新增目标文件/u);
    assert.match(prompts, /当前实施项：Claude 新增目标文件/u);
  } finally {
    await manager.shutdown();
    manager.close();
    router.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("无 HEAD 的新项目可显式建立安全基线，并在同一分支串行完成整批任务", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-batch-baseline-"));
  const repositoryPath = path.join(directory, "repository");
  const databasePath = path.join(directory, "council.sqlite3");
  const claudeScript = path.join(directory, "fake-claude.cjs");
  const codexScript = path.join(directory, "fake-codex.cjs");
  const claudeLog = path.join(directory, "claude-prompts.log");
  const codexLog = path.join(directory, "codex-prompts.log");
  execFileSync("mkdir", ["-p", repositoryPath]);
  writeFileSync(claudeScript, CLAUDE_SCRIPT);
  writeFileSync(codexScript, CODEX_SCRIPT);
  writeFileSync(path.join(repositoryPath, "README.md"), "# new fixture\n");
  git(repositoryPath, ["init", "--quiet"]);

  const database = await CouncilDatabase.open(databasePath, 5_000, { maxAttempts: 3 });
  const topic = database.createTopic({
    title: "新项目批量委派",
    question: "如何安全建立基线并串行交付？",
    constraints: ["原工作文件不能丢失"],
    projectPath: repositoryPath,
    createdByAlias: "human",
  });
  const decision = database.createDecision({
    topicId: topic.id,
    title: "串行共享分支",
    decision: "后续任务必须看到前序任务的审核通过提交。",
    rationale: "避免并行 worktree 互相覆盖。",
    alternatives: [],
    status: "accepted",
    createdByAlias: "human",
  });
  const items = database.createWorkItems({
    topicId: topic.id,
    decisionId: decision.id,
    items: [
      { title: "第一个串行任务", details: "新增 implemented.txt。" },
      { title: "第二个串行任务", details: "在前序结果上新增 second.txt。" },
    ],
    createdByAlias: "human",
  });
  const firstItem = items[0];
  const secondItem = items[1];
  assert(firstItem);
  assert(secondItem);
  database.close();

  const { manager, router, claude, codex } = await createDelegationHarness(
    directory,
    databasePath,
    claudeScript,
    codexScript,
    claudeLog,
    codexLog,
  );
  try {
    const rejected = manager.start({
      topicId: topic.id,
      workItemId: firstItem.id,
      expectedVersion: firstItem.version,
      supervisorAgentId: claude.id,
      executorAgentId: codex.id,
      requestedPermission: "workspace_write",
      completionPolicy: "review",
    });
    const rejectedResult = await waitForTerminal(manager, topic.id, rejected.id);
    assert.equal(rejectedResult.status, "failed");
    assert.match(rejectedResult.error ?? "", /建立安全基线/u);
    assert.throws(() => git(repositoryPath, ["rev-parse", "--verify", "HEAD"]));

    const versionDatabase = new CouncilDatabase(databasePath, 5_000);
    const refreshedItems = versionDatabase.listWorkItems({ topicId: topic.id });
    versionDatabase.close();
    const refreshedFirst = refreshedItems.find((item) => item.id === firstItem.id);
    const refreshedSecond = refreshedItems.find((item) => item.id === secondItem.id);
    assert(refreshedFirst);
    assert(refreshedSecond);

    const started = manager.startBatch({
      topicId: topic.id,
      workItems: [
        { workItemId: refreshedFirst.id, expectedVersion: refreshedFirst.version },
        { workItemId: refreshedSecond.id, expectedVersion: refreshedSecond.version },
      ],
      supervisorAgentId: claude.id,
      executorAgentId: codex.id,
      requestedPermission: "workspace_write",
      completionPolicy: "review",
      createInitialBaseline: true,
    });
    assert.equal(started.length, 2);
    assert.equal(started[0]?.branchName, started[1]?.branchName);
    assert.match(started[0]?.branchName ?? "", /^codex\/council-batch-/u);

    const firstCompleted = await waitForTerminal(manager, topic.id, started[0]!.id);
    const secondCompleted = await waitForTerminal(manager, topic.id, started[1]!.id);
    assert.equal(firstCompleted.status, "approved", firstCompleted.error ?? firstCompleted.status);
    assert.equal(secondCompleted.status, "approved", secondCompleted.error ?? secondCompleted.status);
    assert.equal(firstCompleted.branchName, secondCompleted.branchName);
    assert.ok(secondCompleted.headCommit);
    assert.equal(git(repositoryPath, ["status", "--porcelain=v1"]), "");
    assert.equal(git(repositoryPath, ["show", "HEAD:README.md"]), "# new fixture");
    assert.equal(existsSync(path.join(repositoryPath, "implemented.txt")), false);
    assert.equal(
      git(repositoryPath, ["show", `${secondCompleted.headCommit}:implemented.txt`]),
      "delegated by codex",
    );
    assert.equal(
      git(repositoryPath, ["show", `${secondCompleted.headCommit}:second.txt`]),
      "delegated by codex",
    );
    const verificationDatabase = new CouncilDatabase(databasePath, 5_000);
    try {
      const completedItems = verificationDatabase.listWorkItems({ topicId: topic.id });
      assert.equal(completedItems.find((item) => item.id === firstItem.id)?.status, "completed");
      assert.equal(completedItems.find((item) => item.id === secondItem.id)?.status, "completed");
    } finally {
      verificationDatabase.close();
    }
  } finally {
    await manager.shutdown();
    manager.close();
    router.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("安全基线发现私密配置时拒绝提交且保留新项目文件", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "council-sensitive-baseline-"));
  const repositoryPath = path.join(directory, "repository");
  const databasePath = path.join(directory, "council.sqlite3");
  const claudeScript = path.join(directory, "fake-claude.cjs");
  const codexScript = path.join(directory, "fake-codex.cjs");
  const claudeLog = path.join(directory, "claude-prompts.log");
  const codexLog = path.join(directory, "codex-prompts.log");
  execFileSync("mkdir", ["-p", repositoryPath]);
  writeFileSync(claudeScript, CLAUDE_SCRIPT);
  writeFileSync(codexScript, CODEX_SCRIPT);
  writeFileSync(path.join(repositoryPath, "README.md"), "# sensitive fixture\n");
  writeFileSync(path.join(repositoryPath, ".env"), "API_KEY=example-secret-value\n");
  git(repositoryPath, ["init", "--quiet"]);

  const database = await CouncilDatabase.open(databasePath, 5_000, { maxAttempts: 3 });
  const topic = database.createTopic({
    title: "敏感基线拦截",
    question: "私密文件不得进入首个提交",
    constraints: [],
    projectPath: repositoryPath,
    createdByAlias: "human",
  });
  const decision = database.createDecision({
    topicId: topic.id,
    title: "先扫描",
    decision: "基线提交前扫描路径和内容。",
    rationale: "提交不可逆。",
    alternatives: [],
    status: "accepted",
    createdByAlias: "human",
  });
  const [item] = database.createWorkItems({
    topicId: topic.id,
    decisionId: decision.id,
    items: [{ title: "实现安全功能", details: "不应开始执行。" }],
    createdByAlias: "human",
  });
  assert(item);
  database.close();

  const { manager, router, claude, codex } = await createDelegationHarness(
    directory,
    databasePath,
    claudeScript,
    codexScript,
    claudeLog,
    codexLog,
  );
  try {
    const started = manager.start({
      topicId: topic.id,
      workItemId: item.id,
      expectedVersion: item.version,
      supervisorAgentId: claude.id,
      executorAgentId: codex.id,
      requestedPermission: "workspace_write",
      completionPolicy: "review",
      createInitialBaseline: true,
    });
    const completed = await waitForTerminal(manager, topic.id, started.id);
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /安全基线包含凭据/u);
    assert.throws(() => git(repositoryPath, ["rev-parse", "--verify", "HEAD"]));
    assert.equal(readFileSync(path.join(repositoryPath, ".env"), "utf8"), "API_KEY=example-secret-value\n");
    assert.match(git(repositoryPath, ["status", "--porcelain=v1"]), /\.env/u);
  } finally {
    await manager.shutdown();
    manager.close();
    router.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function recoveryFixture(cliMaxStreamChars = 32_000_000) {
  const directory = mkdtempSync(path.join(tmpdir(), "council-recovery-"));
  const repositoryPath = path.join(directory, "repository");
  execFileSync("mkdir", ["-p", repositoryPath]);
  writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  git(repositoryPath, ["init", "--quiet"]);
  git(repositoryPath, ["config", "user.name", "Fixture"]);
  git(repositoryPath, ["config", "user.email", "fixture@example.com"]);
  git(repositoryPath, ["add", "README.md"]);
  git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);
  const databasePath = path.join(directory, "council.sqlite3");
  const database = await CouncilDatabase.open(databasePath, 5000, { maxAttempts: 1 });
  const topic = database.createTopic({ title: "恢复测试", question: "从提交恢复", constraints: [], projectPath: repositoryPath, createdByAlias: "human" });
  const decision = database.createDecision({ topicId: topic.id, title: "隔离", decision: "保持提交", rationale: "恢复", alternatives: [], status: "accepted", createdByAlias: "human" });
  const [item] = database.createWorkItems({ topicId: topic.id, decisionId: decision.id, items: [{ title: "执行任务", details: "生成 implemented.txt" }], createdByAlias: "human" });
  assert(item);
  const claudeScript = path.join(directory, "claude.cjs");
  const codexScript = path.join(directory, "codex.cjs");
  const claudeLog = path.join(directory, "claude.log");
  const codexLog = path.join(directory, "codex.log");
  writeFileSync(claudeScript, CLAUDE_SCRIPT);
  writeFileSync(codexScript, CODEX_SCRIPT);
  const harness = await createDelegationHarness(directory, databasePath, claudeScript, codexScript, claudeLog, codexLog, cliMaxStreamChars);
  return { ...harness, directory, repositoryPath, databasePath, database, topic, item, claudeScript, codexScript, claudeLog, codexLog,
    start: () => harness.manager.start({ topicId: topic.id, workItemId: item.id, expectedVersion: item.version,
      supervisorAgentId: harness.claude.id, executorAgentId: harness.codex.id, requestedPermission: "workspace_write" }),
    close: async () => { await harness.manager.shutdown(); harness.manager.close(); harness.router.close(); database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("执行事件流超限保留未提交文件，记录具体分类且不自动重放写操作", async () => {
  const h = await recoveryFixture(1_000);
  const audit = new RuntimeAuditStore(h.databasePath, 5_000);
  try {
    writeFileSync(h.codexScript, CODEX_SCRIPT.replace("const events =", `
process.stdout.write(JSON.stringify({ type: "item.completed", item: {
  type: "command_execution", output: "private tool detail".repeat(200)
} }) + "\\n");
const events =`));
    const started = h.start();
    const failed = await waitForTerminal(h.manager, h.topic.id, started.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureCode, "stream_output_limit");
    assert.equal(failed.headCommit, undefined);
    assert.match(failed.error ?? "", /上限 1000/);
    assert.equal(readFileSync(h.codexLog, "utf8").split("---CALL---").length - 1, 1);
    const worktree = path.join(h.directory, "delegated-worktrees", failed.id);
    assert.equal(readFileSync(path.join(worktree, "implemented.txt"), "utf8"), "delegated by codex\n");
    assert.match(git(worktree, ["status", "--porcelain=v1"]), /\?\? implemented\.txt/);
    const events = audit.list(h.topic.id, "delegation", failed.id).events;
    assert.equal(events.filter(event => event.kind === "execution.failed").length, 1);
    assert.equal(events.some(event => event.kind === "review.started"), false);
    assert.equal(events.find(event => event.kind === "delegation.failed")?.data.failureCode, "stream_output_limit");
    assert.doesNotMatch(JSON.stringify(events), /private tool detail/);
  } finally { audit.close(); await h.close(); }
});

test("未提交草稿显式接续到新工作区，保留历史并重新执行审核与人工验收", async () => {
  const h = await recoveryFixture();
  try {
    writeFileSync(h.codexScript, CODEX_SCRIPT.replace("const content =", 'process.stderr.write("executor stopped"); process.exit(1);\nconst content ='));
    const failed = await waitForTerminal(h.manager, h.topic.id, h.start().id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.headCommit, undefined);
    const oldRoot = path.join(h.directory, "delegated-worktrees", failed.id);
    writeFileSync(path.join(oldRoot, "unfinished.ts"), "export const retained = true;\n");
    writeFileSync(path.join(oldRoot, "README.md"), "draft README\n");
    writeFileSync(path.join(oldRoot, "large-draft.txt"), "unfinished line\n".repeat(3000));
    git(oldRoot, ["add", "README.md"]);
    const oldIndex = readFileSync(path.resolve(oldRoot, git(oldRoot, ["rev-parse", "--git-path", "index"])));
    const oldStatus = git(oldRoot, ["status", "--porcelain=v1"]);
    const item = h.database.listWorkItems({ topicId: h.topic.id })[0]!;
    // 恢复后即使首次只读说明失败，草稿仍进入新工作区，可以再次显式接续。
    writeFileSync(h.claudeScript, CLAUDE_SCRIPT.replace("const content =", 'process.stdout.write(JSON.stringify({type:"result",result:"unauthorized",is_error:true})); process.exit(1);\nconst content ='));
    const firstResume = await h.manager.resume(failed.id, item.version);
    const interrupted = await waitForTerminal(h.manager, h.topic.id, firstResume.id);
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.headCommit, undefined);
    assert.equal(readFileSync(path.join(h.directory, "delegated-worktrees", interrupted.id, "unfinished.ts"), "utf8"), "export const retained = true;\n");
    writeFileSync(h.claudeScript, CLAUDE_SCRIPT);
    writeFileSync(h.codexScript, CODEX_SCRIPT.replace("const content =", `
if (readFileSync("unfinished.ts", "utf8") !== "export const retained = true;\\n") process.exit(7);
if (readFileSync("README.md", "utf8") !== "draft README\\n") process.exit(8);
const content =`));
    const current = h.database.listWorkItems({ topicId: h.topic.id })[0]!;
    const results = await Promise.allSettled([
      h.manager.resume(interrupted.id, current.version), h.manager.resume(interrupted.id, current.version),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const resumed = results.find(result => result.status === "fulfilled");
    assert(resumed?.status === "fulfilled");
    const approved = await waitForTerminal(h.manager, h.topic.id, resumed.value.id);
    assert.equal(approved.status, "approved", approved.error ?? "");
    assert(approved.headCommit);
    assert.equal(approved.resumedFromId, interrupted.id);
    assert.equal(approved.completionPolicy, "human");
    assert.equal(approved.acceptanceCriteria, failed.acceptanceCriteria);
    assert.equal(approved.executorAgentId, failed.executorAgentId);
    assert.equal(approved.supervisorAgentId, failed.supervisorAgentId);
    assert.equal(h.database.listWorkItems({ topicId: h.topic.id })[0]!.status, "in_progress");
    assert.equal(git(h.repositoryPath, ["rev-parse", "HEAD"]), failed.baseCommit);
    assert.equal(git(h.repositoryPath, ["status", "--porcelain=v1"]), "");
    assert.equal(git(oldRoot, ["status", "--porcelain=v1"]), oldStatus);
    assert.deepEqual(readFileSync(path.resolve(oldRoot, git(oldRoot, ["rev-parse", "--git-path", "index"]))), oldIndex);
    assert.equal(h.manager.list(h.topic.id).find(entry => entry.id === failed.id)?.status, "failed");
    const audit = new RuntimeAuditStore(h.databasePath, 5000);
    try {
      const events = audit.list(h.topic.id, "delegation", approved.id).events;
      assert.equal(events.find(event => event.kind === "delegation.resumed")?.data.recoveryMode, "workspace");
      assert.equal(events.find(event => event.kind === "delegation.resumed")?.data.restoredFiles, 4);
      assert(events.some(event => event.kind === "execution.started"));
      assert(events.some(event => event.kind === "review.completed"));
    } finally { audit.close(); }
  } finally { await h.close(); }
});

test("重启仅将未结束委派标为中断并追加一次证据，不自动重放", async () => {
  const h = await recoveryFixture();
  const store = new WorkItemDelegationStore(h.databasePath, 5000);
  const audit = new RuntimeAuditStore(h.databasePath, 5000);
  try {
    store.create({ id: "delegation-interrupted", topicId: h.topic.id, workItemId: h.item.id,
      supervisorAgentId: h.claude.id, executorAgentId: h.codex.id, permissionProfile: "workspace_write",
      completionPolicy: "human", acceptanceCriteria: "检查恢复证据", maxAttempts: 2, now: new Date().toISOString() });
    h.manager.initialize();
    h.manager.initialize();
    assert.equal(store.get("delegation-interrupted")?.failureCode, "interrupted");
    assert.equal(audit.list(h.topic.id, "delegation", "delegation-interrupted").events.length, 1);
    assert.equal(existsSync(h.codexLog), false);
    assert.equal(existsSync(h.claudeLog), false);
  } finally { audit.close(); store.close(); await h.close(); }
});

test("审核失败后从提交恢复，拒绝脏工作区与重复恢复，保留每次运行历史", async () => {
  const h = await recoveryFixture();
  try {
    writeFileSync(h.claudeScript, CLAUDE_SCRIPT.replace('const content =', `
if (prompt.includes("只返回一个 JSON 对象")) {
  process.stdout.write(JSON.stringify({ type: "result", result: "unauthorized", is_error: true }));
  process.exit(1);
}
const content =`));
    const started = h.start();
    const failed = await waitForTerminal(h.manager, h.topic.id, started.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureCode, "authentication_failed");
    assert(failed.headCommit);
    const changed = h.database.listWorkItems({ topicId: h.topic.id })[0]!;
    const oldWorktree = path.join(h.directory, "delegated-worktrees", failed.id);
    const uncommitted = path.join(oldWorktree, "unfinished.txt");
    writeFileSync(uncommitted, "preserve me");
    await assert.rejects(h.manager.resume(failed.id, changed.version), /未提交改动/u);
    assert.equal(readFileSync(uncommitted, "utf8"), "preserve me");
    rmSync(uncommitted);
    // 恢复的第一次只读说明再次失败，最新委派仍应保留原提交，允许继续恢复。
    writeFileSync(h.claudeScript, CLAUDE_SCRIPT.replace('const content =', 'process.stdout.write(JSON.stringify({type:"result",result:"unauthorized",is_error:true})); process.exit(1);\nconst content ='));
    const interruptedResume = await h.manager.resume(failed.id, changed.version);
    const failedAgain = await waitForTerminal(h.manager, h.topic.id, interruptedResume.id);
    assert.equal(failedAgain.headCommit, failed.headCommit);
    assert.equal(failedAgain.status, "failed");
    const resumableItem = h.database.listWorkItems({ topicId: h.topic.id })[0]!;
    writeFileSync(h.claudeScript, CLAUDE_SCRIPT);
    await assert.rejects(h.manager.resume(failed.id, h.item.version), /已更新/u);
    const results = await Promise.allSettled([
      h.manager.resume(failedAgain.id, resumableItem.version), h.manager.resume(failedAgain.id, resumableItem.version),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const resumed = results.find(result => result.status === "fulfilled");
    assert(resumed?.status === "fulfilled");
    const approved = await waitForTerminal(h.manager, h.topic.id, resumed.value.id);
    assert.equal(approved.status, "approved", approved.error ?? "");
    assert.equal(approved.resumedFromId, failedAgain.id);
    assert.equal(approved.headCommit, failed.headCommit);
    assert.notEqual(approved.branchName, failed.branchName);
    assert.equal(h.manager.list(h.topic.id).find(entry => entry.id === failed.id)?.status, "failed");
    // 已有提交直接交回审核，不再次召唤写入 Agent。
    assert.equal(readFileSync(h.codexLog, "utf8").split("---CALL---").length - 1, 1);
    assert.equal(git(h.repositoryPath, ["status", "--porcelain=v1"]), "");
    const audit = new RuntimeAuditStore(h.databasePath, 5000);
    try {
      const oldEvents = audit.list(h.topic.id, "delegation", failed.id).events;
      const newEvents = audit.list(h.topic.id, "delegation", approved.id).events;
      assert(oldEvents.some(event => event.kind === "review.failed"));
      assert(newEvents.some(event => event.kind === "review.completed"));
      assert(newEvents.some(event => event.kind === "delegation.resumed"));
      assert(!newEvents.some(event => event.kind === "execution.started"));
    } finally { audit.close(); }
  } finally { await h.close(); }
});

test("执行期间的人工作答不被失败回写覆盖，活动委派禁止改权限或关闭议题", async () => {
  const h = await recoveryFixture();
  const gate = h.codexLog + ".release";
  try {
    writeFileSync(h.codexScript, CODEX_SCRIPT.replace('const content =', `
const gate = process.argv[2] + ".release";
while (!require("node:fs").existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
process.stderr.write("unauthorized"); process.exit(1);
const content =`));
    const started = h.start();
    const deadline = Date.now() + 4000;
    while (!existsSync(h.codexLog) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(existsSync(h.codexLog));
    assert.throws(() => h.router.updateAgent(h.codex.id, {
      displayName: h.codex.displayName, model: h.codex.model, mentionAlias: h.codex.mentionAlias,
      enabled: true, permissionProfile: "read_only", executionRole: "advisor",
    }), /活动 Run/u);
    assert.throws(() => h.database.closeTopicAsActor({ topicId: h.topic.id, actorId: "human" }), /任务委派/u);
    const item = h.database.listWorkItems({ topicId: h.topic.id })[0]!;
    const human = h.database.updateWorkItem({ topicId: h.topic.id, workItemId: item.id,
      status: "in_progress", expectedVersion: item.version, statusNote: "用户已接手排查，请保留本条说明", updatedByAlias: "human" });
    writeFileSync(gate, "continue");
    assert.equal((await waitForTerminal(h.manager, h.topic.id, started.id)).status, "failed");
    const finalItem = h.database.listWorkItems({ topicId: h.topic.id })[0]!;
    assert.equal(finalItem.version, human.version);
    assert.equal(finalItem.statusNote, human.statusNote);
    assert.equal(finalItem.updatedByActorId, "human");
  } finally { writeFileSync(gate, "continue"); await h.close(); }
});

test("只读审核的瞬态故障有限重试，写入阶段故障不自动重放", async () => {
  const h = await recoveryFixture();
  try {
    writeFileSync(h.claudeScript, CLAUDE_SCRIPT.replace('const content =', `
const marker = process.argv[2] + ".retried";
if (prompt.includes("只返回一个 JSON 对象") && !require("node:fs").existsSync(marker)) {
  writeFileSync(marker, "once");
  process.stdout.write(JSON.stringify({ type: "result", result: "service unavailable", is_error: true }));
  process.exit(1);
}
const content =`));
    const first = h.start();
    const approved = await waitForTerminal(h.manager, h.topic.id, first.id);
    assert.equal(approved.status, "approved", approved.error ?? "");
    assert.equal(readFileSync(h.claudeLog, "utf8").split("---CALL---").length - 1, 3);
    const audit = new RuntimeAuditStore(h.databasePath, 5000);
    try { assert.equal(audit.list(h.topic.id, "delegation", first.id).events.filter(e => e.kind === "review.started").length, 2); }
    finally { audit.close(); }
    const decision = h.database.getTopicDetail(h.topic.id, 100).decisions[0]!;
    const [item] = h.database.createWorkItems({ topicId: h.topic.id, decisionId: decision.id, items: [{ title: "写失败", details: "不能重放" }], createdByAlias: "human" });
    assert(item);
    writeFileSync(h.codexScript, CODEX_SCRIPT.replace('const content =', 'process.stderr.write("network unavailable"); process.exit(1);\nconst content ='));
    const second = h.manager.start({ topicId: h.topic.id, workItemId: item.id, expectedVersion: item.version, supervisorAgentId: h.claude.id, executorAgentId: h.codex.id, requestedPermission: "workspace_write" });
    const failed = await waitForTerminal(h.manager, h.topic.id, second.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureCode, "transient_failure");
    assert.equal(readFileSync(h.codexLog, "utf8").split("---CALL---").length - 1, 2);
  } finally { await h.close(); }
});
