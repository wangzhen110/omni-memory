# 3.11.x 发布基准（2026-11-22）

来源：`docs/REMEDIATION-3.11.0-2026-11-22.md` M-10。目标是给出可复现的 3.11.0 实测数字，不沿用 3.10.1/3.10.4 的旧结果。

## 1. 方法与隔离

- 脚本：`node bench/release.mjs <rows>`，独立临时 `OMNI_HOME`，由 `test/helpers.mjs` 的 `boot()` 创建；**不打开** `C:\Users\64627\.dsh\memory\omni.db`。
- fixture：80% notes / 15% facts / 5% chunks，`ts` 从当前时间向前连续铺开；notes 写入真实 `notes_fts`，facts/chunks 直接 SQL 插入。
- 指标：`write` 为 `memory_write`（note）；`list` 为 `GET /omni-memory/list?limit=20&scope=all`；`overview` 为 `GET /omni-memory/overview?range=12w&scope=all`；`search` 为 `memory_search(query='alpha beta', limit=8, scope='all')`。
- 每个指标先预热 1 次，再取 5 次原始值的中位数；语义向量关闭（`OMNI_DISABLE_SEMANTIC=1`），避免 216MB 模型影响冷/热对比。
- `openMs` 由种子写入后重新导入一个全新模块并计时 `openStore()` 得到；`BENCH_LOAD` 记录复跑时的后台负载。
- 机器：Intel Core i5-14600KF，31.8GB RAM，Windows 10.0.26300 x64；Node v22.23.2；SQLite 3.51.3。

## 2. 100k 结果

| 指标 | 3.10.4 复审 | 3.11.0 实测 | 变化 |
|---|---:|---:|---|
| write | 45.8ms | **4.4ms** | -90% |
| `/list` | 99ms | **96.4ms** | 基本持平 |
| `/overview` | 321ms | **187.2ms** | -42% |
| search | 12ms | **2.8ms** | -77% |

原始值：
- write：4.1 / 4.3 / 4.4 / 4.4 / 4.6 ms
- list：96.1 / 96.3 / 96.4 / 96.4 / 97.3 ms
- overview：185.8 / 186.5 / 187.2 / 188.8 / 189.0 ms
- search：2.5 / 2.7 / 2.8 / 3.1 / 3.3 ms
- 种子耗时：1174.8ms（80,000 notes + 15,000 facts + 5,000 chunks）

## 3. 1M 结果

| 指标 | 3.11.0 实测 |
|---|---:|
| write | **4.4ms** |
| `/list` | **966.4ms** |
| `/overview` | **2026ms** |
| search | **2.8ms** |

原始值：
- write：4.2 / 4.2 / 4.4 / 4.7 / 5.6 ms
- list：961.5 / 966.2 / 966.4 / 967.9 / 969.1 ms
- overview：1960.7 / 2005.9 / 2026.0 / 2248.7 / 2299.6 ms
- search：2.6 / 2.7 / 2.8 / 3.1 / 3.6 ms
- 种子耗时：20220ms（800,000 notes + 150,000 facts + 50,000 chunks）

## 4. 3.11.1 复审整改复跑

负载：`DSH running; interactive session idle`（`BENCH_LOAD` 记录）。两次运行都取 5 次中位数。

| 指标 | 100k | 1M |
|---|---:|---:|
| `openMs` | **10.6ms** | **46.5ms** |
| write | 4.6ms | 4.6ms |
| `/list` | 99.1ms | 976.2ms |
| `/overview` | 193.0ms | 2135.7ms |
| search | 3.2ms | 2.9ms |

原始值：
- 100k open 10.6ms；write 4.3 / 4.4 / 4.6 / 4.7 / 5.2；list 99.0 / 99.1 / 99.1 / 99.1 / 105.7；overview 190.4 / 191.4 / 193.0 / 198.7 / 199.3；search 2.9 / 2.9 / 3.2 / 3.4 / 3.5。
- 1M open 46.5ms；write 4.4 / 4.5 / 4.6 / 4.6 / 5.5；list 963.9 / 969.4 / 976.2 / 1007.0 / 1013.8；overview 1989.3 / 2097.8 / 2135.7 / 2243.0 / 2379.9；search 2.6 / 2.7 / 2.9 / 5.1 / 5.5。

同一台机器的绝对数字受后台负载影响，3.11.0 发布值与复审复跑值可视为区间：

| 指标 | 100k 区间 | 1M 区间 |
|---|---:|---:|
| write | 4.4–7.9ms | 4.4–9.0ms |
| `/list` | 96.4–102.4ms | 966.4–2276ms |
| `/overview` | 187.2–205.8ms | 2026–4456ms |
| search | 2.8–6.2ms | 2.8–6.4ms |

## 5. v16→v17 存量迁移

脚本：`node bench/migrate.mjs <rows>`。构造当前 schema 后移除 `text_hash` 并把 `schema_version` 写回 16；FTS/bigram/vector 标记保持 17，只测哈希回填。

| 行数 | notes | 迁移耗时 | RSS 增量 | null 哈希 | 结果 |
|---:|---:|---:|---:|---:|---|
| 100k | 80,000 | **1.64s** | **22.0MB** | 0 | schema 17，样本 hash 正确 |
| 1M | 800,000 | **73.01s** | **58.9MB** | 0 | schema 17，样本 hash 正确 |

回填按 1000 行/批提交，因此 1M 迁移的内存增量被限制在约 59MB，而不是把 80 万条正文一次性读入。旧库首次升级是 O(n) 的一次性成本；稳态打开走 `notes_text_hash_missing` 部分索引，1M 仅 46.5ms。

## 6. 查询计划

`notes.text_hash` 去重查询：

```
SEARCH notes USING INDEX notes_scope_text_hash (scope=? AND text_hash=?)
```

`/overview` 项目聚合：

```
SCAN notes USING COVERING INDEX notes_scope_state_ts
USE TEMP B-TREE FOR GROUP BY
```

## 7. 结论与边界

- `notes.text_hash` 把 100k 写入从 45.8ms 降到 4.4–4.6ms，1M 仍为 4.4–4.6ms；去重查询稳定命中 `(scope, text_hash)` 索引，原文仍参与比对。
- `/overview` 的 SQL 分桶把 100k 从 321ms 降到 187.2–193.0ms；1M 为 2026–2136ms，属于全库统计接口，超出 300ms 交互预算，但不影响检索与写入。
- `/list` 在 1M 为 966.4–976.2ms（高负载复跑 2276ms），主要成本是跨项目列表的全量统计；检索路径仍是 2.8–3.2ms。
- 稳态打开：100k 10.6ms、1M 46.5ms；v17 空缺失探针由部分索引服务，不再全表扫描。旧库首次升级是 O(n)：1M notes 回填 73.01s，RSS 增量 58.9MB。
- 本基准是单机、单进程、无向量压力；绝对中位数随后台负载变化，发布文档给区间而非单点。1M + 向量/大 bigram 的检索延迟仍以 `bench/bench.mjs` 与 ADR-020 为准。
