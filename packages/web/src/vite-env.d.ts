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
  readonly VITE_COUNCIL_PROJECT_PATH?: string;
  readonly VITE_COUNCIL_TOPIC_PAGE_SIZE?: string;
  readonly VITE_COUNCIL_MESSAGE_PAGE_SIZE?: string;
  readonly VITE_COUNCIL_EVENT_REFRESH_MAX_ATTEMPTS?: string;
  readonly VITE_COUNCIL_EVENT_REFRESH_RETRY_DELAY_MS?: string;
  readonly VITE_COUNCIL_EVENT_RECOVERY_DELAY_MS?: string;
  readonly VITE_COUNCIL_ORCHESTRATION_PAGE_SIZE?: string;
  readonly VITE_COUNCIL_ORCHESTRATION_RECOVERY_DELAY_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
