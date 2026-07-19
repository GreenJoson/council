/**
 * @input  依赖：Vite 客户端类型
 * @output 导出：import.meta.env 类型声明
 * @pos    Web 包环境变量的 TypeScript 入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COUNCIL_DATA_MODE?: string;
  readonly VITE_COUNCIL_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
