/**
 * @input  依赖：React
 * @output 导出：useToast —— 当前 toast 文案与设置函数，2.8 秒后自动清除
 * @pos    App 壳共享的轻提示状态，内容、编排与实施项写操作都通过同一个 setter 报告成功
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useEffect, useState } from "react";

export function useToast(): [string | null, (message: string | null) => void] {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const timeoutId = window.setTimeout(() => setToastMessage(null), 2800);
    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  return [toastMessage, setToastMessage];
}
