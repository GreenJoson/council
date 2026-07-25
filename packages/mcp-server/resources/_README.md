# resources - 模型路由打包配置

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `provider-catalog.json` | 配置正本 | 定义可添加 Provider、默认连接地址、受控品牌 glyph 和来源元数据；不包含密钥 |

所有远程地址只作为可编辑模板写在配置资源中，不得复制到 `src/` 业务代码。品牌 glyph
只允许引用前端受控组件；`sourceLabel` 说明来源与许可，不代表供应商官方背书。

## 品牌资产来源

- Claude、Kimi、DeepSeek 的离线 SVG path 取自 Simple Icons `16.27.0`，该项目以
  `CC0-1.0` 发布；Council 只保存路径数据，不从网络加载图标。
- OpenAI 的离线 SVG path 取自 Simple Icons `15.12.0`，许可为 `CC0-1.0`；仅在
  直接关联 OpenAI 服务的 Provider/Agent 上展示，并遵循 OpenAI Brand Guidelines。
- Grok 使用 X.AI Corp. 发布、2025 年 2 月起使用的原始图形路径，由 Wikimedia Commons
  归档为 public domain textlogo；该标志仍受商标限制。Council 仅选取原 SVG 中专供
  小尺寸展示的 mark path，不修改路径几何，也不以 X 通用图标代替 Grok。
- 自定义或未知 Provider 使用通用网络 glyph；界面始终显示用户保存的供应商名称，
  不会把不同供应商统一标为 `Other`。
- 品牌名称和 glyph 仅用于识别连接，不表示供应商对 Council 的认可或背书。
