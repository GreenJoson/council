/**
 * @input  依赖：已安装的 Node.js、Rust host triple、esbuild、postject 与 MCP 服务源码
 * @output 生成：供 Tauri externalBin 打包的 Council Agent Service 单文件可执行程序
 * @pos    桌面构建链中把 Node 编排服务封装为免安装 sidecar 的唯一入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const DESKTOP_DIR = join(ROOT_DIR, "packages", "desktop");
const MCP_DIR = join(ROOT_DIR, "packages", "mcp-server");
const TAURI_DIR = join(DESKTOP_DIR, "src-tauri");
const BUILD_DIR = join(DESKTOP_DIR, ".sidecar-build");
const CACHE_DIR = join(DESKTOP_DIR, ".sidecar-cache");
const BINARIES_DIR = join(TAURI_DIR, "binaries");
const RESOURCES_DIR = join(TAURI_DIR, "resources");
const ENTRY_FILE = join(MCP_DIR, "dist", "src", "http-index.js");
const BUNDLE_FILE = join(BUILD_DIR, "agent-service.cjs");
const BUNDLE_LEGAL_FILE = `${BUNDLE_FILE}.LEGAL.txt`;
const SEA_CONFIG_FILE = join(BUILD_DIR, "sea-config.json");
const SEA_BLOB_FILE = join(BUILD_DIR, "agent-service.blob");
const BUILD_CONFIG_FILE = join(DESKTOP_DIR, "sidecar-build.json");
const SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const desktopRequire = createRequire(join(DESKTOP_DIR, "package.json"));
const { build } = desktopRequire("esbuild");
const postjectBin = join(
  DESKTOP_DIR,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "postject.cmd" : "postject",
);

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    ...options,
  });
}

function output(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateBuildHost(targetTriple) {
  if (process.platform !== "darwin") {
    throw new Error("当前 Council sidecar 构建链仅支持 macOS；其他平台需增加对应签名流程。");
  }
  const architectureNames = { arm64: "aarch64", x64: "x86_64" };
  const expectedArchitecture = architectureNames[process.arch];
  if (!expectedArchitecture) {
    throw new Error(`不支持的 macOS Node 架构：${process.arch}。`);
  }
  if (!targetTriple.startsWith(`${expectedArchitecture}-`)) {
    throw new Error(
      `Node 架构 ${process.arch} 与 Rust 目标 ${targetTriple} 不一致，不能生成可用 sidecar。`,
    );
  }
}

function loadBuildConfig() {
  const value = JSON.parse(readFileSync(BUILD_CONFIG_FILE, "utf8"));
  const architecture = value?.platforms?.darwin?.[process.arch];
  if (
    typeof value?.nodeVersion !== "string"
    || typeof value?.downloadBaseUrl !== "string"
    || typeof architecture?.archive !== "string"
    || typeof architecture?.sha256 !== "string"
  ) {
    throw new Error("sidecar-build.json 缺少当前 macOS 架构所需的 Node.js 构建配置。");
  }
  if (architecture.archive !== architecture.archive.split("/").at(-1)) {
    throw new Error("sidecar-build.json 的 archive 只能是文件名。");
  }
  return {
    nodeVersion: value.nodeVersion,
    downloadBaseUrl: value.downloadBaseUrl,
    archive: architecture.archive,
    expectedSha256: architecture.sha256,
  };
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`下载 Node.js 官方运行时失败：HTTP ${String(response.status)}。`);
  }
  writeFileSync(destination, new Uint8Array(await response.arrayBuffer()));
}

async function prepareOfficialNode() {
  const config = loadBuildConfig();
  mkdirSync(CACHE_DIR, { recursive: true });
  const archivePath = join(CACHE_DIR, config.archive);
  if (!existsSync(archivePath) || sha256(archivePath) !== config.expectedSha256) {
    rmSync(archivePath, { force: true });
    const url = new URL(
      `v${config.nodeVersion}/${config.archive}`,
      `${config.downloadBaseUrl.replace(/\/+$/, "")}/`,
    );
    await download(url, archivePath);
  }
  if (sha256(archivePath) !== config.expectedSha256) {
    rmSync(archivePath, { force: true });
    throw new Error("Node.js 官方运行时 SHA-256 校验失败，已删除不可信缓存。");
  }

  const runtimeDir = join(BUILD_DIR, "node-runtime");
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", runtimeDir]);
  const extractedName = config.archive.replace(/\.tar\.gz$/, "");
  const nodeRoot = join(runtimeDir, extractedName);
  const nodeBinary = join(nodeRoot, "bin", "node");
  const nodeLicense = join(nodeRoot, "LICENSE");
  if (!existsSync(nodeBinary) || !existsSync(nodeLicense)) {
    throw new Error("Node.js 官方运行时归档结构无效。");
  }
  return { nodeBinary, nodeLicense };
}

async function main() {
  const targetTriple = output("rustc", ["--print", "host-tuple"]);
  validateBuildHost(targetTriple);

  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });
  mkdirSync(BINARIES_DIR, { recursive: true });
  mkdirSync(RESOURCES_DIR, { recursive: true });
  const officialNode = await prepareOfficialNode();

  run("npm", ["run", "build", "--prefix", MCP_DIR]);
  await build({
    entryPoints: [ENTRY_FILE],
    outfile: BUNDLE_FILE,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    legalComments: "external",
    sourcemap: false,
    logLevel: "info",
  });

  writeFileSync(
    SEA_CONFIG_FILE,
    `${JSON.stringify({
      main: BUNDLE_FILE,
      output: SEA_BLOB_FILE,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }, null, 2)}\n`,
    "utf8",
  );
  run(officialNode.nodeBinary, ["--experimental-sea-config", SEA_CONFIG_FILE]);

  const sidecarPath = join(BINARIES_DIR, `council-agent-service-${targetTriple}`);
  copyFileSync(officialNode.nodeBinary, sidecarPath);
  chmodSync(sidecarPath, 0o755);
  run("codesign", ["--remove-signature", sidecarPath]);
  run(postjectBin, [
    sidecarPath,
    "NODE_SEA_BLOB",
    SEA_BLOB_FILE,
    "--sentinel-fuse",
    SEA_SENTINEL,
    "--macho-segment-name",
    "NODE_SEA",
  ]);
  run("codesign", ["--force", "--sign", "-", sidecarPath]);
  run("codesign", ["--verify", "--verbose=2", sidecarPath]);

  copyFileSync(officialNode.nodeLicense, join(RESOURCES_DIR, "node-LICENSE"));
  copyFileSync(
    BUNDLE_LEGAL_FILE,
    join(RESOURCES_DIR, "agent-service-THIRD-PARTY-NOTICES.txt"),
  );
  const bundleBytes = readFileSync(BUNDLE_FILE).byteLength;
  process.stdout.write(
    `Council Agent Service 已生成：${targetTriple}，业务包 ${String(bundleBytes)} bytes。\n`,
  );
}

await main();
