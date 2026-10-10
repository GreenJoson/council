/**
 * @input  依赖：ClaudeRuntime / CodexRuntime 传入的版本、认证、特性列表或生成参数与 stdin prompt
 * @output 导出：可用性检查、长上下文与 Markdown 交接边界的子进程 E2E 协议响应；
 *         Codex 侧另有 `login status`、`features list`（image_generation stable true）与
 *         `exec --enable image_generation` 生图替身（写 2 张最小合法 PNG 到 <cd>/.council/out 并输出清单；
 *         COUNCIL_PIPELINE_NO_OUTPUTS_ONCE 首次只出清单不写文件，COUNCIL_PIPELINE_BAD_MANIFEST_ONCE 首次写一张
 *         草稿图但清单损坏）；P3 流水线 brief / 复盘一次性调用替身（COUNCIL_PIPELINE_BRIEF 按模板返回合法
 *         council-brief，COUNCIL_PIPELINE_REVIEW 首轮 revise、之后 pass，deliverableId 优先取产物行的清单标注）；
 *         P4 Worker 团队替身（COUNCIL_TEAM_E2E）：Lead 必须带注入的 council MCP 与「团队模式」指令，首段真实拉起该 MCP
 *         核对只有六个团队工具并调用 council_list_workers，之后每段约 2.5 秒内（给 5 秒进程超时留余量）等 team-a/team-b 的 worker.txt 被合并进来，
 *         等到即写 team-lead.txt 收尾，否则写进度文件以 canContinue:true 交接；Worker 不得带 MCP，按 brief 的
 *         `dir=<目录> delay=<毫秒>` 延时后写 <目录>/worker.txt；审核一律 approved
 * @pos    测试专用的 Claude Code / Codex CLI 最小协议替身
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);

// 2x2 最小合法 PNG：一张 RGB、一张带 alpha（RGBA），内容不同以免被 sha256 去重。
const PNG_RGB = "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73000000104944415478da63d0cabf06440c100a00258205bd8c994e360000000049454e44ae426082";
const PNG_RGBA = "89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d24000000114944415478da637810a5dd00c20c30060046e40795e9ff745a0000000049454e44ae426082";
// 3x3 RGBA：BAD_MANIFEST_ONCE 那次写的草稿图，字节与上面两张都不同，才能验证失败尝试的产物不进下一次复盘。
const PNG_DRAFT = "89504e470d0a1a0a0000000d49484452000000030000000308060000005628b5bf000000234944415478da63606038f13f008817003103830d9003c40b6c409c0a2007881700310072a414ec95df58920000000049454e44ae426082";

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n", () => process.exit(0));
}

if (args[0] === "login" && args[1] === "status") {
  process.stderr.write("Logged in using ChatGPT\n", () => process.exit(0));
}

if (args[0] === "features" && args[1] === "list") {
  process.stdout.write(
    ["undo                 stable  false", "image_generation     stable  true", "web_search_request   stable  true", ""].join("\n"),
    () => process.exit(0),
  );
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    JSON.stringify({ loggedIn: true, authMethod: "test" }),
    () => process.exit(0),
  );
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (args[0] === "exec" && args[args.indexOf("--enable") + 1] === "image_generation") {
    fakeImageGeneration(prompt);
    return;
  }
  if (prompt.includes("COUNCIL_MODEL_PROBE") && args.includes("--print")) {
    process.stdout.write(JSON.stringify({ type: "result", result: readFileSync("council-probe.txt", "utf8"), model: "fake-probe-model" }));
    return;
  }
  if (prompt.includes("COUNCIL_TEAM_E2E") && args.includes("--print")) {
    fakeTeam(prompt).catch((error) => teamFail(error instanceof Error ? error.message : String(error)));
    return;
  }
  // 流水线一次性调用要排在 COUNCIL_SEGMENT_E2E 之前：E2E 的流水线 goal 带该标记，好让原型代码委派走分段替身。
  if (prompt.includes("COUNCIL_PIPELINE_BRIEF") && args.includes("--print")) {
    fakePipelineResult(fakePipelineBrief(prompt));
    return;
  }
  if (prompt.includes("COUNCIL_PIPELINE_REVIEW") && args.includes("--print")) {
    fakePipelineResult(fakePipelineReview(prompt));
    return;
  }
  if (prompt.includes("COUNCIL_SEGMENT_E2E") && args.includes("--print")) {
    if (prompt.includes("LONG_CONTEXT") && !prompt.includes("COUNCIL_REQUIRED_TASK_TAIL")) {
      process.stderr.write("当前任务正文缺失\n");
      process.exitCode = 2;
      return;
    }
    let result;
    let turnLimit = false;
    if (prompt.includes("你是本次任务的 executor")) {
      if (prompt.includes("INVALID_CHECKPOINT")) {
        writeFileSync("stage-one.txt", "unfinished draft\n");
        result = '代码尚未完成。\n```json\nCOUNCIL_CHECKPOINT\n{"remaining":[]}\n```';
      } else if (prompt.includes("NO_PROGRESS")) {
        result = 'COUNCIL_CHECKPOINT\n' + JSON.stringify({ completed: [], validation: ["检查后没有文件变化"], remaining: ["仍未完成"], canContinue: true });
      } else if (prompt.includes("PIPELINE_HANDOFF_ONCE") && !existsSync("stage-one.txt")) {
        // 流水线原型：第一段把骨架存下来后以 canContinue:false 交接（沙箱不许起服务/浏览器验证），
        // 委派停在 execution_checkpoint；流水线「恢复」接续到新工作区后走下面的第二段。
        writeFileSync("stage-one.txt", "first segment\n");
        result = '原型骨架已保存，验证需要用户放行。\n```json\nCOUNCIL_CHECKPOINT\n' + JSON.stringify({ completed: ["原型骨架已写入"], validation: ["未启动服务"], remaining: ["需要允许监听端口后再做浏览器验证"], canContinue: false }) + '\n```';
      } else if (!existsSync("stage-one.txt")) {
        writeFileSync("stage-one.txt", "first segment\n");
        turnLimit = prompt.includes("TURN_LIMIT");
        result = '第一阶段已保存，工作还没完成。\n```json\nCOUNCIL_CHECKPOINT\n' + JSON.stringify({ completed: ["第一段文件已保存"], validation: ["文件已写入"], remaining: ["写入第二段文件"], canContinue: true }) + '\n```';
      } else {
        writeFileSync("stage-two.txt", "second segment\n");
        result = "两段文件已保存并核对；等待独立审核。";
      }
    } else if (prompt.includes("只返回一个 JSON 对象")) {
      result = JSON.stringify({ verdict: "approved", summary: "两段交付符合验收标准。", findings: [], inspectedFiles: ["stage-one.txt", "stage-two.txt"] });
    } else {
      result = "COUNCIL_SEGMENT_E2E：分两段保存文件，并检查文件内容。";
    }
    // 给浏览器留出观察真实后台阶段的时间，不引入付费模型调用。
    setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result, session_id: "fake-segment-session", is_error: turnLimit,
      ...(turnLimit ? { subtype: "error_max_turns", num_turns: 121 } : {}) })), 300);
    return;
  }
  if (!args.includes("--print") || !prompt.includes("真实编排 E2E")) {
    process.stderr.write("生成协议或测试指令无效\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify({
    result: "自动 Claude 回帖：先固定状态机不变量，再验证可回滚的最小方案。",
    session_id: "fake-e2e-session",
    model: "fake-e2e-model",
  }));
});

function fakePipelineResult(result) {
  process.stdout.write(JSON.stringify({ type: "result", result, session_id: "fake-pipeline-session", model: "fake-pipeline-model" }));
}

/** 流水线 brief 替身：kind 随首行 `template=<id> kind=<kind>`，goal 带上请求目标，让测试标记流进生图提示词。 */
function fakePipelineBrief(text) {
  const header = /COUNCIL_PIPELINE_BRIEF template=([a-z-]+) kind=([a-z-]+)/u.exec(text);
  const template = header?.[1] ?? "concept-sheet";
  const kind = header?.[2] ?? "concept-sheet";
  const goal = (/^目标：(.*)$/mu.exec(text)?.[1] ?? "流水线占位目标").trim().slice(0, 480);
  const deliverables = template === "game-asset-pack"
    ? [{ id: "hero-sprite", description: "主角待机 sprite", size: "256x256", transparent: true, count: 6 }]
    : [
      { id: "main-screen", description: "主界面设计稿", size: "1024x1024" },
      { id: "detail-screen", description: "详情页设计稿", size: "1024x1024" },
    ];
  const brief = {
    schemaVersion: 1,
    kind,
    goal,
    deliverables,
    acceptance: ["画面与目标一致", "交付物齐全"],
    ...(template === "app-mockup" ? { nextStage: { kind: "prototype", notes: "实现主界面与详情页的可交互原型。" } } : {}),
  };
  return `按模板 ${template} 整理 brief。\n\`\`\`council-brief\n${JSON.stringify(brief)}\n\`\`\``;
}

/**
 * 流水线复盘替身：第 1 轮对第一张产物给出 revise，之后一律 pass。
 * deliverableId 优先取产物行上的清单标注（`清单标注 deliverableId=…`），没有才退回 brief 的第一个交付物。
 */
function fakePipelineReview(text) {
  const round = Number(/COUNCIL_PIPELINE_REVIEW round=(\d+)/u.exec(text)?.[1] ?? "1");
  const fallbackDeliverableId = /deliverableId: ([a-z0-9][a-z0-9-]*)/u.exec(text)?.[1] ?? "image";
  const outputs = [...text.matchAll(/assetId=([A-Za-z0-9_-]+)(?:[^\n]*? deliverableId=([a-z0-9][a-z0-9-]*))?/gu)]
    .map((match) => ({ assetId: match[1], deliverableId: match[2] ?? fallbackDeliverableId }));
  const revise = round === 1 && outputs.length > 0;
  const review = revise
    ? { schemaVersion: 1, verdict: "revise", items: [{ ...outputs[0], ok: false, issue: "构图偏离目标", change: "主体居中并加强对比" }] }
    : { schemaVersion: 1, verdict: "pass", items: outputs.map((item) => ({ ...item, ok: true })) };
  return `第 ${String(round)} 轮复盘完成。\n\`\`\`council-review\n${JSON.stringify(review)}\n\`\`\``;
}

/**
 * Codex 生图替身：按 brief 提示词中的 deliverableId 写产物与清单；参考图必须真实存在。
 * 提示词含 COUNCIL_PIPELINE_NO_OUTPUTS_ONCE 时，第一次只输出清单不写文件（触发 outputs_missing）；
 * 含 COUNCIL_PIPELINE_BAD_MANIFEST_ONCE 时，第一次写一张字节不同的草稿图但清单 path 写成绝对路径
 * （真实 Codex 常见的清单损坏；触发 manifest_invalid，草稿图已入库挂在子任务上）。计数文件放在 --cd 的上一级，委派工作区重建后仍能记住。
 */
function fakeImageGeneration(text) {
  const cwd = optionValue("--cd");
  const lastMessagePath = optionValue("-o");
  if (!cwd || !lastMessagePath || !optionValue("--output-schema")) {
    process.stderr.write("生图参数缺失\n");
    process.exitCode = 2;
    return;
  }
  const inputs = args.flatMap((value, index) => (value === "-i" ? [args[index + 1]] : []));
  if (inputs.some((item) => !item || !existsSync(item))) {
    process.stderr.write("参考图不存在\n");
    process.exitCode = 2;
    return;
  }
  const ids = [...text.matchAll(/deliverableId: ([a-z0-9][a-z0-9-]*)/gu)].map((match) => match[1]);
  const deliverableId = ids[0] ?? "image";
  const outDir = path.join(cwd, ".council", "out");
  mkdirSync(outDir, { recursive: true });
  const files = [
    { name: `${deliverableId}.png`, hex: PNG_RGB },
    { name: `${deliverableId}-2.png`, hex: PNG_RGBA },
  ];
  const onceMarker = path.join(path.dirname(cwd), ".fake-pipeline-no-outputs-once");
  const skipOutputs = text.includes("COUNCIL_PIPELINE_NO_OUTPUTS_ONCE") && !existsSync(onceMarker);
  const badManifestMarker = path.join(path.dirname(cwd), ".fake-pipeline-bad-manifest-once");
  const badManifest = !skipOutputs && text.includes("COUNCIL_PIPELINE_BAD_MANIFEST_ONCE") && !existsSync(badManifestMarker);
  if (skipOutputs) writeFileSync(onceMarker, "1\n");
  else if (badManifest) {
    writeFileSync(badManifestMarker, "1\n");
    writeFileSync(path.join(outDir, `${deliverableId}-draft.png`), Buffer.from(PNG_DRAFT, "hex"));
  } else for (const file of files) writeFileSync(path.join(outDir, file.name), Buffer.from(file.hex, "hex"));
  const manifest = badManifest
    ? {
      schemaVersion: 1,
      outputs: [{
        deliverableId,
        path: path.join(outDir, `${deliverableId}-draft.png`),
        mime: "image/png",
        width: 3,
        height: 3,
        prompt: "fake draft image",
        variantOf: null,
      }],
      notes: "草稿清单损坏：path 写成了绝对路径。",
    }
    : {
      schemaVersion: 1,
      outputs: files.map((file, index) => ({
        deliverableId: ids[index] ?? deliverableId,
        path: `.council/out/${file.name}`,
        mime: "image/png",
        width: 2,
        height: 2,
        prompt: `fake image ${String(index + 1)}${inputs.length > 0 ? " with reference" : ""}`,
        variantOf: null,
      })),
      notes: `生成 ${String(files.length)} 张占位图，参考图 ${String(inputs.length)} 张。`,
    };
  const message = JSON.stringify(manifest);
  writeFileSync(lastMessagePath, message);
  process.stdout.write([
    JSON.stringify({ type: "thread.started", thread_id: "fake-image-thread" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }),
    "",
  ].join("\n"));
}

// ---- P4 Worker 团队替身（COUNCIL_TEAM_E2E）----
// Lead 每段最多停留约 3.8 秒（E2E 的 Claude 单进程超时 5 秒），未等到两个 Worker 的文件被合并进来就写进度文件并以
// canContinue:true 交接，靠分段接续撑过 Worker 执行与合并；首段先真实拉起注入的 council MCP，核对只注册了六个团队工具。
const TEAM_TOOLS = [
  "council_archive_worker", "council_dispatch_worker", "council_interrupt_worker",
  "council_list_workers", "council_merge_worker", "council_wait_worker",
];
const TEAM_LEAD_SEGMENT_MS = 2_500;

function teamResult(result) {
  process.stdout.write(JSON.stringify({ type: "result", result, session_id: "fake-team-session" }));
}

function teamFail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function mcpServersFromArgs() {
  try {
    return JSON.parse(optionValue("--mcp-config") ?? "{}").mcpServers ?? {};
  } catch {
    return undefined;
  }
}

/** 按注入配置启动 council MCP，走 initialize → tools/list → council_list_workers，返回工具名与调用结果。 */
async function probeLeadMcp(server) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), 3_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`MCP ${method} 失败：${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1.0.0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = (await call(2, "tools/list", {})).tools.map((tool) => tool.name).sort();
    const listed = await call(3, "tools/call", { name: "council_list_workers", arguments: {} });
    return { tools, listed };
  } finally {
    child.kill();
  }
}

async function fakeTeam(text) {
  const servers = mcpServersFromArgs();
  if (text.includes("你是 Worker 团队中的 Worker")) {
    // Worker 不得拿到任何 Council MCP；brief 形如 `dir=<目录> delay=<毫秒>`。
    if (!servers || Object.keys(servers).length > 0) return teamFail("Worker 不应注入 MCP");
    const dir = /dir=([A-Za-z0-9_-]+)/u.exec(text)?.[1] ?? "worker";
    const delay = Number(/delay=(\d+)/u.exec(text)?.[1] ?? "0");
    await new Promise((resolve) => setTimeout(resolve, delay));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "worker.txt"), `${dir} done\n`);
    return teamResult(`Worker 已写入 ${dir}/worker.txt。`);
  }
  if (text.includes("只返回一个 JSON 对象")) {
    return teamResult(JSON.stringify({
      verdict: "approved", summary: "Lead 与已合并 Worker 的提交符合验收标准。", findings: [],
      inspectedFiles: ["team-lead.txt", "team-a/worker.txt", "team-b/worker.txt"],
    }));
  }
  if (!text.includes("你是本次任务的 executor")) return teamResult("COUNCIL_TEAM_E2E：Lead 派发两个 Worker 并合并。");
  const council = servers?.council;
  if (!council?.env?.COUNCIL_TEAM_LEAD_DELEGATION_ID || !text.includes("## 团队模式")) {
    return teamFail("Lead 缺少团队 MCP 注入或团队模式指令");
  }
  const started = Date.now();
  if (!existsSync("team-lead-progress.txt")) {
    const { tools, listed } = await probeLeadMcp(council);
    if (JSON.stringify(tools) !== JSON.stringify(TEAM_TOOLS)) return teamFail(`Lead MCP 工具面不符：${tools.join(",")}`);
    if (listed.isError) return teamFail(`council_list_workers 失败：${JSON.stringify(listed.content)}`);
  }
  while (Date.now() - started < TEAM_LEAD_SEGMENT_MS) {
    if (existsSync(path.join("team-a", "worker.txt")) && existsSync(path.join("team-b", "worker.txt"))) {
      writeFileSync("team-lead.txt", "lead merged team-a and team-b\n");
      return teamResult("已合并 team-a 与 team-b，Lead 收尾完成。");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  writeFileSync("team-lead-progress.txt", `${String(Date.now())}\n`);
  return teamResult("等待 Worker 合并。\n```json\nCOUNCIL_CHECKPOINT\n" + JSON.stringify({
    completed: ["已派发 Worker"], validation: ["等待合并"], remaining: ["合并 team-a 与 team-b"], canContinue: true,
  }) + "\n```");
}
