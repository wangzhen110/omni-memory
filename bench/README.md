# bench/ 复现说明

本目录所有数字都来自本机、单进程、本地 SQLite，没有网络调用（除数据集下载）。报告口径以 `docs/BENCHMARKS.md` 为准，本文件只写怎么跑。

## 0. 先取数据

```
node bench/fetch-public.mjs
```

数据集落到 `bench/data/locomo10.json`，2,805,274B，SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。该文件不入库（`bench/data/.gitignore`），缺数据时检索闸门会打印 `SKIP`。

## 1. 检索层（public-retrieval.mjs）

session 粒度（整段对话拼块，默认）：

```
node bench/public-retrieval.mjs --granularity session --k 10
```

turn 粒度（一条 dialogue 一条笔记），发布口径是「±2 上下文拼接 + 同源家族重排」：

```
node bench/public-retrieval.mjs --granularity turn --ctx 2 --expand --k 10
```

- `--ctx N`（turn 粒度，0–2）：写入时把前后各 N 轮拼进该条笔记正文，`source` 仍是 `locomo:<sample>:<dia_id>`，证据单位不变。
- `--expand`：查询侧把同一 `source` 家族的已命中行向家族最高分抬升（强度默认 0.3，`OMNI_SEARCH_EXPAND_BOOST` 可调），只重排、不新增行。
- `--limit N`：固定 seed 分层子集（`test/locomo-lib` 里实现），同一 N 每次抽同一批题；全量不加 `--limit`。
- `--semantic`：额外加载本地语义模型并重建向量；短对话语料上会拖慢且不涨分，默认关。
- `--dump out.json`：逐题落「问题 / 证据 / 实际前 10 命中」，用于归因。
- 标准输出是一份 JSON（含 `dataSha256`、`byCategory`、`elapsedMs`、`capturedAt`），直接重定向即可归档。

已知对照（全量 1,982 题，本机）：session 0.7279 / 0.7735 / nDCG 0.5616；turn（`--ctx 2 --expand`）0.5124 / 0.5484 / nDCG 0.2930；裸 turn 只加功能词剔除 0.4081。跨版本比较必须同机同命令，子集数字不能当发布口径。

## 2. 检索回归闸门

```
node scripts/check-retrieval-gate.mjs
```

已接入 `npm run check`。它跑固定 seed 500 题分层子集，阈值写在 `scripts/retrieval-gate-lib.mjs`：session recall@10 ≥ 0.70、session nDCG@10 ≥ 0.55、turn recall@10 ≥ 0.40，任一低于阈值即 exit 1。turn 不设 nDCG 闸（口径不同）。

临时跳过（例如机器太慢）：`OMNI_RETRIEVAL_GATE_OFF=1 npm run check`，输出里会写 `SKIP`；不要用它代替真实回归。

## 3. 答题层（locomo-qa.mjs）

确定性路径（默认，无网络）：

```
node bench/locomo-qa.mjs --limit 500 --seed 42 --out docs/evidence/locomo-qa-4.7.0.json
```

- 生成：`--generator extractive`，从 top-k 命中里按题型取片段（when → 日期、how many → 数字，其余取最贴句），不调模型。
- 判分：`--judge rule`，逐字包含 → 词元包含 → 词元 F1 ≥ 0.6。
- 固定 seed 500 题：`--seed 42`、按 category 分层，`subset.sampling` 写进 JSON。
- 输出含 `metrics`、`byCategory`、`excluded`（category 5 对抗题不参与 accuracy，因为规则判分无法判“拒答”）、`tokenAccounting`、`failures`（前 30 个失败样例）。

LLM 路径（需要 OpenAI 兼容端点）：

```
set OMNI_QA_API_KEY=...
set OMNI_QA_BASE_URL=https://api.openai.com/v1      # 可选
set OMNI_QA_MODEL=gpt-4o-mini                        # 可选
set OMNI_QA_JUDGE_MODEL=gpt-4o-mini                  # 可选
node bench/locomo-qa.mjs --limit 500 --seed 42 --generator llm --judge llm --out docs/evidence/locomo-qa-4.7.0.json
```

没有 key 时脚本直接报错，不会静默退回规则判分。token 账写在 `tokenAccounting`（`prompt/completion/total/calls`）。

**不许把确定性基线和 mem0 的 92.5 比**：前者是“答案能否从检索片段逐字取出”的下限，后者是生成 + judge 的答题准确率，数据集子集、检索预算、判分器都不同。

## 4. 成本

- 检索层全量 turn：约 4.8 分钟（±2 上下文后正文变长）；session 约 37 秒；500 题子集约 70–85 秒。
- 答题层 LLM：500 题约 350 万 token，1,982 题约 1,300–1,400 万 token（每题约 6–7k，含 judge）。

## 5. 其它脚本

`bench.mjs`（本机吞吐）、`golden.mjs`（中文金标 24 题）、`scale.mjs`（规模/延迟）、`quality.mjs`（120 条确定性质量用例）、`release.mjs`（发版前汇总）、`migrate.mjs`（旧库迁移）。
