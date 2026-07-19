/**
 * @input  依赖：已配置的 Council HTTP/Web 环境变量和两个包的开发命令
 * @output 导出：同时运行本地 API 与 Operator Console 的开发进程
 * @pos    根目录一键开发入口和子进程生命周期协调器
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { spawn } from "node:child_process";

const commands = [
  {
    name: "api",
    args: ["run", "dev:http", "--prefix", "packages/mcp-server"],
  },
  {
    name: "web",
    args: ["run", "dev", "--prefix", "packages/web"],
  },
];

const children = commands.map(({ name, args }) => {
  const child = spawn("npm", args, {
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`[dev:${name}] 启动失败：${error.message}\n`);
  });
  return { name, child };
});

let shuttingDown = false;
let exitCode = 0;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(signal));
}

await Promise.all(
  children.map(
    ({ name, child }) =>
      new Promise((resolve) => {
        child.once("close", (code, signal) => {
          if (!shuttingDown) {
            exitCode = code ?? (signal ? 1 : 0);
            if (exitCode !== 0 || signal) {
              process.stderr.write(`[dev:${name}] 已异常退出。\n`);
            }
            shutdown("SIGTERM");
          }
          resolve();
        });
      }),
  ),
);

process.exitCode = exitCode;
