/**
 * @input  依赖：React、App、主题/语言初始化和分层全局样式（含人工决策、Agent 调用与媒体浏览层）
 * @output 导出：挂载到浏览器根节点的 Council Web 应用
 * @pos    Operator Console 客户端启动入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import "./styles/execution-evidence.css";

import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "./data/theme";
import { I18nProvider } from "./i18n/I18nProvider";
import { initLocale } from "./i18n/locale";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/components.css";
import "./styles/orchestration.css";
import "./styles/runtime-bindings.css";
import "./styles/agent-activity.css";
import "./styles/media.css";
import "./styles/architecture.css";
import "./styles/mentions.css";
import "./styles/model-router.css";
import "./styles/manual-decision.css";
import "./styles/responsive.css";

initTheme();
const initialLocale = initLocale();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("缺少 Council 根节点");
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider initialLocale={initialLocale}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
