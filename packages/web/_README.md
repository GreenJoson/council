# web - Council Operator Console 前端

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 工程 | 锁定 React、Vite、字体、图标与测试依赖 |
| `package-lock.json` | 锁定 | 固化前端依赖解析结果 |
| `index.html` | 入口 | 提供浏览器根文档和无障碍跳转入口 |
| `vite.config.ts` | 构建 | 配置 React 开发服务和生产构建 |
| `tsconfig*.json` | 类型 | 启用严格 TypeScript 和浏览器类型检查 |
| `.env.example` | 配置 | 声明数据模式和后续本地 API 地址 |
| `src/` | 核心 | 保存应用、组件、数据边界、样式和类型 |
| `test/` | 验证 | 验证 mock repository 状态转换及桌面、移动端浏览器交互 |

## 使用

```bash
npm install
npm run dev
```

当前 `VITE_COUNCIL_DATA_MODE` 只支持 `mock`。`VITE_COUNCIL_API_URL` 为下一阶段本地 API 适配器预留，不应在源码中写死服务地址。
