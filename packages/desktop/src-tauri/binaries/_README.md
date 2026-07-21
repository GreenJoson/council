# binaries - Tauri sidecar 生成目录

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `council-agent-service-<target-triple>` | 构建产物 | 由 `scripts/build-agent-sidecar.mjs` 生成并交给 Tauri `externalBin` 打包，不纳入 Git |

本目录只保存构建产物。开发、检查、测试和发行构建会先运行 sidecar 构建脚本；禁止提交包含 Node 运行时的二进制文件。
