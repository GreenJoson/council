# hooks - Council Web 跨组件复用逻辑

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `useTopicDetails.ts` | 数据加载 | 按 topicId 列表懒加载 `CouncilRepository.loadTopicDetail`，以 Map 缓存已加载结果，支持按 id 单独重试；决策记录视图（单选一条）与架构档案视图（一次性加载全部议题）共用同一份"懒加载 + 缓存 + StrictMode 双挂载守卫"逻辑 |
