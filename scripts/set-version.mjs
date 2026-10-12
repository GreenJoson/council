/**
 * @input  依赖：命令行参数里的新版本号（x.y.z），以及桌面包里记录版本号的各个文件
 * @output 导出：把桌面版本号一次改齐——tauri.conf.json（正本）、desktop package.json / package-lock.json、
 *         Cargo.toml / Cargo.lock 的 council-desktop 条目、中英文 README 首屏的「当前桌面版本」
 * @pos    本地发版第一步（npm run version:set -- x.y.z），流程见 docs/local-release.md
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "packages/desktop");
const tauriConfigPath = path.join(desktopRoot, "src-tauri/tauri.conf.json");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  process.stderr.write(`[version:set] ${message}\n`);
  process.exit(1);
}

function compareVersions(a, b) {
  const pa = SEMVER.exec(a).slice(1).map(Number);
  const pb = SEMVER.exec(b).slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pa[index] - pb[index];
  }
  return 0;
}

/**
 * 只做文本替换，不重新序列化：保留各文件原有缩进与换行。
 * 每处替换都要求「恰好命中 expected 次」，命中数不对说明文件结构变了，宁可停下也不猜。
 */
function replaceExact(text, pattern, replacement, expected, label) {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? [];
  if (matches.length !== expected) {
    fail(`${label}：预期命中 ${expected} 处，实际 ${matches.length} 处，文件结构可能变了，未做任何修改。`);
  }
  return text.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), replacement);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const next = process.argv[2];
if (!next || !SEMVER.test(next)) {
  fail("用法：npm run version:set -- <x.y.z>，例如 npm run version:set -- 0.10.2");
}

const current = JSON.parse(readFileSync(tauriConfigPath, "utf8")).version;
if (typeof current !== "string" || !SEMVER.test(current)) {
  fail(`tauri.conf.json 里的当前版本号不是 x.y.z：${String(current)}`);
}
if (compareVersions(next, current) <= 0) {
  fail(`新版本 ${next} 必须大于当前版本 ${current}。`);
}

const old = escapeRegExp(current);

// 先在内存里把所有文件改好、逐个校验，全部通过才落盘，避免改一半。
const edits = [
  {
    file: tauriConfigPath,
    apply: (text) => replaceExact(text, new RegExp(`("version": )"${old}"`), `$1"${next}"`, 1, "tauri.conf.json"),
    verify: (text) => JSON.parse(text).version === next,
  },
  {
    file: path.join(desktopRoot, "package.json"),
    apply: (text) => replaceExact(text, new RegExp(`^(  "version": )"${old}"`, "m"), `$1"${next}"`, 1, "package.json"),
    verify: (text) => JSON.parse(text).version === next,
  },
  {
    // 根对象与 packages[""] 各记一份；依赖条目的缩进更深，不会被 ^ 加两/六格空格的模式误伤。
    file: path.join(desktopRoot, "package-lock.json"),
    apply: (text) => {
      const top = replaceExact(text, new RegExp(`^(  "version": )"${old}"`, "m"), `$1"${next}"`, 1, "package-lock.json 根版本");
      return replaceExact(top, new RegExp(`^(      "version": )"${old}"(,\\n      "devDependencies")`, "m"), `$1"${next}"$2`, 1, "package-lock.json packages[\"\"]");
    },
    verify: (text) => {
      const lock = JSON.parse(text);
      return lock.version === next && lock.packages?.[""]?.version === next;
    },
  },
  {
    file: path.join(desktopRoot, "src-tauri/Cargo.toml"),
    apply: (text) => replaceExact(text, new RegExp(`(\\[package\\]\\nname = "council-desktop"\\nversion = )"${old}"`), `$1"${next}"`, 1, "Cargo.toml"),
    verify: (text) => text.includes(`name = "council-desktop"\nversion = "${next}"`),
  },
  {
    // test:rust 用 --locked，锁文件里的自身版本不同步会直接构建失败。
    file: path.join(desktopRoot, "src-tauri/Cargo.lock"),
    apply: (text) => replaceExact(text, new RegExp(`(name = "council-desktop"\\nversion = )"${old}"`), `$1"${next}"`, 1, "Cargo.lock"),
    verify: (text) => text.includes(`name = "council-desktop"\nversion = "${next}"`),
  },
  {
    file: path.join(repoRoot, "README.zh.md"),
    apply: (text) => replaceExact(text, new RegExp(`(当前桌面版本为 \\*\\*)${old}(\\*\\*)`), `$1${next}$2`, 1, "README.zh.md"),
    verify: (text) => text.includes(`当前桌面版本为 **${next}**`),
  },
  {
    file: path.join(repoRoot, "README.md"),
    apply: (text) => replaceExact(text, new RegExp(`(The current desktop release is \\*\\*)${old}(\\*\\*)`), `$1${next}$2`, 1, "README.md"),
    verify: (text) => text.includes(`The current desktop release is **${next}**`),
  },
];

const results = edits.map(({ file, apply, verify }) => {
  const updated = apply(readFileSync(file, "utf8"));
  if (!verify(updated)) {
    fail(`${path.relative(repoRoot, file)} 改完校验不通过，未做任何修改。`);
  }
  return { file, updated };
});

for (const { file, updated } of results) {
  writeFileSync(file, updated);
}

process.stdout.write(
  [
    `[version:set] ${current} → ${next}，已更新：`,
    ...results.map(({ file }) => `  ${path.relative(repoRoot, file)}`),
    "下一步：把 README 更新日志的「未发布」归到这个版本，提交后再 npm run build:desktop。",
    "",
  ].join("\n"),
);
