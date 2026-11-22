# 3.11.0 发布基准（2026-11-22）

来源：`docs/REMEDIATION-3.11.0-2026-11-22.md` M-10。目标是给出可复现的 3.11.0 实测数字，不沿用 3.10.1/3.10.4 的旧结果。

## 1. 方法与隔离

- 脚本：`node bench/release.mjs <rows>`，独立临时 `OMNI_HOME`，由 `test/helpers.mjs` 的 `boot()` 创建；**不打开** `C:\Users\64627\.dsh\memory\omni.db`。
- fixture：80% notes / 15% facts / 5% chunks，`ts` 从当前时间向前连续铺开；notes 写入真实 `notes_fts`，facts/chunks 直接 SQL 插入。
- 指标：`write` 为 `memory_write`（note）；`list` 为 `GET /omni-memory/list?limit=20&scope=all`；`overview` 为 `GET /omni-memory/overview?range=12w&scope=all`；`search` 为 `memory_search(query='alpha beta', limit=8, scope='all')`。
- 每个指标先预热 1 次，再取 5 次原始值的中位数；语义向量关闭（`OMNI_DISABLE_SEMANTIC=1`），避免 216MB 模型影响冷/热对比。
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

## 4. 查询计划

`notes.text_hash` 去重查询：

```
SEARCH notes USING INDEX notes_scope_text_hash (scope=? AND text_hash=?)
```

`/overview` 项目聚合：

```
SCAN notes USING COVERING INDEX notes_scope_state_ts
USE TEMP B-TREE FOR GROUP BY
```

## 5. 结论与边界

- `notes.text_hash` 把 100k 写入从 45.8ms 降到 4.4ms，1M 仍为 4.4ms；去重查询稳定命中 `(scope, text_hash)` 索引，原文仍参与比对。
- `/overview` 的 SQL 分桶把 100k 从 321ms 降到 187.2ms；1M 为 2026ms，属于全库统计接口，超出 300ms 交互预算，但不影响检索与写入。
- `/list` 在 1M 为 966.4ms，主要成本是跨项目列表的全量统计；检索路径仍是 2.8ms。
- 本基准是单机、单进程、无向量压力；1M + 向量/大 bigram 的检索延迟仍以 `bench/bench.mjs` 与 ADR-020 为准。
