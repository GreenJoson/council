/**
 * @input  依赖：React、App 和全局样式
 * @output 导出：挂载到浏览器根节点的 Council Web 应用
 * @pos    Operator Console 客户端启动入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/components.css";
import "./styles/responsive.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("缺少 Council 根节点");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
