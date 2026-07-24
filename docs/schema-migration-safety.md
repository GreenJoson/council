# SQLite Schema 迁移安全

Council 的生产数据库只有一个 schema 迁移所有者：Node Agent Service 的
`schema-migrator.ts`。MCP、HTTP 和桌面 sidecar 均先经过该入口；Rust
`council-core`、`CouncilDatabase`、`SQLiteCouncilStore` 与设置仓储只验证并消费已经
迁移完成的结构，不得在构造函数中执行生产 DDL。

## 启动顺序

1. 加载并校验数据目录、busy timeout 与迁移重试上限。
2. 对照 `schema_migrations` 与 `PRAGMA user_version`。账本必须从版本 1 连续且每版唯一，
   任一非零时两者必须完全一致；未来版本、空洞、重复或镜像不一致会立即失败关闭。
3. 执行 `PRAGMA wal_checkpoint(TRUNCATE)`，只有确认没有 busy 且 WAL 已完整 checkpoint
   后才继续。
4. checkpoint 后重新采集 schema、行数和 `data_version`。只要存在用户 schema 对象，
   就使用 Node 官方 SQLite online backup 在数据库同目录创建迁移前备份；只有真正空库跳过。
5. 以只读连接验证备份的 `quick_check`、外键、schema、行数和版本。
6. 获取 `BEGIN EXCLUSIVE`；如果 backup 与锁之间的 `data_version` 已改变，则放弃本次
   尝试并按配置重试，绝不在旧快照上迁移。
7. 在同一排他事务中执行 DDL、生成不含路径信息的数据库实例 UUID、写入版本镜像，
   并用 canonical 内存库生成的规范化 SQL 精确验证必需表、索引、触发器，再验证行数、
   foreign key、`quick_check` 和 content/orchestration revision 行为。
8. 提交成功后 HTTP `/api/v1/status` 才返回 `ready=true`、当前 `schemaVersion` 和
   `databaseInstanceId`。桌面 Rust 层必须等待该状态、打开 Store 并精确比对实例身份；
   端口上即使已有另一个 ready 服务，只要身份不同也会失败关闭。

## 失败与恢复语义

- 正常迁移失败首先回滚当前事务。只要 live 数据库仍完整，就保留原库并报告失败；
  不会拿迁移前备份覆盖一个健康 live 数据库。
- checkpoint、backup 与排他锁之间发生并发写入时，只做有界重试；每次重试都会重新判断
  空库/既有库、重新采集 schema/行数/version 并按需生成新备份。重试耗尽后失败关闭，
  外部写入不会丢失。
- WAL checkpoint 被长读事务阻塞时，不创建迁移备份，也不开始 DDL。
- 如果回滚后完整性也无法成立，进程失败关闭并保留已经验证的备份，等待显式人工恢复；
  不在仍可能有其他进程访问数据库时执行危险覆盖。
- 每次迁移前备份均在同目录生成并使用收紧权限，成功迁移也不会自动删除，便于审计和人工恢复。

## 版本规则

当前 schema 版本为 `2`。版本 2 引入动态 Actor Identity、alias、冻结身份快照和 v2
编排运行快照；固定作者枚举的版本 1 只作为迁移输入保留。详细字段、确定性映射与历史
`other` 的待审计语义见 [Actor Identity v2 迁移](actor-identity-migration.md)。

`schema_migrations` 是可审计账本，
`PRAGMA user_version` 是 SQLite 快速版本标记，两者必须镜像一致。新增版本只能扩展 Node
迁移器和相应测试 fixture；Rust 不得引入第二套迁移路径。

迁移重试次数必须由 `COUNCIL_SCHEMA_MIGRATION_MAX_ATTEMPTS` 显式提供；MCP/HTTP 缺失时
启动立即失败。桌面 sidecar 由打包资源显式注入该键，不依赖源码默认值。

测试覆盖 fresh 数据库、v1 内容/运行历史保留、旧作者确定性映射、未知 Actor 新写入拒绝、
canonical schema 反例、备份验证、故障注入回滚、版本不一致、未来版本、首次空库后外部创建、
backup-lock 间隙并发写入、WAL checkpoint 阻塞、数据库身份错配，以及桌面 ready 门。
