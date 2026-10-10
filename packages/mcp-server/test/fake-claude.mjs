/**
 * @input  依赖：ClaudeRuntime / CodexRuntime 传入的版本、认证、特性列表或生成参数与 stdin prompt
 * @output 导出：可用性检查、长上下文与 Markdown 交接边界的子进程 E2E 协议响应；
 *         Codex 侧另有 `login status`、`features list`（image_generation stable true）与
 *         `exec --enable image_generation` 生图替身（写 2 张最小合法 PNG 到 <cd>/.council/out 并输出清单）
 * @pos    测试专用的 Claude Code / Codex CLI 最小协议替身
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);

// 2x2 最小合法 PNG：一张 RGB、一张带 alpha（RGBA），内容不同以免被 sha256 去重。
const PNG_RGB = "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73000000104944415478da63d0cabf06440c100a00258205bd8c994e360000000049454e44ae426082";
const PNG_RGBA = "89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d24000000114944415478da637810a5dd00c20c30060046e40795e9ff745a0000000049454e44ae426082";

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

/** Codex 生图替身：按 brief 提示词中的 deliverableId 写产物与清单；参考图必须真实存在。 */
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
  for (const file of files) writeFileSync(path.join(outDir, file.name), Buffer.from(file.hex, "hex"));
  const manifest = {
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
