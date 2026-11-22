# 3.11.1 复审整改文档（2026-11-22）

来源：`docs/REVIEW-3.11.0-2026-11-22.md` 第 6–7 节。目标：修复 2 个 P2 启动/迁移隐患与 3 个 P3 收尾项，并补上对应回归/基准证据。

## 1. 整改项

| ID | 来源 | 整改 | 验收标准 | 状态 |
|---|---|---|---|---|
| R-01 | P2-1 每次 open 全表扫描 `text_hash IS NULL` | 增加部分索引 `notes_text_hash_missing(id) WHERE text_hash IS NULL`；稳态探针走该索引 | `EXPLAIN` 不再全表 `SCAN notes`；1M 稳态 open 明显低于 145ms | 完成（1M open 46.5ms） |
| R-02 | P2-2 v17 回填一次性载入全部缺失行 | 回填改为 `ORDER BY id LIMIT 1000` 分批，每批独立事务 | 多批用例通过；1M 旧库迁移可完成、RSS 有界、NULL 归零 | 完成（1M 73.01s / +58.9MB） |
| R-03 | P3-1 死变量 `requestedScope` | `/node` 改为 `const { scope } = httpScope(...)` | 无未使用变量 | 完成 |
| R-04 | P3-2 `/health`、`/rules`、静态页未 loopback | 复核现有守卫与测试；报告行号对应修复后代码 | 非 loopback `/health` `/rules` `/` `/index.html` 均 403 | 已满足（测试 1/1） |
| R-05 | P3-3 基准版本写死 | `bench/release.mjs` 从 `package.json` 读取版本；输出 `openMs` 与 `BENCH_LOAD` | 3.11.1 输出版本为 3.11.1；文档含负载与区间 | 完成 |

## 2. R-01 / R-02 实现

`ensureNoteTextHash` 现为：

1. 加列 `notes.text_hash`；
2. 建 `(scope,text_hash)` 去重索引与 `notes_text_hash_missing` 部分索引；
3. 用 `SELECT ... WHERE text_hash IS NULL ORDER BY id LIMIT 1000` 循环读取；
4. 每批在独立事务里更新，直到无缺失。

稳态打开时，部分索引为空，查询计划为：

```
SCAN notes USING INDEX notes_text_hash_missing
```

这是对空部分索引的扫描，不再读取 notes 表 1M 行。1M 实测 `openStore()` 46.5ms。

## 3. 迁移与启动实测

| 行数 | notes | 迁移耗时 | RSS 增量 | null 哈希 | 稳态 open |
|---:|---:|---:|---:|---:|---:|
| 100k | 80,000 | 1.64s | 22.0MB | 0 | 10.6ms |
| 1M | 800,000 | 73.01s | 58.9MB | 0 | 46.5ms |

说明：迁移基准把 FTS/bigram/vector marker 保持为 17，只测 v17 哈希回填；生产旧库还会做自身的 FTS/派生索引回填，成本另计。完整原始值见 `docs/BENCH-3.11.0-2026-11-22.md` 第 4–5 节。

## 4. R-03 / R-04 / R-05

- R-03：`/omni-memory/node` 不再解构未使用的 `requested`。
- R-04：`hosts/http/server.mjs` 已在 `/health`、`/rules`、`/`、所有静态 GET 前检查 `isLoopback(req)`；`test/http-security.test.mjs` 覆盖 `127.0.0.2` 非 loopback 的 403。复审该项为误报，本轮未改代码，只复验。
- R-05：`bench/release.mjs` 版本来自 `package.json`；新增 `openMs` 与 `BENCH_LOAD`，发布文档补 3.11.x 区间与稳态打开。

## 5. 验证命令

```powershell
node --test test/migration.test.mjs
node --test --test-name-pattern="health, rules and static pages" test/http-security.test.mjs
node bench/migrate.mjs 100000
node bench/migrate.mjs 1000000
node bench/release.mjs 100000
node bench/release.mjs 1000000
npm test
npm run check
```

## 6. 状态记录

| 日期 | 项 | 结果 | 证据 |
|---|---|---|---|
| 2026-11-22 | R-01 / R-02 | 完成 | 部分索引 + 1000 行分批；migration 7/7；1M 迁移 73.01s / RSS +58.9MB；1M 稳态 open 46.5ms |
| 2026-11-22 | R-03 / R-05 | 完成 | 死变量移除；bench 版本动态读取；release 输出版本 3.11.1 |
| 2026-11-22 | R-04 | 已满足 | health/rules/static 非 loopback 403 测试 1/1 |
| 2026-11-22 | 全量门禁 | 完成 | `npm test` 376/376；`npm run check` 通过 |
| 2026-11-22 | 发布 | 完成 | commit `d1831e2` + 日志 `9a856a9` 已 push `origin/main` |
| 2026-11-22 | 真机复验 | 完成 | DSH 重启加载 3.11.1，21 路由；真实库 schema 17、`notes_text_hash_missing` 存在、`text_hash` 0 NULL、活跃 35 notes/8 facts/980 chunks；验收 note #45 |
