/**
 * @input  依赖：ClaudeRuntime 传入的版本、认证或生成参数与 stdin prompt
 * @output 导出：可用性检查和真实子进程 E2E 所需的稳定 JSON 响应
 * @pos    测试专用的 Claude Code CLI 最小协议替身
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n", () => process.exit(0));
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
