/**
 * @input  依赖：npm run build:desktop 产出的 Council.app、tauri.conf.json（版本与 identifier 正本）、
 *         桌面设置 settings.json 里的 orchestrationBaseUrl、本地 Agent Service 的 /api/v1/status 与停止接口、
 *         macOS 自带的 plutil / ditto / pgrep / osascript / open
 * @output 导出：把新构建安全替换进本机安装位置——先检查（干净提交、构建不早于 HEAD、版本号必须比已装的新、
 *         没有任务在执行），再退出应用、停服务、打包备份旧应用、替换、逐字节核对、启动并核对 schema 与日志库身份
 * @pos    本地发版最后一步（npm run desktop:install），流程与回退见 docs/local-release.md
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(repoRoot, "packages/desktop/src-tauri");
const tauriConfig = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
const productName = tauriConfig.productName;
const identifier = tauriConfig.identifier;
const sourceVersion = tauriConfig.version;

const bundlePath = path.join(tauriDir, `target/release/bundle/macos/${productName}.app`);
const installedPath = readOption("--app") ?? `/Applications/${productName}.app`;
const appDataDir = path.join(os.homedir(), "Library/Application Support", identifier);
const backupDir = path.join(appDataDir, "app-backups");

// 与桌面端 settings.rs 的 DEFAULT_ORCHESTRATION_BASE_URL 一致；设置里改过地址时以设置为准。
const DEFAULT_BASE_URL = "http://127.0.0.1:4317";
const QUIT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 180_000;
// 内置限流 120 次/分钟且与桌面轮询共用，2 秒一次足够轻。
const POLL_INTERVAL_MS = 2_000;

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function log(message) {
  process.stdout.write(`[desktop:install] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[desktop:install] 中止：${message}\n`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tildify = (value) => value.replace(os.homedir(), "~");

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pa[index] - pb[index];
  }
  return 0;
}

function nextPatch(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function plistValue(appPath, key) {
  return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", path.join(appPath, "Contents/Info.plist")], {
    encoding: "utf8",
  }).trim();
}

const bundleVersion = (appPath) => plistValue(appPath, "CFBundleShortVersionString");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Contents/MacOS 下是桌面壳与内置 Agent Service 两个可执行文件，逐个比哈希判断是不是同一个构建。 */
function executableDigests(appPath) {
  const dir = path.join(appPath, "Contents/MacOS");
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, sha256(path.join(dir, name))]),
  );
}

function sameExecutables(a, b) {
  const da = executableDigests(a);
  const db = executableDigests(b);
  const names = Object.keys(da);
  return names.length === Object.keys(db).length && names.every((name) => da[name] === db[name]);
}

function pidsMatching(pattern) {
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return result.stdout.split(/\s+/).filter(Boolean);
}

/** 只认安装位置下的进程（桌面壳 + 内置 Agent Service），不碰开发服务器或别处的同名进程。 */
const appPids = (appPath) => pidsMatching(`${appPath}/Contents/`);

function readBaseUrl() {
  try {
    const settings = JSON.parse(readFileSync(path.join(appDataDir, "settings.json"), "utf8"));
    return {
      baseUrl: typeof settings.orchestrationBaseUrl === "string" ? settings.orchestrationBaseUrl : DEFAULT_BASE_URL,
      autostart: settings.orchestrationAutostart !== false,
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, autostart: true };
  }
}

/** 直接用 node:http 访问本机服务，不经过环境里的代理设置。 */
function requestJson(method, url, body) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve) => {
    const request = client.request(
      target,
      {
        method,
        timeout: 5_000,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => resolve(undefined));
    if (payload) request.write(payload);
    request.end();
  });
}

async function readStatus(baseUrl) {
  const response = await requestJson("GET", `${baseUrl}/api/v1/status`);
  return response?.status === 200 ? response.json?.data : undefined;
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return predicate();
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function counts(status) {
  return {
    topics: status.topics,
    messages: status.messages,
    decisions: status.decisions,
    workItems: status.workItems,
  };
}

// ── 1. 检查新构建 ─────────────────────────────────────────────────────────────

if (process.platform !== "darwin") fail("只支持 macOS。");
if (!existsSync(bundlePath)) fail("找不到安装包，先运行 npm run build:desktop。");

const newVersion = bundleVersion(bundlePath);
if (newVersion !== sourceVersion) {
  fail(`安装包版本 ${newVersion} 与源码版本 ${sourceVersion} 不一致，先重新 npm run build:desktop。`);
}
if (git(["status", "--porcelain"])) {
  fail("工作区有未提交的改动。发版必须从干净提交构建：先提交，再重新 npm run build:desktop。");
}
const headCommit = git(["rev-parse", "--short", "HEAD"]);
const headTime = Number(git(["log", "-1", "--format=%ct"])) * 1000;
const executable = plistValue(bundlePath, "CFBundleExecutable");
const bundleBuiltAt = statSync(path.join(bundlePath, "Contents/MacOS", executable)).mtimeMs;
if (bundleBuiltAt < headTime) {
  fail(`安装包构建时间早于最新提交 ${headCommit}，先重新 npm run build:desktop。`);
}

// ── 2. 对比已安装的版本 ──────────────────────────────────────────────────────

const installedExists = existsSync(installedPath);
const installedVersion = installedExists ? bundleVersion(installedPath) : undefined;
const { baseUrl, autostart } = readBaseUrl();

if (installedExists && sameExecutables(bundlePath, installedPath)) {
  log(`已安装的就是这个构建（${newVersion}，提交 ${headCommit}），无需替换。`);
  if (appPids(installedPath).length === 0) {
    execFileSync("open", [installedPath]);
    log("应用未在运行，已启动。");
  }
  process.exit(0);
}
if (installedVersion) {
  const order = compareVersions(newVersion, installedVersion);
  if (order === 0) {
    fail(`版本号没变（${newVersion}），替换后分不清新旧。先 npm run version:set -- ${nextPatch(newVersion)}，提交后重新构建。`);
  }
  if (order < 0) {
    fail(`新构建 ${newVersion} 比已安装的 ${installedVersion} 旧（已装的可能来自别的分支）。拒绝降级；要回退请用 ${tildify(backupDir)} 里的备份。`);
  }
}

// ── 3. 退出应用并停掉 Agent Service ─────────────────────────────────────────

const before = await readStatus(baseUrl);
if (before && appPids(installedPath).length === 0) {
  fail(`${baseUrl} 上的 Agent Service 不属于已安装的应用（可能是开发服务器），先停掉它再装。`);
}
if (before && before.worker?.activeTasks > 0) {
  fail(`后台有 ${before.worker.activeTasks} 个任务在执行，替换会中断它们。等它们结束或在应用里取消后再装。`);
}

if (installedExists && appPids(installedPath).length > 0) {
  log(`退出 ${productName} ${installedVersion} …`);
  spawnSync("osascript", ["-e", `if application id "${identifier}" is running then tell application id "${identifier}" to quit`]);
  const quit = await waitUntil(
    () => pidsMatching(`${installedPath}/Contents/MacOS/${executable}`).length === 0,
    QUIT_TIMEOUT_MS,
  );
  if (!quit) fail("应用没有在 30 秒内退出（可能弹了确认框），请手动退出后重试。");

  // 应用退出后服务可能还活着（它独立于窗口运行）；走停止接口让它自己收尾，绝不直接杀进程。
  const running = await readStatus(baseUrl);
  if (running) {
    const stop = await requestJson("POST", `${baseUrl}/api/v1/service/actions/stop`, {
      databaseInstanceId: running.databaseInstanceId,
    });
    if (stop && stop.status !== 200) {
      execFileSync("open", [installedPath]);
      fail(`停止 Agent Service 被拒（HTTP ${stop.status}：${stop.json?.message ?? "无说明"}），已重新打开应用，未做任何替换。`);
    }
  }
  const stopped = await waitUntil(async () => appPids(installedPath).length === 0 && !(await readStatus(baseUrl)), STOP_TIMEOUT_MS);
  if (!stopped) fail("旧的 Agent Service 一分钟内没有退出，未做任何替换。请在应用里确认没有任务后重试。");
}

// ── 4. 备份旧应用并替换 ─────────────────────────────────────────────────────

let backupFile;
if (installedExists) {
  mkdirSync(backupDir, { recursive: true });
  backupFile = path.join(backupDir, `${productName}-${installedVersion}-${timestamp()}.app.zip`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", installedPath, backupFile]);
  log(`旧应用已备份：${tildify(backupFile)}`);
  rmSync(installedPath, { recursive: true, force: true });
}
execFileSync("ditto", [bundlePath, installedPath]);
if (!sameExecutables(bundlePath, installedPath)) {
  fail(`替换后可执行文件与安装包不一致，请检查 ${installedPath}；旧应用备份在 ${backupFile ? tildify(backupFile) : "（无）"}。`);
}
log(`已替换为 ${newVersion}（提交 ${headCommit}），可执行文件逐字节一致。`);

// ── 5. 启动并核对 ───────────────────────────────────────────────────────────

execFileSync("open", [installedPath]);
if (!autostart) {
  log("设置里关闭了自动启动 Agent Service，跳过就绪核对。");
  process.exit(0);
}
let after;
const ready = await waitUntil(async () => {
  after = await readStatus(baseUrl);
  return after?.ready === true;
}, READY_TIMEOUT_MS);
if (!ready) fail("新版本启动后 3 分钟内 Agent Service 未就绪，请打开应用查看提示。");

const notes = [`就绪：schema v${after.schemaVersion}`];
if (before) {
  if (after.schemaVersion !== before.schemaVersion) {
    notes.push(`schema 从 v${before.schemaVersion} 升到 v${after.schemaVersion}（迁移器已在日志库同目录留迁移前备份）`);
  }
  if (after.databaseInstanceId !== before.databaseInstanceId) {
    notes.push("⚠️ 日志库身份与替换前不同，请确认设置里选的是原来的日志库");
  }
  const was = counts(before);
  const now = counts(after);
  const shrunk = Object.keys(was).filter((key) => now[key] < was[key]);
  notes.push(`数据：议题 ${now.topics} / 消息 ${now.messages} / 决策 ${now.decisions} / 任务 ${now.workItems}`);
  if (shrunk.length) notes.push(`⚠️ 这些计数比替换前少：${shrunk.join("、")}`);
}
log(`${installedVersion ?? "（未安装）"} → ${newVersion} 完成。${notes.join("；")}。`);
