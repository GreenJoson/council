# council-core - SQLite 内容存储核心

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `Cargo.toml` | 工程 | 固定 Rust 版本、SQLite 与领域序列化依赖 |
| `.gitignore` | 工程 | 阻止包含本机构建路径的 Cargo target 产物进入版本库 |
| `src/lib.rs` | 入口 | 导出存储、错误、领域类型和输入结构 |
| `src/error.rs` | 错误 | 定义可识别的 SQLite、NotFound、Conflict 和数据错误 |
| `src/types.rs` | 类型 | 定义与 TypeScript camelCase JSON 兼容的内容领域模型 |
| `src/store.rs` | 核心 | 只验证并读写由 Node 迁移器准备的内容字段、外键、索引、实例身份和 revision |
| `tests/compatibility.rs` | 集成 | 验证分页、跨连接、Node schema fixture、revision、版本镜像和旧/未来结构拒绝 |
| `tests/fixtures/` | 测试结构 | 保存当前 Node schema 的显式 Rust 测试夹具 |

## 公开 API

`CouncilStore::open` 只打开并验证 Node 已迁移的数据库；旧结构、版本镜像不一致或未来版本都会被拒绝。实例提供 `list_topics`、`get_topic`、`create_topic`、`post_message`、`record_decision` 和 `get_revisions`。写入方法接收显式领域输入，不依赖环境变量或固定文件位置。

```bash
CARGO_TARGET_DIR=<temporary-target-dir> cargo test --manifest-path crates/council-core/Cargo.toml
```

连接初始化会启用 WAL、foreign keys、NORMAL synchronous 和可配置 busy timeout。Rust 不执行任何生产 DDL；Node Agent Service 是唯一迁移所有者，桌面端必须等待其 ready 状态后再打开 Rust Store。
