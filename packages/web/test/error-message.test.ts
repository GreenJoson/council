/**
 * @input  依赖：UI 错误文案归一化
 * @output 验证：Tauri 字符串 reject、普通对象与空值都能给出可行动的文案
 * @pos    启动失败路径的回归；这条文案是应用打不开时用户唯一的线索
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import { getErrorMessage } from "../src/data/error-message";

describe("getErrorMessage", () => {
  it("保留 Tauri invoke 的字符串 reject", () => {
    // 真实回归：schema 版本被拒时，桌面核心就是这样把原因传上来的。
    expect(getErrorMessage("Council SQLite schema 版本 7 不受当前桌面核心支持。"))
      .toBe("Council SQLite schema 版本 7 不受当前桌面核心支持。");
  });

  it("保留 Error 实例与普通对象上的 message", () => {
    expect(getErrorMessage(new Error("迁移失败"))).toBe("迁移失败");
    expect(getErrorMessage({ message: "后端不可用" })).toBe("后端不可用");
  });

  it("空白与无信息的值才回落到通用文案", () => {
    for (const value of [undefined, null, "", "   ", {}, { message: "  " }, new Error("")]) {
      expect(getErrorMessage(value)).toBe("发生未知错误");
    }
  });
});
