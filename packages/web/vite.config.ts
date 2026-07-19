/**
 * @input  依赖：Vite 与 React 插件
 * @output 导出：Council Web 构建配置
 * @pos    Web 包的开发服务器和生产构建入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
  },
});
