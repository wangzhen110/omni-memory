# ADR-020：1M 行有界检索

- 状态：已采纳
- 日期：2026-11-17
- 关联：NFR-01、v2.4.0、路线第 2 项

## 背景

v2.4.0 之前，1M 行检索 p95 ≈ 911ms（评审环境）/ 1452ms（本机复现），超 300ms 预算。评审只给了"超标"结论，没有说明时间花在哪里。

本次用 `OMNI_PROFILE=1` 分段计时 + SQL 微基准定位到两个独立根因：

1. **`ORDER BY bm25(...)` 必须物化整个匹配列表**。同一查询去掉排序后只需 0.1–0.6ms；加上 bm25 后 595ms。`LIMIT` 无法让 FTS5 提前停止。
2. **过滤在 JOIN/采样之后**。`LIMIT` 先取样本、再按 scope 过滤时，如果过滤把样本全部排除，SQLite 会继续扫描直到凑够行数（或扫完整个表）。向量路径同样中招：项目层查询会读全表向量。

两者叠加，导致"查询词越常见、scope 越窄，越慢"。

## 决策

### 1. 词面检索：有界候选 + JS 打分

- 每个层（note/fact/chunk）只生成有界候选：
  - **最近窗口**：`id > maxId - OMNI_SEARCH_WINDOW`（默认 20,000）的 `LIKE` 子串扫描，最多 `limit × 4` 行；
  - **FTS 采样**：`SELECT rowid FROM fts WHERE MATCH ? LIMIT 120`，再按 id 批量取行；**不做 bm25 排序**；
  - **bigram 索引**：CJK 两字词走 `(gram, layer, owner_id)` 索引反向扫描，`LIMIT 200`。
- 候选的 scope / 活跃状态过滤放到 JS（`scopeAllows` / `rowsByIds` 的 SQL 过滤），保证 `LIMIT` 永远在过滤之前生效。
- 打分仍由原有公式完成（matchRatio + importance/confidence + recency），最终 RRF 融合不变。
- 去掉全表 `LIKE` 兜底：精确词由 FTS 采样覆盖，最近词由窗口覆盖。

### 2. 向量检索：有界采样 + 词面候选补充

- 先取 `owner_id` 采样（最近 `OMNI_VECTOR_SAMPLE`，默认 5,000），再按 id 分批（500/批）取向量与行。
- 额外加入词面候选的 id（每层上限 400），保证"精确命中但不在最近窗口"的行仍能拿到语义分。
- scope 过滤在 JS 完成，避免"过滤排除样本 → 全表扫描"。
- 这仍是线性采样，不是 ANN；10 万向量以上建议后续接 HNSW/sqlite-vec（见"未来"）。

### 3. 可观测

- `OMNI_PROFILE=1`：`/omni-memory/status` 返回 `lastSearch` 分段耗时（notes/facts/chunks/vector/graph）。
- `bench/bench.mjs` 支持派生索引压力：
  - `BENCH_VECTORS=50000`：为最近 5 万行建立哈希向量；
  - `BENCH_BIGRAM=条目`：为所有行建立同一个高频 bigram。

## 结果（本机复核，Node 22.23.2，Windows；标准 bench 使用 global scope 并断言真实命中）

| 场景 | 改前 p95 | 改后 p95 |
|---|---|---|
| 10,000 行 | ~4ms | **2.4ms** |
| 100,000 行 | 92.5ms | **2.4ms** |
| 1,000,000 行 | 1,451.8ms | **6.0ms** |
| 1,000,000 行 + 5 万向量 + 100 万 bigram | 未测（会读全表） | **116.8ms** |

> 旧版 `bench/bench.mjs` 把数据写进 `scope='bench'`，标准命令命中 0 条，延迟数字不代表真实检索。3.1.3 改为 `scope='global'`，并新增 `hitTotal` / `minHitsPerQuery`；`pass` 要求 p95 < 300ms 且 `hitTotal > 0`。上表为修正后重新测得。

质量：黄金集 lexical MRR **0.776**（与改前一致），lexical+vector **0.927**，recall 1.0，24/24。

## 代价与残余风险

1. **近年优先**：窗口外的旧行只能通过精确词（FTS 采样）召回，纯语义的旧记忆可能不出现。这是有意的取舍：无界扫描在 1M 行下不可接受；后续 ANN 可放宽。
2. **FTS 采样是"任意 120 条"**：极端情况下同一词条在样本中占比异常，排序质量会低于 bm25 全排序。黄金集未观察到退化，但这是一条需要用长期数据监控的假设。
3. **向量仍是 O(sample)**：sample=5000 时每查询读取约 10MB 向量；1M 全量向量库也维持这个上限。
4. **project scope 的语义**：窗口只覆盖最近 2 万行，若项目记忆量很大且集中在窗口外，词面召回会退化；FTS 采样 + JS scope 过滤保底。
5. 性能数字是单机合成数据，不代表低配机器或冷缓存。

## 3.12.1 修订：按库规模自适应（A-06）

固定 20,000 / 5,000 在 1M 行 + 5 万向量 + 100 万 bigram 的低配机器上 p95 达到 418.6ms，超出预算。3.12.1 不再全库使用同一组上限：

- 最大 id > `OMNI_LARGE_STORE_ROWS`（默认 250,000）时，最近窗口降到 5,000，向量采样降到 1,000；小库保持 20,000 / 5,000。
- 判定只读 `MAX(id)`，不做全表 `COUNT(*)`；显式 `OMNI_SEARCH_WINDOW` / `OMNI_VECTOR_SAMPLE` 仍固定覆盖。
- 本机 1M 压力 p95 226.9ms → **129.4ms**（400/400 命中）；报告机器同一收紧配置 **257ms**。
- 质量取舍不变：大库窗口外纯语义覆盖减少，精确旧记忆仍由 FTS/词面候选召回。黄金集 small-store full MRR **0.979**，无退化。

## 未来

- ANN（sqlite-vec / HNSW）替换向量采样；
- 为 `bigrams` 增加按 gram 的覆盖统计，动态选择索引或窗口；
- ✅ 已落地（2026-11-21）：`test/perf-budget.test.mjs` 默认跑 10k/100k 的 p95 < 300ms 且要求真实命中；1M 仍仅手工记录，避免 CI 时长失控。
