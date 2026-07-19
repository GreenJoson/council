/**
 * @input  依赖：Council HTTP v1 的公开分页与浏览器定时器边界
 * @output 导出：Web 配置校验使用的协议常量
 * @pos    防止前端生成后端必然拒绝或浏览器无法正确调度的参数
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const COUNCIL_API_MAX_PAGE_SIZE = 100;
export const MAX_EVENT_REFRESH_ATTEMPTS = 20;
export const BROWSER_MAX_TIMER_DELAY_MS = 2_147_483_647;
