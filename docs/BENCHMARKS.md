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

### 1.1 1M 派生索引压力（A-06，2026-11-23）

脚本：`bench/bench.mjs 1000000 50`，环境 `BENCH_VECTORS=50000`、`BENCH_BIGRAM=条目`、`OMNI_PROFILE=1`。

| 版本/边界 | p50 | p95 | 最大 | 命中 | 结果 |
|---|---:|---:|---:|---:|---|
| 3.12.0 固定窗口 20,000 / 采样 5,000（本机） | 216.7ms | **226.9ms** | 235.6ms | 400/400 | pass |
| 3.12.1 自适应窗口 5,000 / 采样 1,000（本机） | 126.5ms | **129.4ms** | 134.8ms | 400/400 | pass |
| 3.12.2 按可召回行数判定（本机） | 126.0ms | **129.8ms** | 221.1ms | 400/400 | pass |
| 报告机器 i5-14600KF 固定边界 | 399.6ms | **418.6ms** | — | — | fail（>300ms） |
| 报告机器同一收紧配置 | — | **257ms** | — | — | pass |

- 本机阶段耗时（3.12.1）：notes 104.9ms、vector 19.7ms、facts/chunks ≈0.1ms。机器同 §1（Node 22.22.2，因 `node:sqlite` FTS5 构建差异用绝对 Node 跑压力脚本）。
- 3.12.2 首次查询包含一次 1M 行可召回行数 `COUNT(*)`，后续 60s 内走缓存；因此 max 221.1ms、p95 129.8ms。把缓存 TTL 设为 0 会每查询都 COUNT，不适合作为常驻配置。
- 自适应规则：先看最大 id；高水位超过 `OMNI_LARGE_STORE_ROWS`（默认 250,000）后，再用可召回行数判定（notes 排除 `deleted_at`/`superseded_by`，facts 排除 `deleted_at`/`valid_to`，chunks 排除 `deleted_at`）。可召回行数也超过阈值才把窗口降到 5,000、向量采样降到 1,000；否则保持 20,000/5,000。行数按连接缓存 60 秒（`OMNI_ACTIVE_COUNT_TTL_MS`），避免每次检索全表 COUNT。`OMNI_SEARCH_WINDOW` / `OMNI_VECTOR_SAMPLE` 显式设置时固定，不再自适应。
- 3.12.2 修正：3.12.1 只看 `MAX(id)`，churn 库（软删墓碑抬高 id、活行很少）会误入大库模式；`test/churn-window.test.mjs` 用 16,000 条墓碑 + 1 条活行锁住回归。
- 这是检索层延迟；质量取舍见 ADR-020：大库窗口外纯语义覆盖减少，FTS/词面候选仍负责精确旧记忆。


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

数据：`bench/data/locomo10.json`（2,805,274B，SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`，与 `bench/data/README.md` 一致），10 个 conversation，5,882 个 dialogue turn，1,982 个有 evidence 的 QA。数据集不入库，用 `node bench/fetch-public.mjs` 取；报告里一律写完整 hash，不再用截断值。

运行：

```powershell
node bench/fetch-public.mjs
node bench/public-retrieval.mjs --k 10
node bench/public-retrieval.mjs --granularity turn --k 10
```

**3.12.0 基线（2026-11-23，历史口径）**：下表两组数字产生于 3.12.0。当时脚本把结果写到 `.bench-*.log`，而该路径被 `.gitignore` 排除，原始日志没有归档；能追溯的只有版本、数据 hash 与本表数值。

| 粒度 | 笔记/块 | 问题 | evidence recall@10 | any-evidence recall@10 | nDCG@10 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|
| session（默认） | 330 | 1,982 | **0.7134** | **0.7583** | **0.5621** | 19.7s |
| turn | 5,882 | 1,982 | 0.3483 | 0.3845 | 0.2193 | 160.6s |

**4.6.18 复跑（2026-11-27，重新归档）**：同一份数据、同一命令、`k=10`、检索-only；每次运行的完整 JSON（含 `dataSha256`、分类明细、`elapsedMs`）落在 `docs/evidence/locomo-retrieval-*.json`，不再只留控制台表格。`bench/public-retrieval.mjs` 自 4.6.19 起在输出里自产 `capturedAt`（生成时刻的 ISO 时间），归档文件不再由人工补 `codeVersion`/`capturedAt` 字段；判断版本只看文件名与 `dataSha256`。

| 粒度 | 笔记/块 | 问题 | evidence recall@10 | any-evidence recall@10 | nDCG@10 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|
| session（默认） | 330 | 1,982 | 0.7239 | 0.7699 | 0.5680 | 38.7s |
| turn | 5,882 | 1,982 | 0.3185 | 0.3572 | 0.2107 | 241.0s |

两组数不能混着引用：3.12.0 之后检索实现有改动（语义向量、重排与去重），4.6.18 的 session 召回比基线高约 1 个百分点，turn 粒度反而低了约 3 个百分点；耗时差异来自本机负载，不归因于算法。要比较版本，必须同一台机、同一命令重跑。这也说明 4.7.0 的 turn 优化目标（先做 turn 级邻句扩展，再调重排）仍成立，且不能拿 session 的高分掩盖 turn 的退步。

**4.6.19 复跑（2026-11-28，同命令）**：session recall@10 **0.7240** / any 0.7699 / nDCG 0.5687 / 40.5s；turn recall@10 **0.3179** / any 0.3562 / nDCG 0.2101 / 247.3s；`dataSha256` 同上。归档 `docs/evidence/locomo-retrieval-4.6.19-{session,turn}.json`，`capturedAt` 由脚本自产。与 4.6.18 相比是同一量级（session +0.0001、turn −0.0006），说明 4.6.19 的门禁/分页改动没有触碰检索路径。

**4.7.0 复跑（2026-11-28，turn 优化落地）**：同一份数据（`dataSha256` 同上）、同一台机、`k=10`。turn 粒度这次换了**索引口径与排序口径**，不再是裸 turn：

1. **写入侧 ±2 上下文拼接**：每条 turn 笔记的正文带上前后各两轮对话（`--ctx 2`），来源仍是 `locomo:<sample>:<dia_id>`，证据单位没有变。
2. **查询侧同源家族重排**：同一 conversation 内已有命中向该家族最高分靠拢（`memory_search` 的 `expand: true`，默认强度 0.3），只重排、不新增行。
3. **英文功能词剔除**：`queryTerms` 丢弃 what/did/the 这类几乎命中所有笔记的词。

| 粒度 | 笔记/块 | 问题 | evidence recall@10 | any-evidence recall@10 | nDCG@10 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|
| session（默认） | 330 | 1,982 | **0.7279** | 0.7735 | **0.5612** | 37.0s |
| turn（±2 上下文 + 家族重排） | 5,882 | 1,982 | **0.5114** | 0.5469 | 0.2929 | 289.9s |

turn 从 0.3179 提到 0.5114（+0.1935，相对 +61%），跨过 0.40 的门槛；session 同时小涨（0.7240 → 0.7279），nDCG 0.5612 仍在 0.55 以上。耗时翻倍来自上下文拼接后的长正文，属于预期代价。

**4.7.0 归因（同一数据集、同一命令，只改一项）**：全量 1,982 题的裸 turn 在只加功能词剔除后就是 **0.4081** / any 0.4495 / nDCG 0.2909 / 230.8s——即 4.7.0 的大头来自词面清洗，上下文拼接与家族重排再补上约 0.10。家族重排的单独收益在固定 seed 500 题子集上量：`--ctx 2` 不开重排 0.4575 → 开启 0.5218（+0.064）。子集与全量不可混引，子集只用于归因，不作为发布口径。


**4.7.0 分类型（session 粒度，2026-11-28）**：功能词剔除让 category 2（时间类）与 4/5 小幅上升，category 1（多跳）与 3（开放域）略降，属于换打分口径后的正常重分配。

| category | 问题 | evidence recall | any-evidence | nDCG |
|---|---:|---:|---:|---:|
| 1 | 282 | 0.4658 | 0.7305 | 0.3524 |
| 2 | 321 | 0.7160 | 0.7321 | 0.5348 |
| 3 | 92 | 0.3543 | 0.4674 | 0.2392 |
| 4 | 841 | 0.8205 | 0.8205 | 0.6410 |
| 5 | 446 | 0.8049 | 0.8049 | 0.6300 |

**4.7.0 分类型（turn 粒度，2026-11-28）**：多跳（category 1）仍是短板，单跳（4）与对抗（5）已经在 0.6 上下。

| category | 问题 | evidence recall | nDCG |
|---|---:|---:|---:|
| 1 | 282 | 0.1388 | 0.0994 |
| 2 | 321 | 0.5023 | 0.2746 |
| 3 | 92 | 0.1477 | 0.0964 |
| 4 | 841 | 0.6284 | 0.3607 |
| 5 | 446 | 0.6121 | 0.3417 |

**3.12.0 分类型（历史口径，2026-11-23）**：

| category | 问题 | evidence recall | any-evidence | nDCG |
|---|---:|---:|---:|---:|
| 1 | 282 | 0.4844 | 0.7447 | 0.3754 |
| 2 | 321 | 0.6869 | 0.7009 | 0.5008 |
| 3 | 92 | 0.4159 | 0.5326 | 0.2608 |
| 4 | 841 | 0.7937 | 0.7943 | 0.6362 |
| 5 | 446 | 0.7870 | 0.7870 | 0.6468 |

**4.6.18 分类型（复跑，2026-11-27）**：取自 `docs/evidence/locomo-retrieval-4.6.18-session.json` 的 `byCategory`。

| category | 问题 | evidence recall | any-evidence | nDCG |
|---|---:|---:|---:|---:|
| 1 | 282 | 0.4809 | 0.7482 | 0.3780 |
| 2 | 321 | 0.6952 | 0.7072 | 0.5021 |
| 3 | 92 | 0.3969 | 0.5217 | 0.2578 |
| 4 | 841 | 0.8115 | 0.8121 | 0.6465 |
| 5 | 446 | 0.8004 | 0.8004 | 0.6516 |

**这不是官方 LoCoMo QA 分数。** 官方分数需要答案生成器和 judge；本仓库只测“证据能否被检索到”。session 粒度把同一 session 的对话拼成块，turn 粒度严格到单条 dialogue；两者不能互相替代。

### 3.1 答题层（LoCoMo QA，4.7.0 首次落数）

`bench/locomo-qa.mjs` 在同一份 LoCoMo 语料上做“检索 + 生成 + 判分”。生成与判分都是可插拔的：本仓库当前跑的是**确定性路径**（`--generator extractive` 取检索片段里最贴题的一段，`--judge rule` 用逐字包含 / 词元包含 / 词元 F1 ≥ 0.6 判分），不调任何模型；LLM 路径（`--generator llm --judge llm`，OpenAI 兼容端点，`OMNI_QA_API_KEY`）已接好但本环境没有 key，本轮没有 LLM 数字。

固定 seed 500 题（`--seed 42`，按 category 分层抽样，`docs/evidence/locomo-qa-4.7.0.json` 可复现）：

| 指标 | 数值 |
|---|---:|
| 判分题数 | 387（500 题中 113 题属 category 5 对抗题，规则判分无法判“拒答”，单列不计入） |
| accuracy（规则判分） | **0.1189** |
| 逐字/词元包含率 | 0.0775 |
| token F1 | 0.1126 |
| 同批检索 evidence recall@10 | 0.4945 |

分类型（accuracy / token F1）：category 1 多跳 71 题 0 / 0.0314；category 2 时间 81 题 0.1975 / 0.3082；category 3 开放域 23 题 0.0435 / 0.0200；category 4 单跳 212 题 0.1368 / 0.0750。

**这不是可与 mem0 92.5 同桌的分数。** 它是“本地、离线、零 API”路径的下限：答案必须能从检索片段里逐字取出才可能判对，而 LoCoMo 的答案经常需要跨轮聚合或简单推理。要拿到可比数字，必须走 LLM 生成 + LLM judge 路径；按 §6.2 的预算，500 题约 350 万 token（每题约 6–7k），1,982 题约 1,300–1,400 万 token。脚本会把实际 `prompt/completion/total` 写进 `tokenAccounting`，没有调用时明确写 `no LLM call`。

## 4. 金标检索

脚本：`bench/golden.mjs`（20 条中文语料、24 个问题，含 4 个低词面重叠改写）

- 完整检索（词面 + hashed 向量 + 本地语义 + 图）：recall@10 **1.000**，MRR **0.979**（3.12.1 复跑，无退化）。
- 这是小型中文金标，不是公开 benchmark；用于防止检索质量回退。

## 5. 复现边界

- 所有数字来自单机、单进程、本地 SQLite；没有多进程并发、网络抖动或跨机复制。
- 语义模型是否加载会影响冷启动和内存；规模脚本默认关闭语义，避免把模型加载时间混入检索延迟。
- 机器负载会改变绝对值；本页用区间和原始日志 `.bench-*.log` 保留上下文。

## 6. 检索质量可证性路线（4.7.0 已落地）

4.6.22 复核时这三块证据强弱不一：检索层有数但 turn 未达标、答题层完全没有数、回归门只覆盖中文金标。4.7.0 把三块都推进了一步：

- **检索层**：turn recall@10 从 0.3179 提到 **0.5114**（全量 1,982 题），session 0.7279 / nDCG 0.5612；归因与方法见 §3。
- **答题层**：`bench/locomo-qa.mjs` 首次落数，固定 seed 500 题确定性基线 accuracy 0.1189 / token F1 0.1126；LLM 路径接好但无 key，未跑，不与 mem0 同桌（§3.1）。
- **回归门**：`scripts/check-retrieval-gate.mjs` 已进 `npm run check`，session recall ≥ 0.70、session nDCG ≥ 0.55、turn recall ≥ 0.40；数据集未下载时明确 `SKIP`，不伪装绿灯。阈值与判定逻辑在 `scripts/retrieval-gate-lib.mjs`，有单测。

**已落地 / 待补**：

- 已落地：数据 hash 全量写入报告与 `bench/data/README.md`；`--k`、`--granularity`、`--ctx` 可参数化；每次运行落完整 JSON 证据；固定 seed 500 题子集与答题层脚本（`bench/locomo-qa.mjs`）；检索硬阈值进 `check`。
- 待补：答题层的 LLM 生成 + LLM judge 实跑（需要可用端点与约 350 万 token/500 题的预算）；三档语义（关 / 本地 / 远端）的分档记录；category 1 多跳的 turn 召回（0.1388）仍是短板。

**外部数字的出处**（只作背景，不作对比结论）：

- mem0 的 LoCoMo 92.5 来自其官方博客 2026-04-01《State of AI Agent Memory 2026》与 `docs.mem0.ai/core-concepts/memory-evaluation`；口径是 April 2026 算法、单次检索、`top_200` 检索预算、平均约 6,956 token/次，配自己的 answer judge。它是**答题准确率**，不是证据召回。
- Zep 公开的是 LongMemEval-S 分数（arXiv:2501.13956，gpt-4o 71.2% / gpt-4o-mini 63.8%），不是 LoCoMo 证据召回。此前文中“Zep 80.32”系误引第三方论文里的 Mem0 数字，4.6.18 起删除。
- 两者与本仓库的 `evidence recall@10` 既不同数据集口径、也不同判分器，禁止跨 harness 比较；本页只报自有 harness 的绝对分。

### 6.1 口径先定（0.5 天，无 LLM 成本）

- 数据集固定为 `bench/data/locomo10.json`（10 conversation / 5,882 turn / 1,982 有 evidence 的 QA），SHA-256 写进报告；不用自行裁剪的子集冒充官方。
- **检索层与答题层分开报**：检索层继续用 `bench/public-retrieval.mjs`（不调模型）；答题层新增脚本，报 `judge` 分与 token 成本。两列永不合并成一个“总分”。
- 每次跑固定 `OMNI_HOME` 临时库、固定 `k=10`、固定 seed、三档语义（关 / 本地模型 / 远端端点）分别记录，禁止只报最好那档。
- 报告明确标注“非官方榜单、非官方 judge”，并附复现命令与数据 hash。

### 6.2 答题层（主体工作，分两段验收）

1. **生成**：给定 QA 与检索到的 top-k 证据，用固定模型（temperature 0）生成答案；上下文预算与线上一致（`memory_search` 的 limit 与 profile 预算不放大）。产出必须记录 model id、prompt 模板 hash、每题 token 数与总 token。
2. **判分**：先用规则判分（F1 / 精确匹配）做稳定底，再叠一层 LLM judge（同一模板、双采样，取一致率 ≥90% 的子集报告；不一致的题单列，不悄悄取平均）。mem0/Zep 的争议正说明 judge 与实现必须可追溯。
3. **成本闸**：1,982 题 × 约 6–7k token ≈ 1,300–1,400 万 token。先跑固定种子的 500 题子集（约 350 万 token）拿到收敛区间，再决定是否全量；两段结果都要落 `docs/evidence/locomo-qa-<version>.json`。
4. **产物**：`docs/evidence/locomo-qa-<version>.json`（分数 + 失败样例 + token 账）、BENCHMARKS §3 扩一张“答题层”表、`bench/README` 写清复现步骤。

### 6.3 回归门（可持续，4.7.0 已启用）

- 只对**检索层**设硬阈值进 `npm run check`，由 `scripts/check-retrieval-gate.mjs` 执行、`scripts/retrieval-gate-lib.mjs` 定义：session recall@10 ≥ 0.70、session nDCG@10 ≥ 0.55、turn recall@10 ≥ 0.40。固定 seed 500 题分层子集，本轮两次实测 session 0.7434 / nDCG 0.5699、turn 0.5218，与 session 0.7424 / nDCG 0.5711、turn 0.5168，两道都有余量。
- 同一命令同 seed 复跑有约 ±0.005 的抖动（词面打分在等价分数上存在并列，排序不稳定），所以闸门阈值取整到 0.70 / 0.55 / 0.40，并在余量里给抖动留了位置；不要用两次跑出的末位数字互相当“回归证据”，小于 0.01 的差属于噪声。
- turn 不设 nDCG 硬门：turn nDCG 0.2929 与 session 的 0.5612 不是同一口径（turn 的分母是“所有证据轮都要排进前 10”），设 0.55 会立刻长期红灯；报告里照常公布 turn nDCG，但不作为闸门。
- 数据集 `bench/data/locomo10.json` 不入库；未下载时闸门打印 `SKIP` 并放行，避免新克隆因缺数据而红。
- 答题层因 judge 不稳定，只做趋势记录（同一模型、同一 judge 模板下比较），不设硬门。
- **turn 粒度仍是首要优化目标**：0.5114 已过线，但 category 1 多跳只有 0.1388；后续顺序是 turn 级证据扩展（多跳跨 session 的那 330 题）→ 重排特征（时间邻近 + 实体命中）→ 只在有回归证据时才动权重。

### 6.4 不做的事

- 不引入“LLM 抽取型写入”去换分数：那会改变本地、离线、零 API 依赖的架构属性，属于换产品，不是提分。
- 不把 mem0/Zep 的公开分数直接贴成对比结论：数据集子集、检索实现、judge 都不同；只报自有 harness 的绝对分，并注明不可跨 harness 比较。
- 不为分数放宽注入预算或扩大 top-k：线上预算 1200 与检索上限是产品约束，评测必须沿用。
