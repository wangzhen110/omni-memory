# 基准与质量实测

本页只记录**可复现的实测数字**，不把不同机器、不同数据形态的数字混成一条曲线。所有脚本都使用独立临时 `OMNI_HOME`，不打开生产库。

## 1. 规模与字符体积

脚本：`bench/scale.mjs [rows] [chars] [queries]`

| 场景 | 行数 | 每行字符 | 总字符 | seed | 库体积 | RSS 增量 | 检索 p50 | p95 | 最大 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100k 短笔记 | 100,000 | 100 | 10,000,000 | 2,299.5ms | 92.5MiB | 15.9MiB | 6.1ms | 6.9ms | 11.5ms |
| 10k 长笔记 | 10,000 | 1,000 | 10,000,000 | 936.6ms | 91.2MiB | 7.4MiB | 26.4ms | 27.4ms | 31.8ms |

- 100 条查询，每条固定返回 8 个命中，总命中 800。
- 机器：Intel Core i7-14700KF / 63.8GB / Windows 10.0.26200 x64；Node v22.23.2；SQLite 3.51.3。
- 单进程、无语义向量压力；长笔记的检索更慢，是因为每条记录的正文更长、FTS 命中后要读取更多文本。

历史发布基准（不同机器、不同 fixture）见 [BENCH-3.11.0-2026-11-22.md](BENCH-3.11.0-2026-11-22.md)：100k/1M 行、80% notes + 15% facts + 5% chunks，1M 行 `/overview` 约 2.0–2.1s，检索中位数 2.8ms。两组数字不能直接比较。

## 2. 确定性质量集

脚本：`bench/quality.mjs [count]`；回归测试：`test/memory-quality.test.mjs`

| 类别 | 用例 | 通过 |
|---|---:|---:|
| knowledge-update（旧事实关闭、新事实生效、timeline 保留） | 30 | 30 |
| conflict（contradicts 双方 contested、搜索结果带 flag） | 30 | 30 |
| scope-isolation（项目 A/B 不泄漏） | 30 | 30 |
| forget-restore（墓碑后消失、恢复后可搜） | 30 | 30 |
| **合计** | **120** | **120** |

- 总耗时 271ms；单查询 p50 1.9ms；失败 0。
- 用例是确定性的，不依赖模型端点或随机采样。

## 3. LoCoMo 公开检索

数据：`bench/data/locomo10.json`（2,805,274B，SHA-256 `79fa87e9…98ff4`），10 个 conversation，5,882 个 dialogue turn，1,982 个有 evidence 的 QA。

运行：

```powershell
node bench/fetch-public.mjs
node bench/public-retrieval.mjs --k 10
node bench/public-retrieval.mjs --granularity turn --k 10
```

| 粒度 | 笔记/块 | 问题 | evidence recall@10 | any-evidence recall@10 | nDCG@10 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|
| session（默认） | 330 | 1,982 | **0.7134** | **0.7583** | **0.5621** | 19.7s |
| turn | 5,882 | 1,982 | 0.3483 | 0.3845 | 0.2193 | 160.6s |

分类型（session 粒度）：

| category | 问题 | evidence recall | any-evidence | nDCG |
|---|---:|---:|---:|---:|
| 1 | 282 | 0.4844 | 0.7447 | 0.3754 |
| 2 | 321 | 0.6869 | 0.7009 | 0.5008 |
| 3 | 92 | 0.4159 | 0.5326 | 0.2608 |
| 4 | 841 | 0.7937 | 0.7943 | 0.6362 |
| 5 | 446 | 0.7870 | 0.7870 | 0.6468 |

**这不是官方 LoCoMo QA 分数。** 官方分数需要答案生成器和 judge；本仓库只测“证据能否被检索到”。session 粒度把同一 session 的对话拼成块，turn 粒度严格到单条 dialogue；两者不能互相替代。

## 4. 金标检索

脚本：`bench/golden.mjs`（20 条中文语料、24 个问题，含 4 个低词面重叠改写）

- 完整检索（词面 + hashed 向量 + 本地语义 + 图）：recall@10 **1.000**，MRR **0.979**。
- 这是小型中文金标，不是公开 benchmark；用于防止检索质量回退。

## 5. 复现边界

- 所有数字来自单机、单进程、本地 SQLite；没有多进程并发、网络抖动或跨机复制。
- 语义模型是否加载会影响冷启动和内存；规模脚本默认关闭语义，避免把模型加载时间混入检索延迟。
- 机器负载会改变绝对值；本页用区间和原始日志 `.bench-*.log` 保留上下文。
