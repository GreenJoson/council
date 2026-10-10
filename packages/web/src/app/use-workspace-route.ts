/**
 * @input  依赖：React、routes 纯函数、浏览器 location.hash / history / hashchange 事件
 * @output 导出：useWorkspaceRoute —— 当前 WorkspaceRoute 与 navigate(route, { replace }) 导航函数
 * @pos    hash 路由的唯一副作用入口：挂载时把空/未知 hash 规范化为 #/discussion（replace，不污染历史），
 *         订阅 hashchange 以响应浏览器前进后退与手改地址栏；push 走 location.hash 赋值以保留后退能力
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildHash, parseRoute, type WorkspaceRoute } from "./routes";

export interface NavigateOptions {
  /** true 时替换当前历史条目（用于把选中议题同步进 URL），不产生新的后退记录 */
  replace?: boolean;
}

/** 把任意 hash 收敛为规范形式，保证状态里存的字符串与地址栏一一对应 */
function canonicalHash(hash: string): string {
  return buildHash(parseRoute(hash));
}

export function useWorkspaceRoute(): {
  route: WorkspaceRoute;
  navigate: (route: WorkspaceRoute, options?: NavigateOptions) => void;
} {
  const [hash, setHash] = useState(() => canonicalHash(window.location.hash));

  useEffect(() => {
    // 空 hash、未知视图或非规范写法（如 #discussion）就地替换为规范 hash
    const initial = canonicalHash(window.location.hash);
    if (window.location.hash !== initial) {
      window.history.replaceState(window.history.state, "", initial);
    }
    const handleHashChange = () => {
      const next = canonicalHash(window.location.hash);
      if (window.location.hash !== next) {
        window.history.replaceState(window.history.state, "", next);
      }
      setHash(next);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const navigate = useCallback((route: WorkspaceRoute, options?: NavigateOptions) => {
    const next = buildHash(route);
    if (window.location.hash === next) {
      setHash(next);
      return;
    }
    if (options?.replace) {
      // replaceState 不触发 hashchange，需要手动同步状态
      window.history.replaceState(window.history.state, "", next);
    } else {
      // 赋值 location.hash 会新增历史条目并异步触发 hashchange；这里先同步状态，避免一帧旧视图
      window.location.hash = next;
    }
    setHash(next);
  }, []);

  const route = useMemo(() => parseRoute(hash), [hash]);
  return { route, navigate };
}
