/**
 * @input  依赖：packages/web/src 下的源码文本与英文词典
 * @output 验证：每一处 t("中文") 字面量都能在 catalog.en.ts 里查到英文
 * @pos    双语不倒退的机械守卫；新写的中文文案漏翻译时这里先红，而不是等英文界面漏出中文
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { englishCatalog } from "../src/i18n/catalog.en";

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const HAS_CHINESE = /[一-鿿]/u;

/**
 * 只认 t("…") / t(`…`) 这种字面量调用。
 * t(变量) 的键存在各文件顶部的常量表里，静态扫不出来，也不该在这里猜。
 */
const LITERAL_CALL = /\bt\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/gu;

const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
};

/** 源码里是 \n 两个字符，词典键里是真正的换行；不还原就会把它误报成缺翻译。 */
function unescape(literal: string): string {
  return literal.replace(/\\(.)/gu, (_, char: string) => ESCAPES[char] ?? char);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("英文词典覆盖率", () => {
  it("每一处 t(\"中文\") 都有英文条目", () => {
    const missing: string[] = [];
    for (const path of sourceFiles(SOURCE_ROOT)) {
      if (path.includes(join("src", "i18n"))) {
        continue;
      }
      for (const match of readFileSync(path, "utf8").matchAll(LITERAL_CALL)) {
        const source = unescape(match[2] ?? "");
        if (!HAS_CHINESE.test(source) || source in englishCatalog) {
          continue;
        }
        missing.push(`${path.slice(SOURCE_ROOT.length + 1)}: ${source}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
